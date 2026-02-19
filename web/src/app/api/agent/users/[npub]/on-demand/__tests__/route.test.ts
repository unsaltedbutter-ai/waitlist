import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/create-on-demand-job", () => ({
  createOnDemandJob: vi.fn(),
}));
vi.mock("@/lib/queries", () => ({
  getUserByNpub: vi.fn(),
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

import { createOnDemandJob } from "@/lib/create-on-demand-job";
import { getUserByNpub } from "@/lib/queries";
import { POST } from "../route";

const VALID_HEX = "aabb".repeat(16);
const UNKNOWN_HEX = "eeff".repeat(16);

function makeRequest(body: object): Request {
  return new Request(`http://localhost/api/agent/users/${VALID_HEX}/on-demand`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.mocked(createOnDemandJob).mockReset();
  vi.mocked(getUserByNpub).mockReset();
});

describe("POST /api/agent/users/[npub]/on-demand", () => {
  it("resolves user by npub and passes userId to createOnDemandJob", async () => {
    vi.mocked(getUserByNpub).mockResolvedValue({
      id: "user-uuid-1",
      nostr_npub: VALID_HEX,
      debt_sats: 0,
      onboarded_at: "2026-01-01",
      created_at: "2026-01-01",
    });
    vi.mocked(createOnDemandJob).mockResolvedValue({
      ok: true,
      job_id: "new-job-1",
    });

    const req = makeRequest({ service: "netflix", action: "cancel" });
    const res = await POST(req as any, { params: Promise.resolve({ npub: VALID_HEX }) });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.job_id).toBe("new-job-1");
    expect(data.status).toBe("pending");
    expect(getUserByNpub).toHaveBeenCalledWith(VALID_HEX);
    expect(createOnDemandJob).toHaveBeenCalledWith(
      "user-uuid-1",
      "netflix",
      "cancel"
    );
  });

  it("user not found returns 404 without calling createOnDemandJob", async () => {
    vi.mocked(getUserByNpub).mockResolvedValue(null);

    const req = makeRequest({ service: "netflix", action: "cancel" });
    const res = await POST(req as any, { params: Promise.resolve({ npub: UNKNOWN_HEX }) });

    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toBe("User not found");
    expect(createOnDemandJob).not.toHaveBeenCalled();
  });

  it("missing npub returns 400", async () => {
    const req = makeRequest({ service: "netflix", action: "cancel" });
    const res = await POST(req as any, { params: Promise.resolve({}) });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe("Missing npub");
    expect(createOnDemandJob).not.toHaveBeenCalled();
  });

  it("invalid JSON body returns 400", async () => {
    const req = new Request(`http://localhost/api/agent/users/${VALID_HEX}/on-demand`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    const res = await POST(req as any, { params: Promise.resolve({ npub: VALID_HEX }) });

    expect(res.status).toBe(400);
    expect(createOnDemandJob).not.toHaveBeenCalled();
  });

  it("maps error result with debt_sats", async () => {
    vi.mocked(getUserByNpub).mockResolvedValue({
      id: "user-uuid-1",
      nostr_npub: VALID_HEX,
      debt_sats: 0,
      onboarded_at: "2026-01-01",
      created_at: "2026-01-01",
    });
    vi.mocked(createOnDemandJob).mockResolvedValue({
      ok: false,
      status: 403,
      error: "Outstanding debt",
      debt_sats: 3000,
    });

    const req = makeRequest({ service: "netflix", action: "cancel" });
    const res = await POST(req as any, { params: Promise.resolve({ npub: VALID_HEX }) });

    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toBe("Outstanding debt");
    expect(data.debt_sats).toBe(3000);
  });

  it("maps error result without debt_sats", async () => {
    vi.mocked(getUserByNpub).mockResolvedValue({
      id: "user-uuid-1",
      nostr_npub: VALID_HEX,
      debt_sats: 0,
      onboarded_at: "2026-01-01",
      created_at: "2026-01-01",
    });
    vi.mocked(createOnDemandJob).mockResolvedValue({
      ok: false,
      status: 400,
      error: "Missing required field: serviceId",
    });

    const req = makeRequest({});
    const res = await POST(req as any, { params: Promise.resolve({ npub: VALID_HEX }) });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe("Missing required field: serviceId");
    expect(data.debt_sats).toBeUndefined();
  });

  it("maps 409 conflict result", async () => {
    vi.mocked(getUserByNpub).mockResolvedValue({
      id: "user-uuid-1",
      nostr_npub: VALID_HEX,
      debt_sats: 0,
      onboarded_at: "2026-01-01",
      created_at: "2026-01-01",
    });
    vi.mocked(createOnDemandJob).mockResolvedValue({
      ok: false,
      status: 409,
      error: "A job is already in progress for this service",
    });

    const req = makeRequest({ service: "netflix", action: "cancel" });
    const res = await POST(req as any, { params: Promise.resolve({ npub: VALID_HEX }) });

    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.error).toBe("A job is already in progress for this service");
  });

  it("unhandled exception returns 500", async () => {
    vi.mocked(getUserByNpub).mockRejectedValue(new Error("db exploded"));

    const req = makeRequest({ service: "netflix", action: "cancel" });
    const res = await POST(req as any, { params: Promise.resolve({ npub: VALID_HEX }) });

    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.error).toBe("Internal server error");
  });

  it("passes empty strings when fields are missing from body", async () => {
    vi.mocked(getUserByNpub).mockResolvedValue({
      id: "user-uuid-1",
      nostr_npub: VALID_HEX,
      debt_sats: 0,
      onboarded_at: "2026-01-01",
      created_at: "2026-01-01",
    });
    vi.mocked(createOnDemandJob).mockResolvedValue({
      ok: false,
      status: 400,
      error: "Missing required field: serviceId",
    });

    const req = makeRequest({});
    await POST(req as any, { params: Promise.resolve({ npub: VALID_HEX }) });

    expect(createOnDemandJob).toHaveBeenCalledWith("user-uuid-1", "", "");
  });

  it("uses 'service' field name (not 'serviceId') from agent body", async () => {
    vi.mocked(getUserByNpub).mockResolvedValue({
      id: "user-uuid-1",
      nostr_npub: VALID_HEX,
      debt_sats: 0,
      onboarded_at: "2026-01-01",
      created_at: "2026-01-01",
    });
    vi.mocked(createOnDemandJob).mockResolvedValue({
      ok: true,
      job_id: "job-1",
    });

    const req = makeRequest({ service: "hulu", action: "resume" });
    await POST(req as any, { params: Promise.resolve({ npub: VALID_HEX }) });

    expect(createOnDemandJob).toHaveBeenCalledWith(
      "user-uuid-1",
      "hulu",
      "resume"
    );
  });
});
