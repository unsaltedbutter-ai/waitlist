import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockQueryResult } from "@/__test-utils__/fixtures";

vi.mock("@/lib/db", () => ({
  query: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({
  createToken: vi.fn().mockResolvedValue("mock-jwt"),
  verifyPassword: vi.fn(),
}));

import { query } from "@/lib/db";
import { verifyPassword } from "@/lib/auth";
import { POST } from "../route";

function makeRequest(body: object): Request {
  return new Request("http://localhost/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.mocked(query).mockReset();
  vi.mocked(verifyPassword).mockReset();
});

describe("POST /api/auth/login", () => {
  it("valid login → token", async () => {
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ id: "user-1", password_hash: "hashed" }])
    );
    vi.mocked(verifyPassword).mockResolvedValueOnce(true);

    const res = await POST(
      makeRequest({ email: "user@example.com", password: "correctpassword" }) as any
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.token).toBe("mock-jwt");
    expect(data.userId).toBe("user-1");
  });

  it("user not found → 401", async () => {
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const res = await POST(
      makeRequest({ email: "nobody@example.com", password: "anything" }) as any
    );
    expect(res.status).toBe(401);
  });

  it("wrong password → 401", async () => {
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ id: "user-1", password_hash: "hashed" }])
    );
    vi.mocked(verifyPassword).mockResolvedValueOnce(false);

    const res = await POST(
      makeRequest({ email: "user@example.com", password: "wrongpassword" }) as any
    );
    expect(res.status).toBe(401);
  });

  it("Nostr-only account (no password_hash) → 400", async () => {
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ id: "user-1", password_hash: null }])
    );

    const res = await POST(
      makeRequest({ email: "nostr@example.com", password: "anypass" }) as any
    );
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/[Nn]ostr/);
  });

  it("missing fields → 400", async () => {
    const res = await POST(makeRequest({ email: "user@example.com" }) as any);
    expect(res.status).toBe(400);
  });
});
