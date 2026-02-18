import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockQueryResult } from "@/__test-utils__/fixtures";

vi.mock("@/lib/db", () => ({
  query: vi.fn(),
}));

import { query } from "@/lib/db";
import { GET } from "../route";

beforeEach(() => {
  vi.mocked(query).mockReset();
});

describe("GET /api/platform-config", () => {
  it("returns platform fee from DB", async () => {
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ value: "4400" }])
    );

    const res = await GET();
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.platform_fee_sats).toBe(4400);
  });

  it("returns default 4400 when no config row", async () => {
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const res = await GET();
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.platform_fee_sats).toBe(4400);
  });
});
