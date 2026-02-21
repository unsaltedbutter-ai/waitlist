import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockQueryResult } from "@/__test-utils__/fixtures";

vi.mock("@/lib/db", () => ({
  query: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({
  authenticateRequest: vi.fn().mockResolvedValue("operator-user-id"),
}));
vi.mock("@/lib/operator-auth", () => ({
  withOperator: vi.fn((handler: Function) => {
    return async (req: Request, segmentData: any) => {
      const params = segmentData?.params ? await segmentData.params : undefined;
      return handler(req, { userId: "operator-user-id", params });
    };
  }),
}));

import { query } from "@/lib/db";
import { GET } from "../route";

const HEX_NPUB = "a".repeat(64);
const BECH32_NPUB =
  "npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqpfcg56";

function makeRequest(npub?: string): Request {
  const url = npub
    ? `http://localhost/api/operator/jobs/by-npub?npub=${encodeURIComponent(npub)}`
    : "http://localhost/api/operator/jobs/by-npub";
  return new Request(url, { method: "GET" });
}

beforeEach(() => {
  vi.mocked(query).mockReset();
});

describe("GET /api/operator/jobs/by-npub", () => {
  it("returns user and jobs for valid hex npub", async () => {
    // User lookup
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ id: "u1", nostr_npub: HEX_NPUB, debt_sats: 0 }])
    );
    // Jobs lookup
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([
        {
          id: "j1",
          service_id: "netflix",
          action: "cancel",
          trigger: "outreach",
          status: "outreach_sent",
          status_updated_at: "2026-02-18T00:00:00Z",
          billing_date: "2026-03-01",
          access_end_date: null,
          amount_sats: null,
          created_at: "2026-02-18T00:00:00Z",
        },
      ])
    );

    const res = await GET(makeRequest(HEX_NPUB) as any, {
      params: Promise.resolve({}),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.user.id).toBe("u1");
    expect(data.jobs).toHaveLength(1);
    expect(data.jobs[0].service_id).toBe("netflix");
  });

  it("returns 400 for missing npub param", async () => {
    const res = await GET(makeRequest() as any, {
      params: Promise.resolve({}),
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/Missing/);
  });

  it("returns 400 for invalid npub", async () => {
    const res = await GET(makeRequest("not-valid") as any, {
      params: Promise.resolve({}),
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/Invalid npub/);
  });

  it("returns 404 when user not found", async () => {
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const res = await GET(makeRequest(HEX_NPUB) as any, {
      params: Promise.resolve({}),
    });
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toMatch(/User not found/);
  });

  it("returns empty jobs array when user has no jobs", async () => {
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ id: "u1", nostr_npub: HEX_NPUB, debt_sats: 0 }])
    );
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const res = await GET(makeRequest(HEX_NPUB) as any, {
      params: Promise.resolve({}),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.jobs).toHaveLength(0);
  });

  it("includes debt_sats in user response", async () => {
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ id: "u1", nostr_npub: HEX_NPUB, debt_sats: 6000 }])
    );
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const res = await GET(makeRequest(HEX_NPUB) as any, {
      params: Promise.resolve({}),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.user.debt_sats).toBe(6000);
  });
});
