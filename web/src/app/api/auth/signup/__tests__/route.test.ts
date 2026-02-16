import { describe, it, expect, beforeEach, vi } from "vitest";
import { TEST_JWT_SECRET, mockQueryResult } from "@/__test-utils__/fixtures";

vi.mock("@/lib/db", () => ({
  query: vi.fn(),
  transaction: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({
  createToken: vi.fn().mockResolvedValue("mock-jwt"),
  hashPassword: vi.fn().mockResolvedValue("hashed-pw"),
}));
vi.mock("@/lib/capacity", () => ({
  isAtCapacity: vi.fn(),
}));

import { query, transaction } from "@/lib/db";
import { isAtCapacity } from "@/lib/capacity";
import { POST } from "../route";

// Each test gets a unique IP so the in-memory rate limiter doesn't bleed state
let testIpCounter = 0;
function uniqueIp(): string {
  testIpCounter++;
  return `10.1.${Math.floor(testIpCounter / 256)}.${testIpCounter % 256}`;
}

function makeRequest(body: object): Request {
  return new Request("http://localhost/api/auth/signup", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": uniqueIp(),
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.mocked(query).mockReset();
  vi.mocked(transaction).mockReset();
  vi.mocked(isAtCapacity).mockReset();
  vi.mocked(isAtCapacity).mockResolvedValue(false);
});

describe("POST /api/auth/signup", () => {
  it("valid signup → 201 + token", async () => {
    // SELECT waitlist: code found
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ id: "wl-1" }])
    );
    // Check existing user: none
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));
    // transaction: execute callback with a mock txQuery
    vi.mocked(transaction).mockImplementationOnce(async (cb: any) => {
      const txQuery = vi.fn()
        .mockResolvedValueOnce(mockQueryResult([{ id: "new-user-123" }])) // INSERT user
        .mockResolvedValueOnce(mockQueryResult([])); // UPDATE waitlist redeemed_at
      return cb(txQuery);
    });

    const res = await POST(
      makeRequest({
        email: "test@example.com",
        password: "strongpassword",
        inviteCode: "VALIDCODE123",
      }) as any
    );
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.token).toBe("mock-jwt");
    expect(data.userId).toBe("new-user-123");
  });

  it("invalid email → 400", async () => {
    const res = await POST(
      makeRequest({
        email: "not-an-email",
        password: "strongpassword",
        inviteCode: "VALIDCODE123",
      }) as any
    );
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/email/i);
  });

  it("short password → 400", async () => {
    const res = await POST(
      makeRequest({
        email: "test@example.com",
        password: "short",
        inviteCode: "VALIDCODE123",
      }) as any
    );
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/8 characters/);
  });

  it("duplicate email → 409", async () => {
    // SELECT waitlist: code found
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ id: "wl-1" }])
    );
    // Existing user found
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ id: "existing-user" }])
    );

    const res = await POST(
      makeRequest({
        email: "taken@example.com",
        password: "strongpassword",
        inviteCode: "VALIDCODE123",
      }) as any
    );
    expect(res.status).toBe(409);
  });

  it("missing fields → 400", async () => {
    const res = await POST(
      makeRequest({ email: "test@example.com" }) as any
    );
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/required/i);
  });

  it("missing email → 400", async () => {
    const res = await POST(
      makeRequest({ password: "strongpassword" }) as any
    );
    expect(res.status).toBe(400);
  });

  // --- Invite code gating tests ---

  it("no invite code → 403", async () => {
    const res = await POST(
      makeRequest({
        email: "test@example.com",
        password: "strongpassword",
      }) as any
    );
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toMatch(/invite code required/i);
  });

  it("invalid invite code → 403", async () => {
    // SELECT waitlist: code not found
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const res = await POST(
      makeRequest({
        email: "test@example.com",
        password: "strongpassword",
        inviteCode: "BADCODE",
      }) as any
    );
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toMatch(/invalid or expired/i);
  });

  it("at capacity → 403", async () => {
    // SELECT waitlist: code found
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ id: "wl-1" }])
    );
    vi.mocked(isAtCapacity).mockResolvedValueOnce(true);

    const res = await POST(
      makeRequest({
        email: "test@example.com",
        password: "strongpassword",
        inviteCode: "VALIDCODE123",
      }) as any
    );
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toMatch(/at capacity/i);
  });
});
