import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockQueryResult } from "@/__test-utils__/fixtures";

vi.mock("@/lib/db", () => ({
  query: vi.fn(),
}));
vi.mock("@/lib/email", () => ({
  sendEmail: vi.fn().mockResolvedValue(undefined),
}));

import { query } from "@/lib/db";
import { sendEmail } from "@/lib/email";
import { POST } from "../route";

let testIpCounter = 0;
function uniqueIp(): string {
  testIpCounter++;
  return `10.5.${Math.floor(testIpCounter / 256)}.${testIpCounter % 256}`;
}

function makeRequest(body: object, ip?: string): Request {
  return new Request("http://localhost/api/auth/forgot-password", {
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
  vi.mocked(sendEmail).mockReset();
  vi.mocked(sendEmail).mockResolvedValue(undefined);
});

describe("POST /api/auth/forgot-password", () => {
  it("valid email: returns generic message and sends email", async () => {
    vi.mocked(query)
      .mockResolvedValueOnce(mockQueryResult([{ id: "user-1" }])) // user lookup
      .mockResolvedValueOnce(mockQueryResult([])) // delete existing tokens
      .mockResolvedValueOnce(mockQueryResult([])); // insert new token

    const res = await POST(makeRequest({ email: "user@example.com" }) as any);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.message).toMatch(/reset link has been sent/i);
    expect(sendEmail).toHaveBeenCalledOnce();
  });

  it("nonexistent email: returns same generic message, no email sent", async () => {
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([])); // user not found

    const res = await POST(makeRequest({ email: "nobody@example.com" }) as any);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.message).toMatch(/reset link has been sent/i);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("missing email: returns 400", async () => {
    const res = await POST(makeRequest({}) as any);
    expect(res.status).toBe(400);
  });

  it("IP rate limit: returns 429 after 3 requests", async () => {
    const ip = uniqueIp();
    vi.mocked(query).mockResolvedValue(mockQueryResult([]));

    for (let i = 0; i < 3; i++) {
      const res = await POST(makeRequest({ email: "a@b.com" }, ip) as any);
      expect(res.status).toBe(200);
    }

    const res = await POST(makeRequest({ email: "a@b.com" }, ip) as any);
    expect(res.status).toBe(429);
  });

  it("email rate limit: second request within 5 min returns 200 without DB lookup", async () => {
    // First request: valid user
    vi.mocked(query)
      .mockResolvedValueOnce(mockQueryResult([{ id: "user-1" }]))
      .mockResolvedValueOnce(mockQueryResult([]))
      .mockResolvedValueOnce(mockQueryResult([]));

    const res1 = await POST(makeRequest({ email: "ratelimited@example.com" }) as any);
    expect(res1.status).toBe(200);
    expect(sendEmail).toHaveBeenCalledOnce();

    // Second request: same email, different IP
    vi.mocked(query).mockReset();
    vi.mocked(sendEmail).mockReset();

    const res2 = await POST(makeRequest({ email: "ratelimited@example.com" }) as any);
    expect(res2.status).toBe(200);
    // Generic message returned but no DB query for user lookup
    const data = await res2.json();
    expect(data.message).toMatch(/reset link has been sent/i);
    expect(query).not.toHaveBeenCalled();
  });

  it("deletes existing tokens before creating new one", async () => {
    vi.mocked(query)
      .mockResolvedValueOnce(mockQueryResult([{ id: "user-1" }]))
      .mockResolvedValueOnce(mockQueryResult([]))
      .mockResolvedValueOnce(mockQueryResult([]));

    await POST(makeRequest({ email: "tokens@example.com" }) as any);

    const calls = vi.mocked(query).mock.calls;
    // Second call should be the DELETE
    expect(calls[1][0]).toMatch(/DELETE FROM password_reset_tokens/i);
    // Third call should be the INSERT
    expect(calls[2][0]).toMatch(/INSERT INTO password_reset_tokens/i);
  });
});
