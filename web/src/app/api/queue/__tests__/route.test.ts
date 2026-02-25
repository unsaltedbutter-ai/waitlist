import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockQueryResult } from "@/__test-utils__/fixtures";
import { TERMINAL_STATUSES, COMPLETED_STATUSES } from "@/lib/constants";

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
import { GET, PUT } from "../route";

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

  it("add a new service to queue -> success", async () => {
    // User had netflix + hulu, now adding disney_plus
    mockServices(["netflix", "hulu", "disney_plus"]);
    mockCreds(["netflix", "hulu", "disney_plus"]);
    mockExistingPlanIds();
    mockTransaction();

    const req = makeRequest({ order: ["netflix", "disney_plus", "hulu"] });
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

  it("all supported services in queue -> success", async () => {
    const all = [
      "netflix", "hulu", "disney_plus",
      "paramount", "peacock", "max",
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
    // Fourth call: UPDATE onboarded_at
    expect(txQuery).toHaveBeenCalledWith(
      "UPDATE users SET onboarded_at = NOW(), updated_at = NOW() WHERE id = $1 AND onboarded_at IS NULL",
      ["test-user"]
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
    mockCreds(["netflix", "hulu", "disney_plus", "max", "peacock"]);
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

  // --- Onboarding activation ---

  it("sets onboarded_at inside the transaction (idempotent via IS NULL guard)", async () => {
    mockServices(["netflix"]);
    mockCreds(["netflix"]);
    mockExistingPlanIds();

    const txQuery = vi.fn().mockResolvedValue(mockQueryResult([]));
    vi.mocked(transaction).mockImplementationOnce(async (cb) => cb(txQuery as any));

    const req = makeRequest({ order: ["netflix"] });
    const res = await PUT(req as any, { params: Promise.resolve({}) });
    expect(res.status).toBe(200);

    // The transaction should include the onboarded_at UPDATE with IS NULL guard
    const onboardCall = txQuery.mock.calls.find((c: unknown[]) =>
      typeof c[0] === "string" && (c[0] as string).includes("onboarded_at")
    );
    expect(onboardCall).toBeTruthy();
    expect(onboardCall![0]).toContain("onboarded_at IS NULL");
  });

  // H-3 / M-7: Transaction error propagates as 500
  it("returns 500 when transaction throws (simulates rollback / DB failure)", async () => {
    mockServices(["netflix", "hulu"]);
    mockCreds(["netflix", "hulu"]);
    mockExistingPlanIds();

    vi.mocked(transaction).mockRejectedValueOnce(
      new Error("could not serialize access due to concurrent update")
    );

    const req = makeRequest({ order: ["netflix", "hulu"] });
    const res = await PUT(req as any, { params: Promise.resolve({}) });
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.error).toBe("Internal server error");
  });

  it("returns 500 when a query inside the transaction callback throws", async () => {
    mockServices(["netflix"]);
    mockCreds(["netflix"]);
    mockExistingPlanIds();

    vi.mocked(transaction).mockImplementationOnce(async (cb) => {
      const txQuery = vi.fn()
        .mockResolvedValueOnce(mockQueryResult([])) // DELETE succeeds
        .mockRejectedValueOnce(new Error("unique_violation")); // INSERT fails
      return cb(txQuery as any);
    });

    const req = makeRequest({ order: ["netflix"] });
    const res = await PUT(req as any, { params: Promise.resolve({}) });
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.error).toBe("Internal server error");
  });
});

// Finding 4.1: database connection failure on GET (no try/catch in route)
describe("GET /api/queue", () => {
  it("returns 500 when database query throws", async () => {
    vi.mocked(query).mockRejectedValueOnce(new Error("Connection refused"));

    const req = new Request("http://localhost/api/queue");
    const res = await GET(req as any, { params: Promise.resolve({}) });
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.error).toBe("Internal server error");
  });

  it("returns queue rows on success", async () => {
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([
        {
          service_id: "netflix",
          service_name: "Netflix",
          position: 1,
          plan_name: "Standard",
          plan_price_cents: 1549,
          active_job_id: null,
          active_job_action: null,
          active_job_status: null,
          last_access_end_date: null,
          last_completed_action: null,
        },
      ])
    );

    const req = new Request("http://localhost/api/queue");
    const res = await GET(req as any, { params: Promise.resolve({}) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.queue).toHaveLength(1);
    expect(data.queue[0].service_id).toBe("netflix");
  });

  it("queue item with no jobs returns null for all job fields", async () => {
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([
        {
          service_id: "netflix",
          service_name: "Netflix",
          position: 1,
          plan_id: "netflix_standard",
          plan_name: "Standard",
          plan_price_cents: 1799,
          active_job_id: null,
          active_job_action: null,
          active_job_status: null,
          last_access_end_date: null,
          last_completed_action: null,
        },
      ])
    );

    const req = new Request("http://localhost/api/queue");
    const res = await GET(req as any, { params: Promise.resolve({}) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.queue).toHaveLength(1);
    const item = data.queue[0];
    expect(item.active_job_id).toBeNull();
    expect(item.active_job_action).toBeNull();
    expect(item.active_job_status).toBeNull();
    expect(item.last_access_end_date).toBeNull();
    expect(item.last_completed_action).toBeNull();
  });

  it("queue item with an active (non-terminal) job returns the job data", async () => {
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([
        {
          service_id: "netflix",
          service_name: "Netflix",
          position: 1,
          plan_id: "netflix_standard",
          plan_name: "Standard",
          plan_price_cents: 1799,
          active_job_id: "job-uuid-1",
          active_job_action: "cancel",
          active_job_status: "dispatched",
          last_access_end_date: null,
          last_completed_action: null,
        },
      ])
    );

    const req = new Request("http://localhost/api/queue");
    const res = await GET(req as any, { params: Promise.resolve({}) });
    expect(res.status).toBe(200);
    const data = await res.json();
    const item = data.queue[0];
    expect(item.active_job_id).toBe("job-uuid-1");
    expect(item.active_job_action).toBe("cancel");
    expect(item.active_job_status).toBe("dispatched");
    expect(item.last_access_end_date).toBeNull();
    expect(item.last_completed_action).toBeNull();
  });

  it("queue item with a completed job returns the access end date and last action", async () => {
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([
        {
          service_id: "hulu",
          service_name: "Hulu",
          position: 1,
          plan_id: "hulu_ads",
          plan_name: "Hulu (With Ads)",
          plan_price_cents: 999,
          active_job_id: null,
          active_job_action: null,
          active_job_status: null,
          last_access_end_date: "2026-03-15",
          last_completed_action: "cancel",
        },
      ])
    );

    const req = new Request("http://localhost/api/queue");
    const res = await GET(req as any, { params: Promise.resolve({}) });
    expect(res.status).toBe(200);
    const data = await res.json();
    const item = data.queue[0];
    expect(item.active_job_id).toBeNull();
    expect(item.last_access_end_date).toBe("2026-03-15");
    expect(item.last_completed_action).toBe("cancel");
  });

  it("queue item with both active and completed jobs returns both", async () => {
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([
        {
          service_id: "netflix",
          service_name: "Netflix",
          position: 1,
          plan_id: "netflix_standard",
          plan_name: "Standard",
          plan_price_cents: 1799,
          active_job_id: "job-uuid-2",
          active_job_action: "resume",
          active_job_status: "awaiting_otp",
          last_access_end_date: "2026-02-28",
          last_completed_action: "cancel",
        },
      ])
    );

    const req = new Request("http://localhost/api/queue");
    const res = await GET(req as any, { params: Promise.resolve({}) });
    expect(res.status).toBe(200);
    const data = await res.json();
    const item = data.queue[0];
    expect(item.active_job_id).toBe("job-uuid-2");
    expect(item.active_job_action).toBe("resume");
    expect(item.active_job_status).toBe("awaiting_otp");
    expect(item.last_access_end_date).toBe("2026-02-28");
    expect(item.last_completed_action).toBe("cancel");
  });

  it("queue item with only a failed job returns no active job (failed is terminal)", async () => {
    // The SQL lateral join filters out terminal statuses including "failed",
    // so the DB returns null for active_job fields when the only job is failed.
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([
        {
          service_id: "disney_plus",
          service_name: "Disney+",
          position: 1,
          plan_id: "disney_plus_basic",
          plan_name: "Disney+ Basic",
          plan_price_cents: 899,
          active_job_id: null,
          active_job_action: null,
          active_job_status: null,
          last_access_end_date: null,
          last_completed_action: null,
        },
      ])
    );

    const req = new Request("http://localhost/api/queue");
    const res = await GET(req as any, { params: Promise.resolve({}) });
    expect(res.status).toBe(200);
    const data = await res.json();
    const item = data.queue[0];
    expect(item.active_job_id).toBeNull();
    expect(item.active_job_action).toBeNull();
    expect(item.active_job_status).toBeNull();
    // Failed jobs are not in completed_paid/completed_eventual,
    // so last_access_end_date is also null
    expect(item.last_access_end_date).toBeNull();
    expect(item.last_completed_action).toBeNull();
  });

  // H-2: Empty queue returns 200 with { queue: [] }
  it("returns 200 with empty array when user has no queue entries", async () => {
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const req = new Request("http://localhost/api/queue");
    const res = await GET(req as any, { params: Promise.resolve({}) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.queue).toEqual([]);
  });

  // H-1: SQL parameter binding verification
  it("passes correct parameter count and ordering to the enriched queue query", async () => {
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const req = new Request("http://localhost/api/queue");
    await GET(req as any, { params: Promise.resolve({}) });

    expect(query).toHaveBeenCalledOnce();
    const [sql, params] = vi.mocked(query).mock.calls[0];

    // Parameter array: [userId, ...TERMINAL_STATUSES, ...COMPLETED_STATUSES]
    const expectedLength = 1 + TERMINAL_STATUSES.length + COMPLETED_STATUSES.length;
    expect(params).toHaveLength(expectedLength);

    // $1 = userId
    expect(params![0]).toBe("test-user");

    // $2..$N = TERMINAL_STATUSES in order
    for (let i = 0; i < TERMINAL_STATUSES.length; i++) {
      expect(params![1 + i]).toBe(TERMINAL_STATUSES[i]);
    }

    // Remaining params = COMPLETED_STATUSES in order
    const completedOffset = 1 + TERMINAL_STATUSES.length;
    for (let i = 0; i < COMPLETED_STATUSES.length; i++) {
      expect(params![completedOffset + i]).toBe(COMPLETED_STATUSES[i]);
    }

    // Verify SQL placeholders match: terminal placeholders start at $2
    const terminalPlaceholders = TERMINAL_STATUSES.map((_, i) => `$${i + 2}`).join(", ");
    expect(sql).toContain(terminalPlaceholders);

    // Completed placeholders start after terminal statuses
    const completedPlaceholders = COMPLETED_STATUSES.map(
      (_, i) => `$${TERMINAL_STATUSES.length + 2 + i}`
    ).join(", ");
    expect(sql).toContain(completedPlaceholders);
  });
});
