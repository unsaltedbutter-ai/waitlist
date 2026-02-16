import { describe, it, expect, beforeEach, vi } from "vitest";
import { createHash, randomBytes } from "crypto";
import { mockQueryResult } from "@/__test-utils__/fixtures";

vi.mock("@/lib/db", () => ({
  query: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({
  hashPassword: vi.fn().mockResolvedValue("new-bcrypt-hash"),
}));
vi.mock("@/lib/email", () => ({
  sendEmail: vi.fn().mockResolvedValue(undefined),
}));

import { query } from "@/lib/db";
import { hashPassword } from "@/lib/auth";
import { sendEmail } from "@/lib/email";
import { POST } from "../route";

let testIpCounter = 0;
function uniqueIp(): string {
  testIpCounter++;
  return `10.6.${Math.floor(testIpCounter / 256)}.${testIpCounter % 256}`;
}

function makeToken(): { hex: string; hash: Buffer } {
  const bytes = randomBytes(32);
  return {
    hex: bytes.toString("hex"),
    hash: createHash("sha256").update(bytes).digest(),
  };
}

function makeRequest(body: object, ip?: string): Request {
  return new Request("http://localhost/api/auth/reset-password", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": ip || uniqueIp(),
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.mocked(query).mockReset();
  vi.mocked(hashPassword).mockReset();
  vi.mocked(hashPassword).mockResolvedValue("new-bcrypt-hash");
  vi.mocked(sendEmail).mockReset();
  vi.mocked(sendEmail).mockResolvedValue(undefined);
});

describe("POST /api/auth/reset-password", () => {
  it("valid token and password: resets password", async () => {
    const { hex, hash } = makeToken();
    const expiresAt = new Date(Date.now() + 3600_000);

    vi.mocked(query)
      .mockResolvedValueOnce(
        mockQueryResult([
          { id: "tok-1", user_id: "user-1", token_hash: hash, expires_at: expiresAt },
        ])
      ) // token lookup
      .mockResolvedValueOnce(mockQueryResult([])) // UPDATE password
      .mockResolvedValueOnce(mockQueryResult([])) // DELETE tokens
      .mockResolvedValueOnce(mockQueryResult([{ email: "user@example.com" }])); // user email lookup

    const res = await POST(
      makeRequest({ token: hex, password: "newpassword123" }) as any
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.message).toMatch(/password reset/i);
    expect(hashPassword).toHaveBeenCalledWith("newpassword123");
  });

  it("invalid token: returns 400", async () => {
    const fakeHex = randomBytes(32).toString("hex");
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([])); // no match

    const res = await POST(
      makeRequest({ token: fakeHex, password: "newpassword123" }) as any
    );
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/invalid or expired/i);
  });

  it("expired token: returns 400 and deletes token", async () => {
    const { hex, hash } = makeToken();
    const expiresAt = new Date(Date.now() - 1000); // already expired

    vi.mocked(query)
      .mockResolvedValueOnce(
        mockQueryResult([
          { id: "tok-1", user_id: "user-1", token_hash: hash, expires_at: expiresAt },
        ])
      )
      .mockResolvedValueOnce(mockQueryResult([])); // DELETE expired token

    const res = await POST(
      makeRequest({ token: hex, password: "newpassword123" }) as any
    );
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/invalid or expired/i);

    // Verify the expired token was deleted
    const deleteCalls = vi.mocked(query).mock.calls.filter(
      (c) => typeof c[0] === "string" && c[0].includes("DELETE")
    );
    expect(deleteCalls.length).toBe(1);
  });

  it("password too short: returns 400", async () => {
    const hex = randomBytes(32).toString("hex");
    const res = await POST(makeRequest({ token: hex, password: "short" }) as any);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/at least 8/i);
  });

  it("password too long: returns 400", async () => {
    const hex = randomBytes(32).toString("hex");
    const res = await POST(
      makeRequest({ token: hex, password: "a".repeat(129) }) as any
    );
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/128/);
  });

  it("malformed token (not 64 hex chars): returns 400", async () => {
    const res = await POST(
      makeRequest({ token: "not-hex", password: "newpassword123" }) as any
    );
    expect(res.status).toBe(400);
  });

  it("missing fields: returns 400", async () => {
    const res = await POST(makeRequest({ token: "abc" }) as any);
    expect(res.status).toBe(400);
  });

  it("used token (already deleted): returns 400", async () => {
    const fakeHex = randomBytes(32).toString("hex");
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([])); // token not found

    const res = await POST(
      makeRequest({ token: fakeHex, password: "newpassword123" }) as any
    );
    expect(res.status).toBe(400);
    expect(hashPassword).not.toHaveBeenCalled();
  });

  it("IP rate limit: returns 429 after 5 requests", async () => {
    const ip = uniqueIp();
    vi.mocked(query).mockResolvedValue(mockQueryResult([]));

    for (let i = 0; i < 5; i++) {
      const hex = randomBytes(32).toString("hex");
      const res = await POST(
        makeRequest({ token: hex, password: "newpassword123" }, ip) as any
      );
      expect(res.status).toBe(400); // invalid tokens, but not rate-limited
    }

    const hex = randomBytes(32).toString("hex");
    const res = await POST(
      makeRequest({ token: hex, password: "newpassword123" }, ip) as any
    );
    expect(res.status).toBe(429);
  });

  it("sends confirmation email after reset", async () => {
    const { hex, hash } = makeToken();
    const expiresAt = new Date(Date.now() + 3600_000);

    vi.mocked(query)
      .mockResolvedValueOnce(
        mockQueryResult([
          { id: "tok-1", user_id: "user-1", token_hash: hash, expires_at: expiresAt },
        ])
      )
      .mockResolvedValueOnce(mockQueryResult([]))
      .mockResolvedValueOnce(mockQueryResult([]))
      .mockResolvedValueOnce(mockQueryResult([{ email: "user@example.com" }]));

    await POST(makeRequest({ token: hex, password: "newpassword123" }) as any);

    expect(sendEmail).toHaveBeenCalledOnce();
    expect(vi.mocked(sendEmail).mock.calls[0][0]).toMatchObject({
      to: "user@example.com",
      subject: expect.stringMatching(/password.*changed/i),
    });
  });
});
