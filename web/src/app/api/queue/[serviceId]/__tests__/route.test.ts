import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockQueryResult } from "@/__test-utils__/fixtures";

vi.mock("@/lib/db", () => ({
  query: vi.fn(),
  transaction: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({
  withAuth: vi.fn((handler: Function) => {
    return async (req: Request, segmentData: any) => {
      const params = segmentData?.params
        ? await segmentData.params
        : undefined;
      return handler(req, { userId: "test-user", params });
    };
  }),
}));

import { query, transaction } from "@/lib/db";
import { DELETE } from "../route";

function makeDeleteRequest(serviceId: string) {
  return {
    req: new Request(`http://localhost/api/queue/${serviceId}`, { method: "DELETE" }),
    segmentData: { params: Promise.resolve({ serviceId }) },
  };
}

beforeEach(() => {
  vi.mocked(query).mockReset();
  vi.mocked(transaction).mockReset();
});

describe("DELETE /api/queue/[serviceId]", () => {
  it("missing serviceId param -> 400", async () => {
    const req = new Request("http://localhost/api/queue/", { method: "DELETE" });
    const res = await DELETE(req as any, { params: Promise.resolve({}) });
    expect(res.status).toBe(400);
  });

  it("service not in queue -> 404", async () => {
    // Queue lookup returns empty
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const { req, segmentData } = makeDeleteRequest("netflix");
    const res = await DELETE(req as any, segmentData);
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toMatch(/not in your queue/i);
  });

  it("last service in queue -> 200 with remaining: 0", async () => {
    // Service is in queue
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ service_id: "netflix" }])
    );
    // No active jobs
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    // Transaction: delete queue entry, delete creds, re-number (nothing left)
    const txQuery = vi.fn()
      .mockResolvedValueOnce(mockQueryResult([])) // delete queue entry
      .mockResolvedValueOnce(mockQueryResult([])) // delete credentials
      .mockResolvedValueOnce(mockQueryResult([])); // select remaining (empty)
    vi.mocked(transaction).mockImplementationOnce(async (cb) => cb(txQuery as any));

    const { req, segmentData } = makeDeleteRequest("netflix");
    const res = await DELETE(req as any, segmentData);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.remaining).toBe(0);
  });

  it("active job blocking removal -> 409", async () => {
    // Service is in queue
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ service_id: "netflix" }])
    );
    // Active job exists
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ id: "job-1" }])
    );

    const { req, segmentData } = makeDeleteRequest("netflix");
    const res = await DELETE(req as any, segmentData);
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.error).toMatch(/active job/i);
  });

  it("successful removal -> 200 with remaining count", async () => {
    // Service is in queue
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ service_id: "netflix" }])
    );
    // No active jobs
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    // Transaction: delete queue entry, delete creds, re-number
    const txQuery = vi.fn()
      .mockResolvedValueOnce(mockQueryResult([])) // delete queue entry
      .mockResolvedValueOnce(mockQueryResult([])) // delete credentials
      .mockResolvedValueOnce(mockQueryResult([   // select remaining
        { service_id: "hulu" },
        { service_id: "disney_plus" },
      ]))
      .mockResolvedValueOnce(mockQueryResult([])) // update pos 1
      .mockResolvedValueOnce(mockQueryResult([])); // update pos 2
    vi.mocked(transaction).mockImplementationOnce(async (cb) => cb(txQuery as any));

    const { req, segmentData } = makeDeleteRequest("netflix");
    const res = await DELETE(req as any, segmentData);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.remaining).toBe(2);
  });

  it("deletes both queue entry and credentials in transaction", async () => {
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ service_id: "hulu" }])
    );
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const txQuery = vi.fn()
      .mockResolvedValueOnce(mockQueryResult([]))
      .mockResolvedValueOnce(mockQueryResult([]))
      .mockResolvedValueOnce(mockQueryResult([{ service_id: "netflix" }]))
      .mockResolvedValueOnce(mockQueryResult([]));
    vi.mocked(transaction).mockImplementationOnce(async (cb) => cb(txQuery as any));

    const { req, segmentData } = makeDeleteRequest("hulu");
    await DELETE(req as any, segmentData);

    // Verify queue entry deleted
    expect(txQuery).toHaveBeenCalledWith(
      "DELETE FROM rotation_queue WHERE user_id = $1 AND service_id = $2",
      ["test-user", "hulu"]
    );
    // Verify credentials deleted
    expect(txQuery).toHaveBeenCalledWith(
      "DELETE FROM streaming_credentials WHERE user_id = $1 AND service_id = $2",
      ["test-user", "hulu"]
    );
    // Verify re-numbering
    expect(txQuery).toHaveBeenCalledWith(
      "UPDATE rotation_queue SET position = $1 WHERE user_id = $2 AND service_id = $3",
      [1, "test-user", "netflix"]
    );
  });

  it("database error -> 500", async () => {
    vi.mocked(query).mockRejectedValueOnce(new Error("Connection refused"));

    const { req, segmentData } = makeDeleteRequest("netflix");
    const res = await DELETE(req as any, segmentData);
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.error).toBe("Internal server error");
  });
});
