import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockQueryResult } from "@/__test-utils__/fixtures";

vi.mock("@/lib/db", () => ({
  query: vi.fn(),
}));
vi.mock("@/lib/reneged", () => ({
  checkEmailBlocklist: vi.fn(),
}));

import { query } from "@/lib/db";
import { checkEmailBlocklist } from "@/lib/reneged";
import { createOnDemandJob } from "@/lib/create-on-demand-job";

const USER_ID = "user-uuid-1";

beforeEach(() => {
  vi.mocked(query).mockReset();
  vi.mocked(checkEmailBlocklist).mockReset();
  vi.mocked(checkEmailBlocklist).mockResolvedValue({ blocked: false, debt_sats: 0 });
});

function mockUserDebt(debtSats: number = 0) {
  vi.mocked(query).mockResolvedValueOnce(
    mockQueryResult([{ debt_sats: debtSats }])
  );
}

function mockUserNotFound() {
  vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));
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

function mockQueueCount(count: number = 1) {
  vi.mocked(query).mockResolvedValueOnce(
    mockQueryResult([{ count: String(count) }])
  );
}

function mockJobConflict() {
  vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));
}

/** Set up all mocks for a successful job creation. */
function mockHappyPath(jobId: string = "new-job-1", queueCount: number = 1) {
  mockUserDebt(0);
  mockServiceExists();
  mockCredentials();
  mockJobCreated(jobId);
  mockQueueCount(queueCount);
}

describe("createOnDemandJob", () => {
  it("creates a cancel job and returns ok with job_id", async () => {
    mockHappyPath("cancel-job-1");

    const result = await createOnDemandJob(USER_ID, "netflix", "cancel");

    expect(result).toEqual({ ok: true, job_id: "cancel-job-1", queue_position: 1 });

    // Verify INSERT query
    const insertCall = vi.mocked(query).mock.calls[3];
    expect(insertCall[0]).toContain("INSERT INTO jobs");
    expect(insertCall[0]).toContain("ON CONFLICT DO NOTHING");
    expect(insertCall[1]).toEqual([USER_ID, "netflix", "cancel"]);
  });

  it("creates a resume job and returns ok with job_id", async () => {
    mockHappyPath("resume-job-1");

    const result = await createOnDemandJob(USER_ID, "netflix", "resume");

    expect(result).toEqual({ ok: true, job_id: "resume-job-1", queue_position: 1 });

    const insertCall = vi.mocked(query).mock.calls[3];
    expect(insertCall[1]).toEqual([USER_ID, "netflix", "resume"]);
  });

  it("returns 400 when serviceId is empty string", async () => {
    const result = await createOnDemandJob(USER_ID, "", "cancel");

    expect(result).toEqual({
      ok: false,
      status: 400,
      error: "Missing required field: serviceId",
    });
    expect(query).not.toHaveBeenCalled();
  });

  it("returns 400 when action is empty string", async () => {
    const result = await createOnDemandJob(USER_ID, "netflix", "");

    expect(result).toEqual({
      ok: false,
      status: 400,
      error: "Missing required field: action",
    });
    expect(query).not.toHaveBeenCalled();
  });

  it("returns 400 for non-string serviceId", async () => {
    const result = await createOnDemandJob(USER_ID, 123 as any, "cancel");

    expect(result).toEqual({
      ok: false,
      status: 400,
      error: "Missing required field: serviceId",
    });
  });

  it("returns 400 for non-string action", async () => {
    const result = await createOnDemandJob(USER_ID, "netflix", 42 as any);

    expect(result).toEqual({
      ok: false,
      status: 400,
      error: "Missing required field: action",
    });
  });

  it("returns 400 for invalid action", async () => {
    const result = await createOnDemandJob(USER_ID, "netflix", "pause");

    expect(result).toEqual({
      ok: false,
      status: 400,
      error: "Invalid action: must be one of cancel, resume",
    });
    expect(query).not.toHaveBeenCalled();
  });

  it("returns 404 when user not found", async () => {
    mockUserNotFound();

    const result = await createOnDemandJob(USER_ID, "netflix", "cancel");

    expect(result).toEqual({
      ok: false,
      status: 404,
      error: "User not found",
    });
  });

  it("returns 403 with debt_sats when user has debt", async () => {
    mockUserDebt(3000);

    const result = await createOnDemandJob(USER_ID, "netflix", "cancel");

    expect(result).toEqual({
      ok: false,
      status: 403,
      error: "Outstanding debt",
      debt_sats: 3000,
    });
  });

  it("returns 400 when service does not exist in streaming_services", async () => {
    mockUserDebt(0);
    mockServiceNotFound();

    const result = await createOnDemandJob(USER_ID, "fakestreamingco", "cancel");

    expect(result).toEqual({
      ok: false,
      status: 400,
      error: "Invalid service: fakestreamingco",
    });
  });

  it("returns 400 when no credentials for service", async () => {
    mockUserDebt(0);
    mockServiceExists();
    mockNoCredentials();

    const result = await createOnDemandJob(USER_ID, "netflix", "cancel");

    expect(result).toEqual({
      ok: false,
      status: 400,
      error: "No credentials for this service",
    });
  });

  it("returns 403 when email is blocklisted with debt", async () => {
    mockUserDebt(0);
    mockServiceExists();
    mockCredentials();
    vi.mocked(checkEmailBlocklist).mockResolvedValue({ blocked: true, debt_sats: 6000 });

    const result = await createOnDemandJob(USER_ID, "netflix", "cancel");

    expect(result).toEqual({
      ok: false,
      status: 403,
      error: "Email blocked due to outstanding debt",
      debt_sats: 6000,
    });
  });

  it("returns 409 when a duplicate active job exists", async () => {
    mockUserDebt(0);
    mockServiceExists();
    mockCredentials();
    mockJobConflict();

    const result = await createOnDemandJob(USER_ID, "netflix", "cancel");

    expect(result).toEqual({
      ok: false,
      status: 409,
      error: "A job is already in progress for this service",
    });
  });

  it("propagates exception when checkEmailBlocklist throws", async () => {
    mockUserDebt(0);
    mockServiceExists();
    mockCredentials();
    vi.mocked(checkEmailBlocklist).mockRejectedValue(new Error("decrypt failure"));

    await expect(
      createOnDemandJob(USER_ID, "netflix", "cancel")
    ).rejects.toThrow("decrypt failure");
  });

  it("propagates exception when query throws", async () => {
    vi.mocked(query).mockRejectedValue(new Error("connection refused"));

    await expect(
      createOnDemandJob(USER_ID, "netflix", "cancel")
    ).rejects.toThrow("connection refused");
  });

  it("calls checkEmailBlocklist with correct arguments", async () => {
    mockHappyPath();

    await createOnDemandJob(USER_ID, "netflix", "cancel");

    expect(checkEmailBlocklist).toHaveBeenCalledWith(USER_ID, "netflix");
  });

  it("passes through when email blocklist returns not blocked", async () => {
    mockHappyPath("clean-job-1");
    vi.mocked(checkEmailBlocklist).mockResolvedValue({ blocked: false, debt_sats: 0 });

    const result = await createOnDemandJob(USER_ID, "netflix", "cancel");

    expect(result).toEqual({ ok: true, job_id: "clean-job-1", queue_position: 1 });
  });
});
