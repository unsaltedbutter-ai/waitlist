import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockQueryResult } from "@/__test-utils__/fixtures";

vi.mock("@/lib/db", () => ({
  query: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({
  createToken: vi.fn().mockResolvedValue("mock-jwt-token"),
  needsOnboarding: vi.fn().mockResolvedValue(false),
}));
vi.mock("@/lib/capacity", () => ({
  isAtCapacity: vi.fn().mockResolvedValue(false),
}));

import { query } from "@/lib/db";
import { needsOnboarding } from "@/lib/auth";
import { isAtCapacity } from "@/lib/capacity";
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

beforeEach(() => {
  vi.mocked(query).mockReset();
  vi.mocked(isAtCapacity).mockResolvedValue(false);
  vi.mocked(needsOnboarding).mockResolvedValue(false);
});

describe("POST /api/auth/nostr-otp", () => {
  it("valid OTP, existing user: 200 with token", async () => {
    // Cleanup expired
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));
    // Atomic delete returning npub_hex
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ npub_hex: "aabb" }])
    );
    // User exists
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ id: "user-123" }])
    );
    // Update updated_at
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const res = await POST(makeRequest({ code: "123456-789012" }) as any);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.token).toBe("mock-jwt-token");
    expect(data.userId).toBe("user-123");
    expect(data.isNew).toBeUndefined();
  });

  it("valid OTP, new user + auto-lookup invite by npub: 201", async () => {
    // Cleanup expired
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));
    // Atomic delete returning npub_hex
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ npub_hex: "ccdd" }])
    );
    // No existing user
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));
    // Auto-lookup: waitlist entry found by npub
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ id: "waitlist-1" }])
    );
    // Insert new user
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ id: "new-user-456" }])
    );

    const res = await POST(
      makeRequest({ code: "111111222222" }) as any
    );
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.token).toBe("mock-jwt-token");
    expect(data.userId).toBe("new-user-456");
    expect(data.isNew).toBe(true);
  });

  it("valid OTP, new user + explicit invite code fallback: 201", async () => {
    // Cleanup expired
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));
    // Atomic delete returning npub_hex
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ npub_hex: "ccdd" }])
    );
    // No existing user
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));
    // Auto-lookup: no waitlist entry by npub
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));
    // Explicit invite code valid
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ id: "waitlist-2" }])
    );
    // Insert new user
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ id: "new-user-789" }])
    );

    const res = await POST(
      makeRequest({ code: "111111222222", inviteCode: "ABCDEF" }) as any
    );
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.userId).toBe("new-user-789");
    expect(data.isNew).toBe(true);
  });

  it("valid OTP, new user + no invite anywhere: 403", async () => {
    // Cleanup expired
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));
    // Atomic delete returning npub_hex
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ npub_hex: "eeff" }])
    );
    // No existing user
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));
    // Auto-lookup: no waitlist entry by npub
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const res = await POST(makeRequest({ code: "111111-222222" }) as any);
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toMatch(/no invite/i);
  });

  it("valid OTP, new user + bad explicit invite: 403", async () => {
    // Cleanup expired
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));
    // Atomic delete returning npub_hex
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ npub_hex: "eeff" }])
    );
    // No existing user
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));
    // Auto-lookup: no waitlist entry by npub
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));
    // Explicit invite code not found
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const res = await POST(
      makeRequest({ code: "111111-222222", inviteCode: "BADCODE" }) as any
    );
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toMatch(/invalid.*invite/i);
  });

  it("expired/wrong OTP: 401", async () => {
    // Cleanup expired
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));
    // No matching row (expired or wrong code)
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

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
    vi.mocked(isAtCapacity).mockResolvedValue(true);

    // Cleanup expired
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));
    // Atomic delete returning npub_hex
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ npub_hex: "aabb" }])
    );
    // No existing user
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));
    // Auto-lookup: waitlist entry found by npub
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ id: "waitlist-1" }])
    );

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
      vi.mocked(query).mockResolvedValueOnce(mockQueryResult([])); // cleanup
      vi.mocked(query).mockResolvedValueOnce(mockQueryResult([])); // no match
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
    // Cleanup expired
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));
    // Atomic delete returning npub_hex
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ npub_hex: "aabb" }])
    );
    // User exists
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ id: "user-123" }])
    );
    // Update
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const ip = uniqueIp();
    const res = await POST(
      makeRequest({ code: "123456789012" }, ip) as any
    );
    expect(res.status).toBe(200);

    // Verify the raw code (no hyphen) was passed to the DB
    const deleteCall = vi.mocked(query).mock.calls[1];
    expect(deleteCall[1]).toEqual(["123456789012"]);
  });

  it("existing user, onboarding incomplete: returns needsOnboarding", async () => {
    vi.mocked(needsOnboarding).mockResolvedValue(true);

    // Cleanup expired
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));
    // Atomic delete returning npub_hex
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ npub_hex: "aabb" }])
    );
    // User exists
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ id: "user-123" }])
    );
    // Update updated_at
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const res = await POST(makeRequest({ code: "123456-789012" }) as any);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.token).toBe("mock-jwt-token");
    expect(data.needsOnboarding).toBe(true);
  });

  it("existing user, onboarding complete: no needsOnboarding flag", async () => {
    vi.mocked(needsOnboarding).mockResolvedValue(false);

    // Cleanup expired
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));
    // Atomic delete returning npub_hex
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ npub_hex: "aabb" }])
    );
    // User exists
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ id: "user-123" }])
    );
    // Update updated_at
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const res = await POST(makeRequest({ code: "123456-789012" }) as any);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.token).toBe("mock-jwt-token");
    expect(data.needsOnboarding).toBeUndefined();
  });

  it("new user signup: no needsOnboarding flag (isNew is sufficient)", async () => {
    // Cleanup expired
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));
    // Atomic delete returning npub_hex
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ npub_hex: "ccdd" }])
    );
    // No existing user
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));
    // Auto-lookup: waitlist entry found by npub
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ id: "waitlist-1" }])
    );
    // Insert new user
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ id: "new-user-456" }])
    );

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
