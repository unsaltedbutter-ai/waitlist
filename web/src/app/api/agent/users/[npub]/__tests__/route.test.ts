import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockQueryResult } from "@/__test-utils__/fixtures";

vi.mock("@/lib/db", () => ({
  query: vi.fn(),
}));
vi.mock("@/lib/agent-auth", () => ({
  withAgentAuth: vi.fn((handler: Function) => {
    return async (req: Request, segmentData: any) => {
      const params = segmentData?.params
        ? await segmentData.params
        : undefined;
      return handler(req, { params });
    };
  }),
}));

import { query } from "@/lib/db";
import { GET } from "../route";

function makeRequest(): Request {
  return new Request("http://localhost/api/agent/users/npub1abc", {
    method: "GET",
  });
}

beforeEach(() => {
  vi.mocked(query).mockReset();
});

function mockUser(overrides: Record<string, unknown> = {}) {
  vi.mocked(query).mockResolvedValueOnce(
    mockQueryResult([{
      id: "user-uuid-1",
      nostr_npub: "npub1abc",
      debt_sats: 0,
      onboarded_at: "2026-01-01T00:00:00Z",
      created_at: "2025-12-15T00:00:00Z",
      ...overrides,
    }])
  );
}

function mockServices(services: { service_id: string; display_name: string }[]) {
  vi.mocked(query).mockResolvedValueOnce(mockQueryResult(services));
}

function mockQueue(items: { service_id: string; position: number; plan_id: string | null }[]) {
  vi.mocked(query).mockResolvedValueOnce(mockQueryResult(items));
}

function mockActiveJobs(jobs: { id: string; service_id: string; action: string; status: string }[]) {
  vi.mocked(query).mockResolvedValueOnce(mockQueryResult(jobs));
}

describe("GET /api/agent/users/[npub]", () => {
  it("happy path: returns full profile with services, queue, active jobs", async () => {
    mockUser();
    mockServices([
      { service_id: "netflix", display_name: "Netflix" },
      { service_id: "hulu", display_name: "Hulu" },
    ]);
    mockQueue([
      { service_id: "netflix", position: 1, plan_id: "netflix_standard" },
      { service_id: "hulu", position: 2, plan_id: null },
    ]);
    mockActiveJobs([
      { id: "job-1", service_id: "netflix", action: "cancel", status: "active" },
    ]);

    const req = makeRequest();
    const res = await GET(req as any, { params: Promise.resolve({ npub: "npub1abc" }) });

    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data.user.id).toBe("user-uuid-1");
    expect(data.user.nostr_npub).toBe("npub1abc");
    expect(data.user.debt_sats).toBe(0);
    expect(data.user.onboarded_at).toBe("2026-01-01T00:00:00Z");

    expect(data.services).toHaveLength(2);
    expect(data.services[0].service_id).toBe("netflix");
    expect(data.services[1].display_name).toBe("Hulu");

    expect(data.queue).toHaveLength(2);
    expect(data.queue[0].position).toBe(1);
    expect(data.queue[0].plan_id).toBe("netflix_standard");

    expect(data.active_jobs).toHaveLength(1);
    expect(data.active_jobs[0].action).toBe("cancel");
  });

  it("user not found: returns 404", async () => {
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const req = makeRequest();
    const res = await GET(req as any, { params: Promise.resolve({ npub: "npub1unknown" }) });

    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toMatch(/User not found/);
  });

  it("user with no services or queue: returns empty arrays", async () => {
    mockUser();
    mockServices([]);
    mockQueue([]);
    mockActiveJobs([]);

    const req = makeRequest();
    const res = await GET(req as any, { params: Promise.resolve({ npub: "npub1abc" }) });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.services).toEqual([]);
    expect(data.queue).toEqual([]);
    expect(data.active_jobs).toEqual([]);
  });

  it("user with debt: debt_sats reflected in response", async () => {
    mockUser({ debt_sats: 6000 });
    mockServices([]);
    mockQueue([]);
    mockActiveJobs([]);

    const req = makeRequest();
    const res = await GET(req as any, { params: Promise.resolve({ npub: "npub1abc" }) });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.user.debt_sats).toBe(6000);
  });

  it("user with multiple active jobs: all returned", async () => {
    mockUser();
    mockServices([
      { service_id: "netflix", display_name: "Netflix" },
      { service_id: "hulu", display_name: "Hulu" },
    ]);
    mockQueue([
      { service_id: "netflix", position: 1, plan_id: null },
      { service_id: "hulu", position: 2, plan_id: null },
    ]);
    mockActiveJobs([
      { id: "job-1", service_id: "netflix", action: "cancel", status: "active" },
      { id: "job-2", service_id: "hulu", action: "resume", status: "pending" },
    ]);

    const req = makeRequest();
    const res = await GET(req as any, { params: Promise.resolve({ npub: "npub1abc" }) });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.active_jobs).toHaveLength(2);
    expect(data.active_jobs[0].id).toBe("job-1");
    expect(data.active_jobs[1].id).toBe("job-2");
  });
});
