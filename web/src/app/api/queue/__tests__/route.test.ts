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
import { PUT } from "../route";

function makeRequest(body: object): Request {
  return new Request("http://localhost/api/queue", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function mockServices(ids: string[]) {
  vi.mocked(query).mockResolvedValueOnce(
    mockQueryResult(ids.map((id) => ({ id })))
  );
}

function mockCreds(serviceIds: string[]) {
  vi.mocked(query).mockResolvedValueOnce(
    mockQueryResult(serviceIds.map((id) => ({ service_id: id })))
  );
}

/** Mock the query that reads existing plan_ids (when no plans provided in body) */
function mockExistingPlanIds(rows: { service_id: string; plan_id: string | null }[] = []) {
  vi.mocked(query).mockResolvedValueOnce(mockQueryResult(rows));
}

function mockTransaction() {
  vi.mocked(transaction).mockImplementationOnce(async (cb) => {
    const txQuery = vi.fn().mockResolvedValue(mockQueryResult([]));
    return cb(txQuery as any);
  });
}

beforeEach(() => {
  vi.mocked(query).mockReset();
  vi.mocked(transaction).mockReset();
});

describe("PUT /api/queue", () => {
  // --- Input validation ---

  it("invalid JSON → 400", async () => {
    const req = new Request("http://localhost/api/queue", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    const res = await PUT(req as any, { params: Promise.resolve({}) });
    expect(res.status).toBe(400);
  });

  it("empty order → 400", async () => {
    const req = makeRequest({ order: [] });
    const res = await PUT(req as any, { params: Promise.resolve({}) });
    expect(res.status).toBe(400);
  });

  it("non-array order → 400", async () => {
    const req = makeRequest({ order: "netflix" });
    const res = await PUT(req as any, { params: Promise.resolve({}) });
    expect(res.status).toBe(400);
  });

  it("duplicate service IDs → 400", async () => {
    const req = makeRequest({ order: ["netflix", "netflix", "hulu"] });
    const res = await PUT(req as any, { params: Promise.resolve({}) });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/[Dd]uplicate/);
  });

  // --- Service validation ---

  it("unknown service ID → 400", async () => {
    mockServices(["netflix"]); // only netflix exists
    const req = makeRequest({ order: ["netflix", "nonexistent_service"] });
    const res = await PUT(req as any, { params: Promise.resolve({}) });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/Unknown services.*nonexistent_service/);
  });

  it("multiple unknown service IDs listed in error", async () => {
    mockServices([]); // nothing valid
    const req = makeRequest({ order: ["fake_a", "fake_b"] });
    const res = await PUT(req as any, { params: Promise.resolve({}) });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("fake_a");
    expect(data.error).toContain("fake_b");
  });

  // --- Credential validation ---

  it("service with no credentials → 400", async () => {
    mockServices(["netflix", "hulu"]);
    mockCreds(["netflix"]); // no creds for hulu
    const req = makeRequest({ order: ["netflix", "hulu"] });
    const res = await PUT(req as any, { params: Promise.resolve({}) });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/No credentials.*hulu/);
  });

  it("multiple services missing credentials listed in error", async () => {
    mockServices(["netflix", "hulu", "disney_plus"]);
    mockCreds(["netflix"]); // no creds for hulu or disney_plus
    const req = makeRequest({ order: ["netflix", "hulu", "disney_plus"] });
    const res = await PUT(req as any, { params: Promise.resolve({}) });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("hulu");
    expect(data.error).toContain("disney_plus");
  });

  // --- Successful queue operations ---

  it("create initial queue → success", async () => {
    mockServices(["netflix", "hulu"]);
    mockCreds(["netflix", "hulu"]);
    mockExistingPlanIds();
    mockTransaction();

    const req = makeRequest({ order: ["netflix", "hulu"] });
    const res = await PUT(req as any, { params: Promise.resolve({}) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
  });

  it("reorder existing services → success", async () => {
    mockServices(["netflix", "hulu", "disney_plus"]);
    mockCreds(["netflix", "hulu", "disney_plus"]);
    mockExistingPlanIds();
    mockTransaction();

    const req = makeRequest({ order: ["disney_plus", "netflix", "hulu"] });
    const res = await PUT(req as any, { params: Promise.resolve({}) });
    expect(res.status).toBe(200);
  });

  it("add a new service to queue → success", async () => {
    // User had netflix + hulu, now adding prime_video
    mockServices(["netflix", "hulu", "prime_video"]);
    mockCreds(["netflix", "hulu", "prime_video"]);
    mockExistingPlanIds();
    mockTransaction();

    const req = makeRequest({ order: ["netflix", "prime_video", "hulu"] });
    const res = await PUT(req as any, { params: Promise.resolve({}) });
    expect(res.status).toBe(200);
  });

  it("remove a service from queue → success", async () => {
    // User had 3, now submitting 2
    mockServices(["netflix", "hulu"]);
    mockCreds(["netflix", "hulu"]);
    mockExistingPlanIds();
    mockTransaction();

    const req = makeRequest({ order: ["netflix", "hulu"] });
    const res = await PUT(req as any, { params: Promise.resolve({}) });
    expect(res.status).toBe(200);
  });

  it("single service queue → success", async () => {
    mockServices(["netflix"]);
    mockCreds(["netflix"]);
    mockExistingPlanIds();
    mockTransaction();

    const req = makeRequest({ order: ["netflix"] });
    const res = await PUT(req as any, { params: Promise.resolve({}) });
    expect(res.status).toBe(200);
  });

  it("all supported services in queue → success", async () => {
    const all = [
      "netflix", "hulu", "disney_plus", "prime_video",
      "apple_tv", "paramount", "peacock",
    ];
    mockServices(all);
    mockCreds(all);
    mockExistingPlanIds();
    mockTransaction();

    const req = makeRequest({ order: all });
    const res = await PUT(req as any, { params: Promise.resolve({}) });
    expect(res.status).toBe(200);
  });

  // --- Transaction behavior ---

  it("deletes old queue and inserts new positions in transaction", async () => {
    mockServices(["netflix", "hulu"]);
    mockCreds(["netflix", "hulu"]);
    mockExistingPlanIds([
      { service_id: "netflix", plan_id: "netflix_standard" },
      { service_id: "hulu", plan_id: null },
    ]);

    const txQuery = vi.fn().mockResolvedValue(mockQueryResult([]));
    vi.mocked(transaction).mockImplementationOnce(async (cb) => cb(txQuery as any));

    const req = makeRequest({ order: ["hulu", "netflix"] });
    await PUT(req as any, { params: Promise.resolve({}) });

    // First call: DELETE old queue
    expect(txQuery).toHaveBeenCalledWith(
      "DELETE FROM rotation_queue WHERE user_id = $1",
      ["test-user"]
    );
    // Second call: INSERT position 1 = hulu (no plan_id)
    expect(txQuery).toHaveBeenCalledWith(
      "INSERT INTO rotation_queue (user_id, service_id, position, plan_id) VALUES ($1, $2, $3, $4)",
      ["test-user", "hulu", 1, null]
    );
    // Third call: INSERT position 2 = netflix (preserved plan_id)
    expect(txQuery).toHaveBeenCalledWith(
      "INSERT INTO rotation_queue (user_id, service_id, position, plan_id) VALUES ($1, $2, $3, $4)",
      ["test-user", "netflix", 2, "netflix_standard"]
    );
  });

  // --- Dynamic services / prices scenario ---

  it("newly added service accepted if creds exist", async () => {
    // Simulates operator adding a new service to streaming_services
    // and user selecting it during onboarding
    mockServices(["netflix", "new_streaming_service"]);
    mockCreds(["netflix", "new_streaming_service"]);
    mockExistingPlanIds();
    mockTransaction();

    const req = makeRequest({ order: ["netflix", "new_streaming_service"] });
    const res = await PUT(req as any, { params: Promise.resolve({}) });
    expect(res.status).toBe(200);
  });

  it("extra creds beyond queue are fine (superset)", async () => {
    // User has creds for 5 services but only queues 2
    mockServices(["netflix", "hulu"]);
    mockCreds(["netflix", "hulu", "disney_plus", "prime_video", "peacock"]);
    mockExistingPlanIds();
    mockTransaction();

    const req = makeRequest({ order: ["netflix", "hulu"] });
    const res = await PUT(req as any, { params: Promise.resolve({}) });
    expect(res.status).toBe(200);
  });

  it("plans provided from onboarding are saved as plan_id", async () => {
    mockServices(["netflix", "hulu"]);
    mockCreds(["netflix", "hulu"]);
    // No mockExistingPlanIds needed: plans are provided in body

    const txQuery = vi.fn().mockResolvedValue(mockQueryResult([]));
    vi.mocked(transaction).mockImplementationOnce(async (cb) => cb(txQuery as any));

    const req = makeRequest({
      order: ["netflix", "hulu"],
      plans: { netflix: "netflix_standard_ads", hulu: "hulu_ads" },
    });
    const res = await PUT(req as any, { params: Promise.resolve({}) });
    expect(res.status).toBe(200);

    expect(txQuery).toHaveBeenCalledWith(
      "INSERT INTO rotation_queue (user_id, service_id, position, plan_id) VALUES ($1, $2, $3, $4)",
      ["test-user", "netflix", 1, "netflix_standard_ads"]
    );
    expect(txQuery).toHaveBeenCalledWith(
      "INSERT INTO rotation_queue (user_id, service_id, position, plan_id) VALUES ($1, $2, $3, $4)",
      ["test-user", "hulu", 2, "hulu_ads"]
    );
  });
});
