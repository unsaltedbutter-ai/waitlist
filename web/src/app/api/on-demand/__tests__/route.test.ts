import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/create-on-demand-job", () => ({
  createOnDemandJob: vi.fn(),
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

import { createOnDemandJob } from "@/lib/create-on-demand-job";
import { POST } from "../route";

function makeRequest(body: object): Request {
  return new Request("http://localhost/api/on-demand", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.mocked(createOnDemandJob).mockReset();
});

describe("POST /api/on-demand", () => {
  it("invalid JSON body returns 400", async () => {
    const req = new Request("http://localhost/api/on-demand", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    const res = await POST(req as any, { params: Promise.resolve({}) });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe("Invalid JSON");
    expect(createOnDemandJob).not.toHaveBeenCalled();
  });

  it("passes serviceId and action to createOnDemandJob", async () => {
    vi.mocked(createOnDemandJob).mockResolvedValue({
      ok: true,
      job_id: "job-1",
    });

    const req = makeRequest({ serviceId: "netflix", action: "cancel" });
    await POST(req as any, { params: Promise.resolve({}) });

    expect(createOnDemandJob).toHaveBeenCalledWith(
      "test-user",
      "netflix",
      "cancel"
    );
  });

  it("maps ok result to 200 with job_id and status", async () => {
    vi.mocked(createOnDemandJob).mockResolvedValue({
      ok: true,
      job_id: "cancel-job-1",
    });

    const req = makeRequest({ serviceId: "netflix", action: "cancel" });
    const res = await POST(req as any, { params: Promise.resolve({}) });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.job_id).toBe("cancel-job-1");
    expect(data.status).toBe("pending");
  });

  it("maps error result to correct status and error", async () => {
    vi.mocked(createOnDemandJob).mockResolvedValue({
      ok: false,
      status: 403,
      error: "Outstanding debt",
      debt_sats: 3000,
    });

    const req = makeRequest({ serviceId: "netflix", action: "cancel" });
    const res = await POST(req as any, { params: Promise.resolve({}) });

    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toBe("Outstanding debt");
    expect(data.debt_sats).toBe(3000);
  });

  it("maps error result without debt_sats (no extra fields)", async () => {
    vi.mocked(createOnDemandJob).mockResolvedValue({
      ok: false,
      status: 400,
      error: "Missing required field: serviceId",
    });

    const req = makeRequest({});
    const res = await POST(req as any, { params: Promise.resolve({}) });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe("Missing required field: serviceId");
    expect(data.debt_sats).toBeUndefined();
  });

  it("maps 409 conflict result", async () => {
    vi.mocked(createOnDemandJob).mockResolvedValue({
      ok: false,
      status: 409,
      error: "A job is already in progress for this service",
    });

    const req = makeRequest({ serviceId: "netflix", action: "cancel" });
    const res = await POST(req as any, { params: Promise.resolve({}) });

    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.error).toBe("A job is already in progress for this service");
  });

  it("unhandled exception returns 500", async () => {
    vi.mocked(createOnDemandJob).mockRejectedValue(new Error("db exploded"));

    const req = makeRequest({ serviceId: "netflix", action: "cancel" });
    const res = await POST(req as any, { params: Promise.resolve({}) });

    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.error).toBe("Internal server error");
  });

  it("passes empty strings when fields are missing from body", async () => {
    vi.mocked(createOnDemandJob).mockResolvedValue({
      ok: false,
      status: 400,
      error: "Missing required field: serviceId",
    });

    const req = makeRequest({});
    await POST(req as any, { params: Promise.resolve({}) });

    expect(createOnDemandJob).toHaveBeenCalledWith("test-user", "", "");
  });

  // M-5: User not found (stale JWT, deleted account)
  it("returns 404 when user not found (stale JWT / deleted account)", async () => {
    vi.mocked(createOnDemandJob).mockResolvedValue({
      ok: false,
      status: 404,
      error: "User not found",
    });

    const req = makeRequest({ serviceId: "netflix", action: "cancel" });
    const res = await POST(req as any, { params: Promise.resolve({}) });

    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toBe("User not found");
    expect(data.debt_sats).toBeUndefined();
  });
});
