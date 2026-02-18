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

const USER_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

function makeRequest(): Request {
  return new Request(`http://localhost/api/operator/users/${USER_ID}`, {
    method: "GET",
  });
}

/** Mock all 6 queries for user detail */
function mockUserDetailQueries(opts?: {
  user?: Record<string, unknown>[] | null;
  queue?: Record<string, unknown>[];
  jobs?: Record<string, unknown>[];
  credentials?: Record<string, unknown>[];
  consents?: Record<string, unknown>[];
  transactions?: Record<string, unknown>;
}) {
  // 1. User profile
  vi.mocked(query).mockResolvedValueOnce(
    mockQueryResult(
      opts?.user === null
        ? []
        : opts?.user ?? [
            {
              id: USER_ID,
              nostr_npub: "npub1test",
              debt_sats: 0,
              onboarded_at: "2026-01-15T00:00:00Z",
              created_at: "2026-01-01T00:00:00Z",
              updated_at: "2026-01-15T00:00:00Z",
            },
          ]
    )
  );
  // 2. Queue
  vi.mocked(query).mockResolvedValueOnce(
    mockQueryResult(opts?.queue ?? [])
  );
  // 3. Jobs
  vi.mocked(query).mockResolvedValueOnce(
    mockQueryResult(opts?.jobs ?? [])
  );
  // 4. Credentials
  vi.mocked(query).mockResolvedValueOnce(
    mockQueryResult(opts?.credentials ?? [])
  );
  // 5. Consents
  vi.mocked(query).mockResolvedValueOnce(
    mockQueryResult(opts?.consents ?? [])
  );
  // 6. Transactions aggregate
  vi.mocked(query).mockResolvedValueOnce(
    mockQueryResult([opts?.transactions ?? { total_count: "0", total_sats: "0" }])
  );
}

beforeEach(() => {
  vi.mocked(query).mockReset();
});

describe("GET /api/operator/users/[id]", () => {
  it("returns 404 when user not found", async () => {
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const res = await GET(makeRequest() as any, {
      params: Promise.resolve({ id: USER_ID }),
    });
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toBe("User not found");
  });

  it("returns full user detail with empty related data", async () => {
    mockUserDetailQueries();

    const res = await GET(makeRequest() as any, {
      params: Promise.resolve({ id: USER_ID }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data.user.id).toBe(USER_ID);
    expect(data.user.nostr_npub).toBe("npub1test");
    expect(data.queue).toEqual([]);
    expect(data.jobs).toEqual([]);
    expect(data.credentials).toEqual([]);
    expect(data.consents).toEqual([]);
    expect(data.transactions).toEqual({ total_count: 0, total_sats: 0 });
  });

  it("returns queue items with plan names", async () => {
    mockUserDetailQueries({
      queue: [
        {
          id: "q1",
          service_id: "netflix",
          position: 1,
          plan_id: "netflix_standard",
          plan_name: "Standard",
          created_at: "2026-01-10T00:00:00Z",
        },
      ],
    });

    const res = await GET(makeRequest() as any, {
      params: Promise.resolve({ id: USER_ID }),
    });
    const data = await res.json();
    expect(data.queue).toHaveLength(1);
    expect(data.queue[0].plan_name).toBe("Standard");
  });

  it("returns recent jobs", async () => {
    mockUserDetailQueries({
      jobs: [
        {
          id: "j1",
          service_id: "netflix",
          action: "cancel",
          trigger: "scheduled",
          status: "completed_paid",
          status_updated_at: "2026-01-20T00:00:00Z",
          billing_date: "2026-02-01",
          amount_sats: 3000,
          created_at: "2026-01-20T00:00:00Z",
        },
      ],
    });

    const res = await GET(makeRequest() as any, {
      params: Promise.resolve({ id: USER_ID }),
    });
    const data = await res.json();
    expect(data.jobs).toHaveLength(1);
    expect(data.jobs[0].action).toBe("cancel");
    expect(data.jobs[0].amount_sats).toBe(3000);
  });

  it("returns credentials (service names only, no encrypted values)", async () => {
    mockUserDetailQueries({
      credentials: [
        {
          id: "c1",
          service_id: "netflix",
          created_at: "2026-01-05T00:00:00Z",
          updated_at: "2026-01-05T00:00:00Z",
        },
      ],
    });

    const res = await GET(makeRequest() as any, {
      params: Promise.resolve({ id: USER_ID }),
    });
    const data = await res.json();
    expect(data.credentials).toHaveLength(1);
    expect(data.credentials[0].service_id).toBe("netflix");
    // Must not contain encrypted fields
    expect(data.credentials[0]).not.toHaveProperty("email_enc");
    expect(data.credentials[0]).not.toHaveProperty("password_enc");
  });

  it("returns transaction totals", async () => {
    mockUserDetailQueries({
      transactions: { total_count: "5", total_sats: "15000" },
    });

    const res = await GET(makeRequest() as any, {
      params: Promise.resolve({ id: USER_ID }),
    });
    const data = await res.json();
    expect(data.transactions).toEqual({ total_count: 5, total_sats: 15000 });
  });

  it("returns 400 when id param is missing", async () => {
    const res = await GET(makeRequest() as any, {
      params: Promise.resolve({}),
    });
    expect(res.status).toBe(400);
  });
});
