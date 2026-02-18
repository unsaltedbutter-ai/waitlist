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
      const body = await req.text();
      return handler(req, { body, params });
    };
  }),
}));

import { query } from "@/lib/db";
import { POST } from "../route";

function makeRequest(body: object): Request {
  return new Request("http://localhost/api/agent/users/npub1abc/on-demand", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.mocked(query).mockReset();
});

function mockUser(overrides: Record<string, unknown> = {}) {
  vi.mocked(query).mockResolvedValueOnce(
    mockQueryResult([{ id: "user-uuid-1", debt_sats: 0, ...overrides }])
  );
}

function mockServiceExists() {
  vi.mocked(query).mockResolvedValueOnce(
    mockQueryResult([{ id: "netflix" }])
  );
}

function mockServiceNotFound() {
  vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));
}

function mockCredentials() {
  vi.mocked(query).mockResolvedValueOnce(
    mockQueryResult([{ id: "cred-1" }])
  );
}

function mockNoCredentials() {
  vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));
}

function mockJobCreated(jobId: string = "new-job-1") {
  vi.mocked(query).mockResolvedValueOnce(
    mockQueryResult([{ id: jobId }])
  );
}

function mockJobConflict() {
  vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));
}

describe("POST /api/agent/users/[npub]/on-demand", () => {
  it("happy path: creates pending job, returns job_id", async () => {
    mockUser();
    mockServiceExists();
    mockCredentials();
    mockJobCreated("new-job-1");

    const req = makeRequest({ service: "netflix", action: "cancel" });
    const res = await POST(req as any, { params: Promise.resolve({ npub: "npub1abc" }) });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.job_id).toBe("new-job-1");
    expect(data.status).toBe("pending");

    // Verify the INSERT call (query index 3: getUserByNpub, service, creds, insert)
    const insertCall = vi.mocked(query).mock.calls[3];
    expect(insertCall[0]).toContain("INSERT INTO jobs");
    expect(insertCall[0]).toContain("ON CONFLICT DO NOTHING");
    expect(insertCall[1]).toEqual(["user-uuid-1", "netflix", "cancel"]);
  });

  it("resume action: creates pending resume job", async () => {
    mockUser();
    mockServiceExists();
    mockCredentials();
    mockJobCreated("resume-job-1");

    const req = makeRequest({ service: "netflix", action: "resume" });
    const res = await POST(req as any, { params: Promise.resolve({ npub: "npub1abc" }) });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.job_id).toBe("resume-job-1");

    const insertCall = vi.mocked(query).mock.calls[3];
    expect(insertCall[1]).toEqual(["user-uuid-1", "netflix", "resume"]);
  });

  it("user has debt: returns 403 with debt amount", async () => {
    mockUser({ debt_sats: 3000 });

    const req = makeRequest({ service: "netflix", action: "cancel" });
    const res = await POST(req as any, { params: Promise.resolve({ npub: "npub1abc" }) });

    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toMatch(/Outstanding debt/);
    expect(data.debt_sats).toBe(3000);
  });

  it("user not found: returns 404", async () => {
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const req = makeRequest({ service: "netflix", action: "cancel" });
    const res = await POST(req as any, { params: Promise.resolve({ npub: "npub1unknown" }) });

    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toMatch(/User not found/);
  });

  it("invalid action (not cancel/resume): returns 400", async () => {
    const req = makeRequest({ service: "netflix", action: "pause" });
    const res = await POST(req as any, { params: Promise.resolve({ npub: "npub1abc" }) });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/Invalid action/);
  });

  it("invalid service: returns 400", async () => {
    mockUser();
    mockServiceNotFound();

    const req = makeRequest({ service: "fakestreamingco", action: "cancel" });
    const res = await POST(req as any, { params: Promise.resolve({ npub: "npub1abc" }) });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/Invalid service/);
  });

  it("duplicate job (non-terminal job already exists): returns 409", async () => {
    mockUser();
    mockServiceExists();
    mockCredentials();
    mockJobConflict();

    const req = makeRequest({ service: "netflix", action: "cancel" });
    const res = await POST(req as any, { params: Promise.resolve({ npub: "npub1abc" }) });

    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.error).toMatch(/non-terminal job already exists/);
  });

  it("no credentials for service: returns 400", async () => {
    mockUser();
    mockServiceExists();
    mockNoCredentials();

    const req = makeRequest({ service: "netflix", action: "cancel" });
    const res = await POST(req as any, { params: Promise.resolve({ npub: "npub1abc" }) });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/No credentials/);
  });

  it("missing body fields: returns 400", async () => {
    const req = makeRequest({});
    const res = await POST(req as any, { params: Promise.resolve({ npub: "npub1abc" }) });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/Missing required fields/);
  });

  it("missing service field: returns 400", async () => {
    const req = makeRequest({ action: "cancel" });
    const res = await POST(req as any, { params: Promise.resolve({ npub: "npub1abc" }) });

    expect(res.status).toBe(400);
  });

  it("missing action field: returns 400", async () => {
    const req = makeRequest({ service: "netflix" });
    const res = await POST(req as any, { params: Promise.resolve({ npub: "npub1abc" }) });

    expect(res.status).toBe(400);
  });

  it("invalid JSON body: returns 400", async () => {
    const req = new Request("http://localhost/api/agent/users/npub1abc/on-demand", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    const res = await POST(req as any, { params: Promise.resolve({ npub: "npub1abc" }) });

    expect(res.status).toBe(400);
  });
});
