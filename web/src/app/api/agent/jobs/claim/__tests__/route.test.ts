import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockQueryResult } from "@/__test-utils__/fixtures";

vi.mock("@/lib/db", () => ({
  query: vi.fn(),
  transaction: vi.fn(),
}));
vi.mock("@/lib/agent-auth", () => ({
  withAgentAuth: vi.fn((handler: Function) => {
    return async (req: Request, segmentData: any) => {
      const params = segmentData?.params
        ? await segmentData.params
        : undefined;
      const body = await req.text();
      return handler(req, { body, params });
    };
  }),
}));

import { transaction } from "@/lib/db";
import { POST } from "../route";

const UUID_1 = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
const UUID_2 = "b2c3d4e5-f6a7-8901-bcde-f12345678901";
const UUID_3 = "c3d4e5f6-a7b8-9012-cdef-123456789012";

function makeRequest(body: object): Request {
  return new Request("http://localhost/api/agent/jobs/claim", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.mocked(transaction).mockReset();
});

describe("POST /api/agent/jobs/claim", () => {
  it("claims multiple pending jobs atomically", async () => {
    const claimedRows = [
      {
        id: UUID_1,
        user_id: "user-1",
        service_id: "netflix",
        action: "cancel",
        trigger: "scheduled",
        status: "dispatched",
        billing_date: "2026-03-01",
        access_end_date: null,
        outreach_count: 0,
        next_outreach_at: null,
        amount_sats: null,
        invoice_id: null,
        created_at: "2026-02-15T05:00:00Z",
        status_updated_at: "2026-02-18T10:00:00Z",
        nostr_npub: "npub1abc",
      },
      {
        id: UUID_2,
        user_id: "user-2",
        service_id: "hulu",
        action: "resume",
        trigger: "on_demand",
        status: "dispatched",
        billing_date: null,
        access_end_date: null,
        outreach_count: 0,
        next_outreach_at: null,
        amount_sats: null,
        invoice_id: null,
        created_at: "2026-02-15T05:01:00Z",
        status_updated_at: "2026-02-18T10:00:00Z",
        nostr_npub: "npub1def",
      },
    ];

    vi.mocked(transaction).mockImplementationOnce(async (cb) => {
      const txQuery = vi.fn().mockResolvedValue(mockQueryResult(claimedRows));
      return cb(txQuery as any);
    });

    const res = await POST(
      makeRequest({ job_ids: [UUID_1, UUID_2] }) as any,
      { params: Promise.resolve({}) }
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.claimed).toHaveLength(2);
    expect(data.claimed[0].id).toBe(UUID_1);
    expect(data.claimed[0].status).toBe("dispatched");
    expect(data.claimed[1].nostr_npub).toBe("npub1def");
  });

  it("skips non-pending jobs silently (returns only actually claimed)", async () => {
    // Only one of two is pending
    const claimedRows = [
      {
        id: UUID_1,
        user_id: "user-1",
        service_id: "netflix",
        action: "cancel",
        trigger: "scheduled",
        status: "dispatched",
        billing_date: "2026-03-01",
        access_end_date: null,
        outreach_count: 0,
        next_outreach_at: null,
        amount_sats: null,
        invoice_id: null,
        created_at: "2026-02-15T05:00:00Z",
        status_updated_at: "2026-02-18T10:00:00Z",
        nostr_npub: "npub1abc",
      },
    ];

    vi.mocked(transaction).mockImplementationOnce(async (cb) => {
      const txQuery = vi.fn().mockResolvedValue(mockQueryResult(claimedRows));
      return cb(txQuery as any);
    });

    const res = await POST(
      makeRequest({ job_ids: [UUID_1, UUID_2] }) as any,
      { params: Promise.resolve({}) }
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.claimed).toHaveLength(1);
    expect(data.claimed[0].id).toBe(UUID_1);
  });

  it("returns empty claimed array when no jobs are pending", async () => {
    vi.mocked(transaction).mockImplementationOnce(async (cb) => {
      const txQuery = vi.fn().mockResolvedValue(mockQueryResult([]));
      return cb(txQuery as any);
    });

    const res = await POST(
      makeRequest({ job_ids: [UUID_3] }) as any,
      { params: Promise.resolve({}) }
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.claimed).toHaveLength(0);
  });

  it("rejects empty job_ids array", async () => {
    const res = await POST(
      makeRequest({ job_ids: [] }) as any,
      { params: Promise.resolve({}) }
    );
    expect(res.status).toBe(400);
  });

  it("rejects missing job_ids field", async () => {
    const res = await POST(
      makeRequest({}) as any,
      { params: Promise.resolve({}) }
    );
    expect(res.status).toBe(400);
  });

  it("rejects more than 100 job_ids", async () => {
    const ids = Array.from({ length: 101 }, (_, i) =>
      `a1b2c3d4-e5f6-7890-abcd-${String(i).padStart(12, "0")}`
    );
    const res = await POST(
      makeRequest({ job_ids: ids }) as any,
      { params: Promise.resolve({}) }
    );
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("100");
  });

  it("rejects invalid UUIDs", async () => {
    const res = await POST(
      makeRequest({ job_ids: ["not-a-uuid"] }) as any,
      { params: Promise.resolve({}) }
    );
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("Invalid UUID");
  });

  it("rejects invalid JSON body", async () => {
    const req = new Request("http://localhost/api/agent/jobs/claim", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    const res = await POST(req as any, { params: Promise.resolve({}) });
    expect(res.status).toBe(400);
  });

  it("uses a transaction for atomicity", async () => {
    vi.mocked(transaction).mockImplementationOnce(async (cb) => {
      const txQuery = vi.fn().mockResolvedValue(mockQueryResult([]));
      return cb(txQuery as any);
    });

    await POST(
      makeRequest({ job_ids: ["a1b2c3d4-e5f6-7890-abcd-ef1234567890"] }) as any,
      { params: Promise.resolve({}) }
    );

    expect(transaction).toHaveBeenCalledOnce();
  });
});
