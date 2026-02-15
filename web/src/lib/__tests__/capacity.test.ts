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

describe("generateInviteCode", () => {
  it("returns a 12-character string", () => {
    const code = generateInviteCode();
    expect(code).toHaveLength(12);
    expect(code).toMatch(/^[A-Z0-9]+$/);
  });
});
