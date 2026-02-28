import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockQueryResult } from "@/__test-utils__/fixtures";

vi.mock("@/lib/db", () => ({
  query: vi.fn(),
}));
vi.mock("@/lib/crypto", () => ({
  sealedBoxEncrypt: vi.fn(async (val: string) => Buffer.from(`sealed:${val}`)),
  hashEmail: vi.fn((email: string) => "hash_" + email.trim().toLowerCase()),
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

import { query } from "@/lib/db";
import { sealedBoxEncrypt } from "@/lib/crypto";
import { POST, GET } from "../route";

function makePostRequest(body: object): Request {
  return new Request("http://localhost/api/credentials", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.mocked(query).mockReset();
  vi.mocked(sealedBoxEncrypt).mockClear();
});

function mockRenegedClean() {
  vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));
}

describe("POST /api/credentials", () => {
  it("saves credentials for a valid service → 201", async () => {
    mockRenegedClean();
    // Service exists
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([{ id: "netflix" }]));
    // INSERT succeeds
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const req = makePostRequest({
      serviceId: "netflix",
      email: "user@example.com",
      password: "hunter2",
    });
    const res = await POST(req as any, { params: Promise.resolve({}) });
    expect(res.status).toBe(201);

    // Verify sealedBoxEncrypt was called with the right values
    expect(sealedBoxEncrypt).toHaveBeenCalledWith("user@example.com");
    expect(sealedBoxEncrypt).toHaveBeenCalledWith("hunter2");

    // Verify the INSERT query received sealedBoxEncrypt() return values, not plaintext
    const insertCall = vi.mocked(query).mock.calls[2];
    const params = insertCall[1] as unknown[];
    expect(params[2]).toEqual(Buffer.from("sealed:user@example.com"));
    expect(params[3]).toEqual(Buffer.from("sealed:hunter2"));
    // email_hash is stored alongside encrypted blobs
    expect(params[4]).toBe("hash_user@example.com");
    // Must NOT be the plaintext strings
    expect(params[2]).not.toBe("user@example.com");
    expect(params[3]).not.toBe("hunter2");
  });

  it("stores the exact credentials passed, not stale values", async () => {
    mockRenegedClean();
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([{ id: "netflix" }]));
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const req = makePostRequest({
      serviceId: "netflix",
      email: "shared@example.com",
      password: "shared-pass",
    });
    await POST(req as any, { params: Promise.resolve({}) });

    // The INSERT query should receive the sealed blobs + email_hash
    const insertCall = vi.mocked(query).mock.calls[2];
    const params = insertCall[1] as unknown[];
    expect(params[0]).toBe("test-user");
    expect(params[1]).toBe("netflix");
    expect(Buffer.from(params[2] as Buffer).toString()).toBe("sealed:shared@example.com");
    expect(Buffer.from(params[3] as Buffer).toString()).toBe("sealed:shared-pass");
    expect(params[4]).toBe("hash_shared@example.com");
  });

  it("upserts on conflict — second POST overwrites first", async () => {
    // First save
    mockRenegedClean();
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([{ id: "netflix" }]));
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    await POST(
      makePostRequest({
        serviceId: "netflix",
        email: "old@example.com",
        password: "old-pass",
      }) as any,
      { params: Promise.resolve({}) }
    );

    // Second save with different creds (simulates "use same" toggle overwrite)
    mockRenegedClean();
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([{ id: "netflix" }]));
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    await POST(
      makePostRequest({
        serviceId: "netflix",
        email: "shared@example.com",
        password: "shared-pass",
      }) as any,
      { params: Promise.resolve({}) }
    );

    // The second INSERT's params should have the new creds (6 calls total: 3 per POST)
    const lastInsert = vi.mocked(query).mock.calls[5];
    const params = lastInsert[1] as unknown[];
    expect(Buffer.from(params[2] as Buffer).toString()).toBe("sealed:shared@example.com");
    expect(Buffer.from(params[3] as Buffer).toString()).toBe("sealed:shared-pass");
    expect(params[4]).toBe("hash_shared@example.com");
  });

  it("missing serviceId → 400", async () => {
    const req = makePostRequest({ email: "a@b.com", password: "pass" });
    const res = await POST(req as any, { params: Promise.resolve({}) });
    expect(res.status).toBe(400);
  });

  it("missing email → 400", async () => {
    const req = makePostRequest({ serviceId: "netflix", password: "pass" });
    const res = await POST(req as any, { params: Promise.resolve({}) });
    expect(res.status).toBe(400);
  });

  it("missing password → 400", async () => {
    const req = makePostRequest({ serviceId: "netflix", email: "a@b.com" });
    const res = await POST(req as any, { params: Promise.resolve({}) });
    expect(res.status).toBe(400);
  });

  it("unsupported service → 400", async () => {
    mockRenegedClean();
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const req = makePostRequest({
      serviceId: "nonexistent",
      email: "a@b.com",
      password: "pass",
    });
    const res = await POST(req as any, { params: Promise.resolve({}) });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/unsupported/i);
  });

  it("rejects reneged email with 403 and debt amount", async () => {
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ total_debt_sats: 6000 }])
    );

    const req = makePostRequest({
      serviceId: "netflix",
      email: "deadbeat@example.com",
      password: "pass",
    });
    const res = await POST(req as any, { params: Promise.resolve({}) });
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toContain("Outstanding balance");
    expect(data.error).toContain("6000");
    expect(data.debt_sats).toBe(6000);
  });

  it("invalid JSON → 400", async () => {
    const req = new Request("http://localhost/api/credentials", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    const res = await POST(req as any, { params: Promise.resolve({}) });
    expect(res.status).toBe(400);
  });

  // Finding 4.1: database error on POST (reneged check throws)
  it("returns 500 when database query throws during reneged check", async () => {
    vi.mocked(query).mockRejectedValueOnce(new Error("Connection refused"));

    const req = makePostRequest({
      serviceId: "netflix",
      email: "user@example.com",
      password: "hunter2",
    });
    const res = await POST(req as any, { params: Promise.resolve({}) });
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.error).toBe("Internal server error");
  });
});

describe("GET /api/credentials", () => {
  it("returns serviceId and serviceName for all stored credentials (no email)", async () => {
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([
        {
          service_id: "netflix",
          service_name: "Netflix",
        },
        {
          service_id: "hulu",
          service_name: "Hulu",
        },
      ])
    );

    const req = new Request("http://localhost/api/credentials");
    const res = await GET(req as any, { params: Promise.resolve({}) });
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.credentials).toHaveLength(2);
    expect(data.credentials[0]).toEqual({
      serviceId: "netflix",
      serviceName: "Netflix",
    });
    // No email field returned
    expect(data.credentials[0].email).toBeUndefined();
  });

  it("returns empty array when no credentials exist", async () => {
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const req = new Request("http://localhost/api/credentials");
    const res = await GET(req as any, { params: Promise.resolve({}) });
    const data = await res.json();
    expect(data.credentials).toEqual([]);
  });

  // Finding 4.1: database connection failure on GET (no try/catch in route)
  it("returns 500 when database query throws", async () => {
    vi.mocked(query).mockRejectedValueOnce(new Error("Connection refused"));

    const req = new Request("http://localhost/api/credentials");
    const res = await GET(req as any, { params: Promise.resolve({}) });
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.error).toBe("Internal server error");
  });
});
