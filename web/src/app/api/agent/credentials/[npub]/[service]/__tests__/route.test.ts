import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockQueryResult } from "@/__test-utils__/fixtures";

vi.mock("@/lib/db", () => ({
  query: vi.fn(),
}));
vi.mock("@/lib/agent-auth", () => ({
  withAgentAuth: vi.fn((handler: Function) => {
    return async (req: Request, segmentData: any) => {
      const params = segmentData?.params ? await segmentData.params : undefined;
      return handler(req, { body: "", params });
    };
  }),
}));
vi.mock("@/lib/crypto", () => ({
  decrypt: vi.fn((buf: Buffer) => `decrypted-${buf.toString()}`),
}));

import { query } from "@/lib/db";
import { decrypt } from "@/lib/crypto";
import { GET } from "../route";

function makeRequest(npub: string, service: string): Request {
  return new Request(
    `http://localhost/api/agent/credentials/${encodeURIComponent(npub)}/${service}`,
    { method: "GET" }
  );
}

function callGET(npub: string, service: string) {
  const req = makeRequest(npub, service);
  return GET(req as any, {
    params: Promise.resolve({ npub, service }),
  });
}

/** Mock: user found */
function mockUserFound(userId: string = "user-uuid-1") {
  vi.mocked(query).mockResolvedValueOnce(
    mockQueryResult([{ id: userId }])
  );
}

/** Mock: user not found */
function mockUserNotFound() {
  vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));
}

/** Mock: active job found */
function mockActiveJob() {
  vi.mocked(query).mockResolvedValueOnce(
    mockQueryResult([{ id: "job-uuid-1" }])
  );
}

/** Mock: no active job */
function mockNoActiveJob() {
  vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));
}

/** Mock: credentials found */
function mockCredentialsFound(
  emailEnc: string = "encrypted-email",
  passwordEnc: string = "encrypted-password"
) {
  vi.mocked(query).mockResolvedValueOnce(
    mockQueryResult([{
      email_enc: Buffer.from(emailEnc),
      password_enc: Buffer.from(passwordEnc),
    }])
  );
}

/** Mock: no credentials */
function mockNoCredentials() {
  vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));
}

beforeEach(() => {
  vi.mocked(query).mockReset();
  vi.mocked(decrypt).mockReset();
  vi.mocked(decrypt).mockImplementation((buf: Buffer) => `decrypted-${buf.toString()}`);
});

describe("GET /api/agent/credentials/[npub]/[service]", () => {
  // --- Happy path ---

  it("active job exists, credentials exist: returns decrypted email + password (200)", async () => {
    mockUserFound();
    mockActiveJob();
    mockCredentialsFound();

    const res = await callGET("aabb".repeat(16), "netflix");
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.email).toBe("decrypted-encrypted-email");
    expect(data.password).toBe("decrypted-encrypted-password");
  });

  it("job in awaiting_otp status: returns credentials (200)", async () => {
    mockUserFound();
    // The query matches 'dispatched', 'active', and 'awaiting_otp', so any match works
    mockActiveJob();
    mockCredentialsFound();

    const res = await callGET("aabb".repeat(16), "apple_tv");
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.email).toBeDefined();
    expect(data.password).toBeDefined();
  });

  it("job in dispatched status: returns credentials (200)", async () => {
    mockUserFound();
    // dispatched jobs should also be allowed (agent needs creds to start work)
    mockActiveJob();
    mockCredentialsFound();

    const res = await callGET("aabb".repeat(16), "netflix");
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.email).toBeDefined();
    expect(data.password).toBeDefined();
  });

  // --- Auth/gating ---

  it("no active job (job in pending status): returns 403", async () => {
    mockUserFound();
    mockNoActiveJob(); // pending jobs won't match the IN ('active','awaiting_otp') filter

    const res = await callGET("aabb".repeat(16), "netflix");
    expect(res.status).toBe(403);

    const data = await res.json();
    expect(data.error).toBe("No active job for this user and service");
  });

  it("no active job (job in completed_paid status): returns 403", async () => {
    mockUserFound();
    mockNoActiveJob(); // completed_paid won't match the filter

    const res = await callGET("aabb".repeat(16), "hulu");
    expect(res.status).toBe(403);

    const data = await res.json();
    expect(data.error).toBe("No active job for this user and service");
  });

  it("no job at all for this user+service: returns 403", async () => {
    mockUserFound();
    mockNoActiveJob();

    const res = await callGET("aabb".repeat(16), "disney_plus");
    expect(res.status).toBe(403);

    const data = await res.json();
    expect(data.error).toBe("No active job for this user and service");
  });

  it("user not found (bad npub): returns 404", async () => {
    mockUserNotFound();

    const res = await callGET("eeff".repeat(16), "netflix");
    expect(res.status).toBe(404);

    const data = await res.json();
    expect(data.error).toBe("Not found");
  });

  // --- Credential lookup ---

  it("user exists, active job exists, but no credentials for that service: returns 404", async () => {
    mockUserFound();
    mockActiveJob();
    mockNoCredentials();

    const res = await callGET("aabb".repeat(16), "peacock");
    expect(res.status).toBe(404);

    const data = await res.json();
    expect(data.error).toBe("No credentials found");
  });

  // --- Edge cases ---

  it("multiple jobs for same user+service (one active, others terminal): finds the active one", async () => {
    mockUserFound();
    // The SQL uses LIMIT 1 with status filter, so only active/awaiting_otp jobs match
    mockActiveJob();
    mockCredentialsFound("email-data", "pass-data");

    const res = await callGET("aabb".repeat(16), "netflix");
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.email).toBe("decrypted-email-data");
    expect(data.password).toBe("decrypted-pass-data");
  });

  it("URL-encoded hex npub: proper decoding", async () => {
    const hexNpub = "aabb".repeat(16);
    const encoded = encodeURIComponent(hexNpub);

    mockUserFound();
    mockActiveJob();
    mockCredentialsFound();

    const req = new Request(
      `http://localhost/api/agent/credentials/${encoded}/netflix`,
      { method: "GET" }
    );
    // Pass the encoded value as the param (Next.js delivers the raw segment value)
    const res = await GET(req as any, {
      params: Promise.resolve({ npub: encoded, service: "netflix" }),
    });
    expect(res.status).toBe(200);

    // Verify the user lookup used the decoded hex npub
    const userQuery = vi.mocked(query).mock.calls[0];
    expect(userQuery[1]).toEqual([hexNpub]);
  });

  it("service_id that doesn't match any streaming_services: returns 404 (no user or 403)", async () => {
    // If user exists but no job matches a nonexistent service, we get 403
    mockUserFound();
    mockNoActiveJob();

    const res = await callGET("aabb".repeat(16), "nonexistent_service");
    expect(res.status).toBe(403);

    const data = await res.json();
    expect(data.error).toBe("No active job for this user and service");
  });

  // --- Service ID format validation ---

  it("rejects service ID with uppercase letters (400)", async () => {
    const res = await callGET("aabb".repeat(16), "Netflix");
    expect(res.status).toBe(400);

    const data = await res.json();
    expect(data.error).toBe("Invalid service ID format");
    expect(vi.mocked(query)).not.toHaveBeenCalled();
  });

  it("rejects service ID with SQL injection attempt (400)", async () => {
    const res = await callGET("aabb".repeat(16), "x' OR '1'='1");
    expect(res.status).toBe(400);

    const data = await res.json();
    expect(data.error).toBe("Invalid service ID format");
    expect(vi.mocked(query)).not.toHaveBeenCalled();
  });

  it("rejects service ID starting with a digit (400)", async () => {
    const res = await callGET("aabb".repeat(16), "1netflix");
    expect(res.status).toBe(400);

    const data = await res.json();
    expect(data.error).toBe("Invalid service ID format");
    expect(vi.mocked(query)).not.toHaveBeenCalled();
  });

  it("rejects service ID that is too long (400)", async () => {
    const longId = "a" + "b".repeat(31); // 32 chars, exceeds max of 31
    const res = await callGET("aabb".repeat(16), longId);
    expect(res.status).toBe(400);

    const data = await res.json();
    expect(data.error).toBe("Invalid service ID format");
    expect(vi.mocked(query)).not.toHaveBeenCalled();
  });

  it("rejects single-character service ID (400)", async () => {
    const res = await callGET("aabb".repeat(16), "a");
    expect(res.status).toBe(400);

    const data = await res.json();
    expect(data.error).toBe("Invalid service ID format");
    expect(vi.mocked(query)).not.toHaveBeenCalled();
  });

  it("accepts valid service IDs (lowercase, underscores)", async () => {
    mockUserFound();
    mockActiveJob();
    mockCredentialsFound();

    const res = await callGET("aabb".repeat(16), "apple_tv");
    expect(res.status).toBe(200);
  });

  // --- Query correctness ---

  it("passes correct params to user lookup query", async () => {
    mockUserFound();
    mockActiveJob();
    mockCredentialsFound();

    await callGET("ccdd".repeat(16), "hulu");

    const userCall = vi.mocked(query).mock.calls[0];
    expect(userCall[0]).toContain("nostr_npub");
    expect(userCall[1]).toEqual(["ccdd".repeat(16)]);
  });

  it("passes correct params to job lookup query", async () => {
    mockUserFound("user-uuid-42");
    mockActiveJob();
    mockCredentialsFound();

    await callGET("ccdd".repeat(16), "paramount");

    const jobCall = vi.mocked(query).mock.calls[1];
    expect(jobCall[0]).toContain("dispatched");
    expect(jobCall[0]).toContain("active");
    expect(jobCall[0]).toContain("awaiting_otp");
    expect(jobCall[1]).toEqual(["user-uuid-42", "paramount"]);
  });

  it("passes correct params to credentials lookup query", async () => {
    mockUserFound("user-uuid-42");
    mockActiveJob();
    mockCredentialsFound();

    await callGET("ccdd".repeat(16), "paramount");

    const credCall = vi.mocked(query).mock.calls[2];
    expect(credCall[0]).toContain("streaming_credentials");
    expect(credCall[1]).toEqual(["user-uuid-42", "paramount"]);
  });

  it("calls decrypt with the raw buffer values from the database", async () => {
    mockUserFound();
    mockActiveJob();
    mockCredentialsFound("raw-email-bytes", "raw-password-bytes");

    await callGET("aabb".repeat(16), "netflix");

    expect(decrypt).toHaveBeenCalledTimes(2);
    expect(decrypt).toHaveBeenCalledWith(Buffer.from("raw-email-bytes"));
    expect(decrypt).toHaveBeenCalledWith(Buffer.from("raw-password-bytes"));
  });
});
