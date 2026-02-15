import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockQueryResult } from "@/__test-utils__/fixtures";

vi.mock("@/lib/db", () => ({
  query: vi.fn(),
}));
vi.mock("@/lib/crypto", () => ({
  encrypt: vi.fn((val: string) => Buffer.from(`enc:${val}`)),
  decrypt: vi.fn((buf: Buffer) => buf.toString().replace("enc:", "")),
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
import { encrypt } from "@/lib/crypto";
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
  vi.mocked(encrypt).mockClear();
});

describe("POST /api/credentials", () => {
  it("saves credentials for a valid service → 201", async () => {
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

    // Verify encrypt was called with the right values
    expect(encrypt).toHaveBeenCalledWith("user@example.com");
    expect(encrypt).toHaveBeenCalledWith("hunter2");
  });

  it("stores the exact credentials passed, not stale values", async () => {
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([{ id: "netflix" }]));
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const req = makePostRequest({
      serviceId: "netflix",
      email: "shared@example.com",
      password: "shared-pass",
    });
    await POST(req as any, { params: Promise.resolve({}) });

    // The INSERT query should receive the encrypted shared creds
    const insertCall = vi.mocked(query).mock.calls[1];
    const params = insertCall[1] as unknown[];
    expect(params[0]).toBe("test-user");
    expect(params[1]).toBe("netflix");
    // Encrypted values contain the original strings (our mock prepends "enc:")
    expect(Buffer.from(params[2] as Buffer).toString()).toBe("enc:shared@example.com");
    expect(Buffer.from(params[3] as Buffer).toString()).toBe("enc:shared-pass");
  });

  it("upserts on conflict — second POST overwrites first", async () => {
    // First save
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

    // The second INSERT's params should have the new creds
    const lastInsert = vi.mocked(query).mock.calls[3];
    const params = lastInsert[1] as unknown[];
    expect(Buffer.from(params[2] as Buffer).toString()).toBe("enc:shared@example.com");
    expect(Buffer.from(params[3] as Buffer).toString()).toBe("enc:shared-pass");
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

  it("invalid JSON → 400", async () => {
    const req = new Request("http://localhost/api/credentials", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    const res = await POST(req as any, { params: Promise.resolve({}) });
    expect(res.status).toBe(400);
  });
});

describe("GET /api/credentials", () => {
  it("returns decrypted emails for all stored credentials", async () => {
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([
        {
          service_id: "netflix",
          service_name: "Netflix",
          email_enc: Buffer.from("enc:user@example.com"),
        },
        {
          service_id: "hulu",
          service_name: "Hulu",
          email_enc: Buffer.from("enc:user@example.com"),
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
      email: "user@example.com",
    });
  });

  it("returns empty array when no credentials exist", async () => {
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const req = new Request("http://localhost/api/credentials");
    const res = await GET(req as any, { params: Promise.resolve({}) });
    const data = await res.json();
    expect(data.credentials).toEqual([]);
  });
});
