import { describe, it, expect, beforeEach, vi } from "vitest";

const mockRunDailyCron = vi.fn();

vi.mock("@/lib/cron-daily", () => ({
  runDailyCron: (...args: unknown[]) => mockRunDailyCron(...args),
}));

import { POST } from "../route";

function makeRequest(
  method: string,
  headers: Record<string, string> = {}
): Request {
  return new Request("http://localhost/api/cron/daily", {
    method,
    headers,
  });
}

beforeEach(() => {
  mockRunDailyCron.mockReset();
  vi.stubEnv("CRON_SECRET", "test-cron-secret-123");
});

describe("POST /api/cron/daily", () => {
  it("returns cron result on valid auth", async () => {
    mockRunDailyCron.mockResolvedValue({
      jobs_created: 3,
      nudged: 1,
      skipped_debt: 2,
    });

    const req = makeRequest("POST", {
      authorization: "Bearer test-cron-secret-123",
    });
    const res = await POST(req as any);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({
      jobs_created: 3,
      nudged: 1,
      skipped_debt: 2,
    });
  });

  it("rejects missing authorization header", async () => {
    const req = makeRequest("POST");
    const res = await POST(req as any);

    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.error).toBe("Unauthorized");
    expect(mockRunDailyCron).not.toHaveBeenCalled();
  });

  it("rejects invalid bearer token", async () => {
    const req = makeRequest("POST", {
      authorization: "Bearer wrong-secret",
    });
    const res = await POST(req as any);

    expect(res.status).toBe(401);
    expect(mockRunDailyCron).not.toHaveBeenCalled();
  });

  it("rejects non-Bearer auth scheme", async () => {
    const req = makeRequest("POST", {
      authorization: "Basic test-cron-secret-123",
    });
    const res = await POST(req as any);

    expect(res.status).toBe(401);
    expect(mockRunDailyCron).not.toHaveBeenCalled();
  });

  it("rejects when CRON_SECRET env var is not set", async () => {
    vi.stubEnv("CRON_SECRET", "");

    const req = makeRequest("POST", {
      authorization: "Bearer anything",
    });
    const res = await POST(req as any);

    expect(res.status).toBe(401);
    expect(mockRunDailyCron).not.toHaveBeenCalled();
  });

  it("rejects authorization header with empty token", async () => {
    const req = makeRequest("POST", {
      authorization: "Bearer ",
    });
    const res = await POST(req as any);

    expect(res.status).toBe(401);
    expect(mockRunDailyCron).not.toHaveBeenCalled();
  });

  it("returns empty result when no work to do", async () => {
    mockRunDailyCron.mockResolvedValue({
      jobs_created: 0,
      nudged: 0,
      skipped_debt: 0,
    });

    const req = makeRequest("POST", {
      authorization: "Bearer test-cron-secret-123",
    });
    const res = await POST(req as any);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({
      jobs_created: 0,
      nudged: 0,
      skipped_debt: 0,
    });
  });

  it("calls runDailyCron exactly once on valid request", async () => {
    mockRunDailyCron.mockResolvedValue({
      jobs_created: 0,
      nudged: 0,
      skipped_debt: 0,
    });

    const req = makeRequest("POST", {
      authorization: "Bearer test-cron-secret-123",
    });
    await POST(req as any);

    expect(mockRunDailyCron).toHaveBeenCalledTimes(1);
  });

  it("accepts correct token via timing-safe comparison", async () => {
    mockRunDailyCron.mockResolvedValue({
      jobs_created: 1,
      nudged: 0,
      skipped_debt: 0,
    });

    const req = makeRequest("POST", {
      authorization: "Bearer test-cron-secret-123",
    });
    const res = await POST(req as any);

    expect(res.status).toBe(200);
    expect(mockRunDailyCron).toHaveBeenCalledTimes(1);
  });

  it("rejects token with same length but different value", async () => {
    // Same length as "test-cron-secret-123" (20 chars)
    const req = makeRequest("POST", {
      authorization: "Bearer xxxx-cron-secret-123",
    });
    const res = await POST(req as any);

    expect(res.status).toBe(401);
    expect(mockRunDailyCron).not.toHaveBeenCalled();
  });
});

describe("GET /api/cron/daily (not exported)", () => {
  it("route only exports POST, no GET handler", async () => {
    // The route module only exports POST, so GET requests to this path
    // would get a 405 from Next.js automatically. We verify no GET export.
    const routeModule = await import("../route");
    expect(routeModule).toHaveProperty("POST");
    expect(routeModule).not.toHaveProperty("GET");
  });
});
