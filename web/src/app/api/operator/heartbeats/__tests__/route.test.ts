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

function makeRequest(): Request {
  return new Request("http://localhost/api/operator/heartbeats", {
    method: "GET",
  });
}

beforeEach(() => {
  vi.mocked(query).mockReset();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-02-18T12:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

import { afterEach } from "vitest";

describe("GET /api/operator/heartbeats", () => {
  it("returns unknown status for all components when table is empty", async () => {
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const res = await GET(makeRequest() as any, {
      params: Promise.resolve({}),
    });
    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data.components).toHaveLength(3);
    for (const c of data.components) {
      expect(c.status).toBe("unknown");
      expect(c.last_seen_at).toBeNull();
      expect(c.payload).toBeNull();
    }
    const names = data.components.map((c: any) => c.component);
    expect(names).toEqual(["orchestrator", "agent", "inference"]);
  });

  it("returns healthy for component seen less than 10 minutes ago", async () => {
    const fiveMinAgo = new Date("2026-02-18T11:55:00Z").toISOString();
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([
        {
          component: "orchestrator",
          last_seen_at: fiveMinAgo,
          payload: { version: "1.0" },
          updated_at: fiveMinAgo,
        },
      ])
    );

    const res = await GET(makeRequest() as any, {
      params: Promise.resolve({}),
    });
    const data = await res.json();

    const orch = data.components.find((c: any) => c.component === "orchestrator");
    expect(orch.status).toBe("healthy");
    expect(orch.last_seen_at).toBe(fiveMinAgo);
    expect(orch.payload).toEqual({ version: "1.0" });
  });

  it("returns warning for component seen 10-30 minutes ago", async () => {
    const fifteenMinAgo = new Date("2026-02-18T11:45:00Z").toISOString();
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([
        {
          component: "agent",
          last_seen_at: fifteenMinAgo,
          payload: null,
          updated_at: fifteenMinAgo,
        },
      ])
    );

    const res = await GET(makeRequest() as any, {
      params: Promise.resolve({}),
    });
    const data = await res.json();

    const agent = data.components.find((c: any) => c.component === "agent");
    expect(agent.status).toBe("warning");
  });

  it("returns critical for component seen more than 30 minutes ago", async () => {
    const oneHourAgo = new Date("2026-02-18T11:00:00Z").toISOString();
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([
        {
          component: "inference",
          last_seen_at: oneHourAgo,
          payload: null,
          updated_at: oneHourAgo,
        },
      ])
    );

    const res = await GET(makeRequest() as any, {
      params: Promise.resolve({}),
    });
    const data = await res.json();

    const inference = data.components.find((c: any) => c.component === "inference");
    expect(inference.status).toBe("critical");
  });

  it("mixes statuses across components correctly", async () => {
    const fiveMinAgo = new Date("2026-02-18T11:55:00Z").toISOString();
    const twentyMinAgo = new Date("2026-02-18T11:40:00Z").toISOString();

    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([
        {
          component: "orchestrator",
          last_seen_at: fiveMinAgo,
          payload: null,
          updated_at: fiveMinAgo,
        },
        {
          component: "agent",
          last_seen_at: twentyMinAgo,
          payload: null,
          updated_at: twentyMinAgo,
        },
        // inference not present: should be unknown
      ])
    );

    const res = await GET(makeRequest() as any, {
      params: Promise.resolve({}),
    });
    const data = await res.json();

    const orch = data.components.find((c: any) => c.component === "orchestrator");
    const agent = data.components.find((c: any) => c.component === "agent");
    const inference = data.components.find((c: any) => c.component === "inference");

    expect(orch.status).toBe("healthy");
    expect(agent.status).toBe("warning");
    expect(inference.status).toBe("unknown");
  });

  it("returns 500 on db error", async () => {
    vi.mocked(query).mockRejectedValueOnce(new Error("db down"));

    const res = await GET(makeRequest() as any, {
      params: Promise.resolve({}),
    });

    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.error).toMatch(/Internal server error/);
  });
});
