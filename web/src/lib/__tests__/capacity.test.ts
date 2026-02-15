import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockQueryResult } from "@/__test-utils__/fixtures";

vi.mock("@/lib/db", () => ({
  query: vi.fn(),
  transaction: vi.fn(),
}));

import { query } from "@/lib/db";
import {
  getActiveUserCount,
  isAtCapacity,
  getUserCap,
  getReferralTier,
  generateReferralCodes,
  validateInviteCode,
  generateInviteCode,
} from "@/lib/capacity";

beforeEach(() => {
  vi.mocked(query).mockReset();
});

describe("getActiveUserCount", () => {
  it("returns count from query", async () => {
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ count: "42" }])
    );

    const count = await getActiveUserCount();
    expect(count).toBe(42);
    expect(query).toHaveBeenCalledWith(
      "SELECT COUNT(*) AS count FROM users WHERE status IN ('active', 'expiring')"
    );
  });
});

describe("isAtCapacity", () => {
  it("returns true when count >= 5000", async () => {
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ count: "5000" }])
    );

    expect(await isAtCapacity()).toBe(true);
  });

  it("returns false when under cap", async () => {
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ count: "4999" }])
    );

    expect(await isAtCapacity()).toBe(false);
  });
});

describe("getUserCap", () => {
  it("returns the USER_CAP number", () => {
    expect(getUserCap()).toBe(5000);
  });
});

describe("getReferralTier", () => {
  it("0-499 → 3 codes, no expiry", () => {
    expect(getReferralTier(0)).toEqual({ codesPerUser: 3, expiresInDays: null });
    expect(getReferralTier(499)).toEqual({ codesPerUser: 3, expiresInDays: null });
  });

  it("500-999 → 2 codes, no expiry", () => {
    expect(getReferralTier(500)).toEqual({ codesPerUser: 2, expiresInDays: null });
    expect(getReferralTier(999)).toEqual({ codesPerUser: 2, expiresInDays: null });
  });

  it("1000-1999 → 1 code, no expiry", () => {
    expect(getReferralTier(1000)).toEqual({ codesPerUser: 1, expiresInDays: null });
    expect(getReferralTier(1999)).toEqual({ codesPerUser: 1, expiresInDays: null });
  });

  it("2000-3999 → 1 code, 30-day expiry", () => {
    expect(getReferralTier(2000)).toEqual({ codesPerUser: 1, expiresInDays: 30 });
    expect(getReferralTier(3999)).toEqual({ codesPerUser: 1, expiresInDays: 30 });
  });

  it("4000+ → 0 codes", () => {
    expect(getReferralTier(4000)).toEqual({ codesPerUser: 0, expiresInDays: null });
    expect(getReferralTier(4899)).toEqual({ codesPerUser: 0, expiresInDays: null });
  });
});

describe("generateReferralCodes", () => {
  it("activeCount=100 → inserts 3 codes", async () => {
    vi.mocked(query).mockResolvedValue(mockQueryResult([]));

    await generateReferralCodes("user-1", 100);
    expect(query).toHaveBeenCalledTimes(3);
  });

  it("activeCount=500 → inserts 2 codes", async () => {
    vi.mocked(query).mockResolvedValue(mockQueryResult([]));

    await generateReferralCodes("user-1", 500);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("activeCount=4000 → inserts 0 codes", async () => {
    await generateReferralCodes("user-1", 4000);
    expect(query).not.toHaveBeenCalled();
  });
});

describe("validateInviteCode", () => {
  it("valid code → { valid: true, codeRow }", async () => {
    const codeRow = {
      id: "code-1",
      owner_id: "user-1",
      status: "active",
      expires_at: null,
    };
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([codeRow]));

    const result = await validateInviteCode("ABC123");
    expect(result).toEqual({ valid: true, codeRow });
  });

  it("missing code → { valid: false }", async () => {
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const result = await validateInviteCode("DOESNOTEXIST");
    expect(result).toEqual({ valid: false });
  });

  it("used code → { valid: false }", async () => {
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{
        id: "code-1",
        owner_id: "user-1",
        status: "used",
        expires_at: null,
      }])
    );

    const result = await validateInviteCode("USEDCODE");
    expect(result).toEqual({ valid: false });
  });

  it("expired code → { valid: false, expired: true } and updates status", async () => {
    const pastDate = new Date(Date.now() - 86400000).toISOString();
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{
        id: "code-1",
        owner_id: "user-1",
        status: "active",
        expires_at: pastDate,
      }])
    );
    // The UPDATE query
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const result = await validateInviteCode("EXPIREDCODE");
    expect(result).toEqual({ valid: false, expired: true });
    expect(query).toHaveBeenCalledTimes(2);
    expect(query).toHaveBeenLastCalledWith(
      "UPDATE referral_codes SET status = 'expired' WHERE id = $1",
      ["code-1"]
    );
  });
});

describe("generateInviteCode", () => {
  it("returns a 12-character string", () => {
    const code = generateInviteCode();
    expect(code).toHaveLength(12);
    expect(code).toMatch(/^[A-Z0-9]+$/);
  });
});
