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
import { POST } from "../route";

const JOB_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

function makeRequest(body: unknown): Request {
  return new Request(
    `http://localhost/api/operator/jobs/${JOB_ID}/force-status`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  );
}

beforeEach(() => {
  vi.mocked(query).mockReset();
});

describe("POST /api/operator/jobs/[id]/force-status", () => {
  it("sets terminal status and writes audit log", async () => {
    // 1. Job lookup
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ id: JOB_ID, status: "active" }])
    );
    // 2. Update
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([
        {
          id: JOB_ID,
          user_id: "u1",
          service_id: "netflix",
          action: "cancel",
          status: "completed_paid",
          status_updated_at: "2026-02-18T00:00:00Z",
        },
      ])
    );
    // 3. Audit log
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const res = await POST(
      makeRequest({ status: "completed_paid", reason: "Verified manually" }) as any,
      { params: Promise.resolve({ id: JOB_ID }) }
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.job.status).toBe("completed_paid");

    // Verify audit log
    const auditCall = vi.mocked(query).mock.calls[2];
    const detail = JSON.parse(auditCall[1]![3] as string);
    expect(detail.previous_status).toBe("active");
    expect(detail.new_status).toBe("completed_paid");
    expect(detail.reason).toBe("Verified manually");
  });

  it("accepts all valid terminal statuses", async () => {
    const statuses = [
      "completed_paid",
      "completed_eventual",
      "completed_reneged",
      "user_skip",
      "user_abandon",
      "implied_skip",
    ];

    for (const status of statuses) {
      vi.mocked(query).mockReset();
      vi.mocked(query).mockResolvedValueOnce(
        mockQueryResult([{ id: JOB_ID, status: "pending" }])
      );
      vi.mocked(query).mockResolvedValueOnce(
        mockQueryResult([
          {
            id: JOB_ID,
            user_id: "u1",
            service_id: "netflix",
            action: "cancel",
            status,
            status_updated_at: "2026-02-18T00:00:00Z",
          },
        ])
      );
      vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

      const res = await POST(
        makeRequest({ status, reason: "test" }) as any,
        { params: Promise.resolve({ id: JOB_ID }) }
      );
      expect(res.status).toBe(200);
    }
  });

  it("rejects non-terminal status", async () => {
    const res = await POST(
      makeRequest({ status: "active", reason: "test" }) as any,
      { params: Promise.resolve({ id: JOB_ID }) }
    );
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/status must be one of/);
  });

  it("rejects pending status", async () => {
    const res = await POST(
      makeRequest({ status: "pending", reason: "test" }) as any,
      { params: Promise.resolve({ id: JOB_ID }) }
    );
    expect(res.status).toBe(400);
  });

  it("returns 404 when job not found", async () => {
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const res = await POST(
      makeRequest({ status: "completed_paid", reason: "test" }) as any,
      { params: Promise.resolve({ id: JOB_ID }) }
    );
    expect(res.status).toBe(404);
  });

  it("returns 400 when reason is missing", async () => {
    const res = await POST(
      makeRequest({ status: "completed_paid" }) as any,
      { params: Promise.resolve({ id: JOB_ID }) }
    );
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/reason/);
  });

  it("returns 400 when status is missing", async () => {
    const res = await POST(
      makeRequest({ reason: "test" }) as any,
      { params: Promise.resolve({ id: JOB_ID }) }
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when id param is missing", async () => {
    const res = await POST(
      makeRequest({ status: "completed_paid", reason: "test" }) as any,
      { params: Promise.resolve({}) }
    );
    expect(res.status).toBe(400);
  });
});
