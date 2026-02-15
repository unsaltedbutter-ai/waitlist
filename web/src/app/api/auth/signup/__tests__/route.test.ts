import { describe, it, expect, beforeEach, vi } from "vitest";
import { TEST_JWT_SECRET, mockQueryResult } from "@/__test-utils__/fixtures";

vi.mock("@/lib/db", () => ({
  query: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({
  createToken: vi.fn().mockResolvedValue("mock-jwt"),
  hashPassword: vi.fn().mockResolvedValue("hashed-pw"),
}));
vi.mock("@/lib/capacity", () => ({
  validateInviteCode: vi.fn(),
  consumeInviteCode: vi.fn(),
  isAtCapacity: vi.fn(),
  getActiveUserCount: vi.fn(),
  generateReferralCodes: vi.fn(),
}));

import { query } from "@/lib/db";
import {
  validateInviteCode,
  consumeInviteCode,
  isAtCapacity,
  getActiveUserCount,
  generateReferralCodes,
} from "@/lib/capacity";
import { POST } from "../route";

function makeRequest(body: object): Request {
  return new Request("http://localhost/api/auth/signup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.mocked(query).mockReset();
  vi.mocked(validateInviteCode).mockReset();
  vi.mocked(consumeInviteCode).mockReset();
  vi.mocked(isAtCapacity).mockReset();
  vi.mocked(getActiveUserCount).mockReset();
  vi.mocked(generateReferralCodes).mockReset();

  // Default: invite code passes all gates
  vi.mocked(validateInviteCode).mockResolvedValue({
    valid: true,
    codeRow: {
      id: "code-123",
      owner_id: "owner-1",
      status: "active",
      expires_at: null,
    },
  });
  vi.mocked(isAtCapacity).mockResolvedValue(false);
  vi.mocked(consumeInviteCode).mockResolvedValue(undefined);
  vi.mocked(getActiveUserCount).mockResolvedValue(100);
  vi.mocked(generateReferralCodes).mockResolvedValue(undefined);
});

describe("POST /api/auth/signup", () => {
  it("valid signup → 201 + token", async () => {
    // Check existing: none
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));
    // Insert returning id
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ id: "new-user-123" }])
    );

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
    vi.mocked(validateInviteCode).mockResolvedValueOnce({ valid: false });

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

  it("expired invite code → 403", async () => {
    vi.mocked(validateInviteCode).mockResolvedValueOnce({
      valid: false,
      expired: true,
    });

    const res = await POST(
      makeRequest({
        email: "test@example.com",
        password: "strongpassword",
        inviteCode: "EXPIREDCODE",
      }) as any
    );
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toMatch(/invalid or expired/i);
  });

  it("already-used invite code → 403", async () => {
    vi.mocked(validateInviteCode).mockResolvedValueOnce({ valid: false });

    const res = await POST(
      makeRequest({
        email: "test@example.com",
        password: "strongpassword",
        inviteCode: "USEDCODE",
      }) as any
    );
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toMatch(/invalid or expired/i);
  });

  it("at capacity → 403", async () => {
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

  it("valid code → 201, consumes code and generates referral codes", async () => {
    // Check existing: none
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));
    // Insert returning id
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ id: "new-user-456" }])
    );

    const res = await POST(
      makeRequest({
        email: "new@example.com",
        password: "strongpassword",
        inviteCode: "VALIDCODE123",
      }) as any
    );
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.userId).toBe("new-user-456");

    expect(consumeInviteCode).toHaveBeenCalledWith("code-123", "new-user-456");
    expect(getActiveUserCount).toHaveBeenCalled();
    expect(generateReferralCodes).toHaveBeenCalledWith("new-user-456", 100);
  });
});
