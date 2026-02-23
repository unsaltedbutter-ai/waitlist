import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockQueryResult } from "@/__test-utils__/fixtures";
import crypto from "crypto";

vi.mock("@/lib/db", () => ({
  query: vi.fn(),
}));
vi.mock("@/lib/auth-login", () => ({
  loginExistingUser: vi.fn(),
  createUserWithInvite: vi.fn(),
  lookupInviteByNpub: vi.fn(),
}));

import { query } from "@/lib/db";
import {
  loginExistingUser,
  createUserWithInvite,
  lookupInviteByNpub,
} from "@/lib/auth-login";
import { POST } from "../route";

const RATE_LIMIT_MAX = 5;

// Each test gets a unique IP so the in-memory rate limiter doesn't bleed state
let testIpCounter = 0;
function uniqueIp(): string {
  testIpCounter++;
  return `10.0.${Math.floor(testIpCounter / 256)}.${testIpCounter % 256}`;
}

function makeRequest(body: object, ip?: string): Request {
  return new Request("http://localhost/api/auth/nostr-otp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": ip ?? uniqueIp(),
    },
    body: JSON.stringify(body),
  });
}

/** Set up standard OTP query mocks: cleanup expired + atomic delete returning npub_hex. */
function mockOtpLookup(npubHex: string) {
  // Cleanup expired
  vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));
  // Atomic delete returning npub_hex
  vi.mocked(query).mockResolvedValueOnce(
    mockQueryResult([{ npub_hex: npubHex }])
  );
}

/** Set up OTP query mocks for a failed lookup (expired/wrong code). */
function mockOtpLookupFailed() {
  // Cleanup expired
  vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));
  // No matching row
  vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));
}

beforeEach(() => {
  vi.mocked(query).mockReset();
  vi.mocked(loginExistingUser).mockReset();
  vi.mocked(createUserWithInvite).mockReset();
  vi.mocked(lookupInviteByNpub).mockReset();
});

describe("POST /api/auth/nostr-otp", () => {
  it("valid OTP, existing user: 200 with token", async () => {
    mockOtpLookup("aabb");
    vi.mocked(loginExistingUser).mockResolvedValueOnce({
      status: 200,
      body: { token: "mock-jwt-token", userId: "user-123" },
    });

    const res = await POST(makeRequest({ code: "123456-789012" }) as any);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.token).toBe("mock-jwt-token");
    expect(data.userId).toBe("user-123");
    expect(data.isNew).toBeUndefined();
  });

  it("valid OTP, new user + auto-lookup invite by npub: 201", async () => {
    mockOtpLookup("ccdd");
    vi.mocked(loginExistingUser).mockResolvedValueOnce(null);
    vi.mocked(lookupInviteByNpub).mockResolvedValueOnce("waitlist-1");
    vi.mocked(createUserWithInvite).mockResolvedValueOnce({
      status: 201,
      body: { token: "mock-jwt-token", userId: "new-user-456" },
    });

    const res = await POST(
      makeRequest({ code: "111111222222" }) as any
    );
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.token).toBe("mock-jwt-token");
    expect(data.userId).toBe("new-user-456");
    expect(data.isNew).toBe(true);
  });

  it("valid OTP, new user + no invite found: 403", async () => {
    mockOtpLookup("eeff");
    vi.mocked(loginExistingUser).mockResolvedValueOnce(null);
    vi.mocked(lookupInviteByNpub).mockResolvedValueOnce(null);

    const res = await POST(makeRequest({ code: "111111-222222" }) as any);
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toMatch(/no invite/i);
  });

  it("expired/wrong OTP: 401", async () => {
    mockOtpLookupFailed();

    const res = await POST(makeRequest({ code: "999999-999999" }) as any);
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.error).toMatch(/invalid or expired/i);
  });

  it("malformed code (not 12 digits): 400", async () => {
    const res = await POST(makeRequest({ code: "12345" }) as any);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/12 digits/i);
  });

  it("missing code: 400", async () => {
    const res = await POST(makeRequest({}) as any);
    expect(res.status).toBe(400);
  });

  it("at capacity: 403", async () => {
    mockOtpLookup("aabb");
    vi.mocked(loginExistingUser).mockResolvedValueOnce(null);
    vi.mocked(lookupInviteByNpub).mockResolvedValueOnce("waitlist-1");
    vi.mocked(createUserWithInvite).mockResolvedValueOnce({
      status: 403,
      body: { error: "At capacity" },
    });

    const res = await POST(
      makeRequest({ code: "111111-222222" }) as any
    );
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toMatch(/capacity/i);
  });

  it("rate limit exceeded: 429", async () => {
    const ip = "10.99.99.99";

    // Set up query mocks for the first 5 requests (all will fail with wrong code)
    for (let i = 0; i < RATE_LIMIT_MAX + 1; i++) {
      mockOtpLookupFailed();
    }

    // Exhaust the rate limit
    for (let i = 0; i < RATE_LIMIT_MAX; i++) {
      await POST(makeRequest({ code: "000000-000000" }, ip) as any);
    }

    // 6th request should be rate limited
    const res = await POST(
      makeRequest({ code: "000000-000000" }, ip) as any
    );
    expect(res.status).toBe(429);
  });

  it("accepts code without hyphen", async () => {
    mockOtpLookup("aabb");
    vi.mocked(loginExistingUser).mockResolvedValueOnce({
      status: 200,
      body: { token: "mock-jwt-token", userId: "user-123" },
    });

    const ip = uniqueIp();
    const res = await POST(
      makeRequest({ code: "123456789012" }, ip) as any
    );
    expect(res.status).toBe(200);

    // Verify the SHA-256 hash of the raw code was passed to the DB
    const expectedHash = crypto.createHash("sha256").update("123456789012").digest("hex");
    const deleteCall = vi.mocked(query).mock.calls[1];
    expect(deleteCall[1]).toEqual([expectedHash]);
  });

  it("existing user, onboarding incomplete: returns needsOnboarding", async () => {
    mockOtpLookup("aabb");
    vi.mocked(loginExistingUser).mockResolvedValueOnce({
      status: 200,
      body: { token: "mock-jwt-token", userId: "user-123", needsOnboarding: true },
    });

    const res = await POST(makeRequest({ code: "123456-789012" }) as any);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.token).toBe("mock-jwt-token");
    expect(data.needsOnboarding).toBe(true);
  });

  it("existing user, onboarding complete: no needsOnboarding flag", async () => {
    mockOtpLookup("aabb");
    vi.mocked(loginExistingUser).mockResolvedValueOnce({
      status: 200,
      body: { token: "mock-jwt-token", userId: "user-123" },
    });

    const res = await POST(makeRequest({ code: "123456-789012" }) as any);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.token).toBe("mock-jwt-token");
    expect(data.needsOnboarding).toBeUndefined();
  });

  it("new user signup: no needsOnboarding flag (isNew is sufficient)", async () => {
    mockOtpLookup("ccdd");
    vi.mocked(loginExistingUser).mockResolvedValueOnce(null);
    vi.mocked(lookupInviteByNpub).mockResolvedValueOnce("waitlist-1");
    vi.mocked(createUserWithInvite).mockResolvedValueOnce({
      status: 201,
      body: { token: "mock-jwt-token", userId: "new-user-456" },
    });

    const res = await POST(makeRequest({ code: "111111222222" }) as any);
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.isNew).toBe(true);
    expect(data.needsOnboarding).toBeUndefined();
  });

  it("invalid JSON: 400", async () => {
    const req = new Request("http://localhost/api/auth/nostr-otp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": uniqueIp(),
      },
      body: "not json",
    });
    const res = await POST(req as any);
    expect(res.status).toBe(400);
  });
});
