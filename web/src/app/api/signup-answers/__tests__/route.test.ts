import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockQueryResult } from "@/__test-utils__/fixtures";

vi.mock("@/lib/db", () => ({
  query: vi.fn(),
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
vi.mock("@/lib/crypto", () => ({
  encrypt: vi.fn((plaintext: string) => Buffer.from(`encrypted:${plaintext}`)),
  decrypt: vi.fn((data: Buffer) => {
    const str = data.toString();
    return str.startsWith("encrypted:") ? str.slice("encrypted:".length) : str;
  }),
}));

import { query } from "@/lib/db";
import { encrypt, decrypt } from "@/lib/crypto";
import { POST, GET } from "../route";

function makePostRequest(body: object): Request {
  return new Request("http://localhost/api/signup-answers", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function makeGetRequest(): Request {
  return new Request("http://localhost/api/signup-answers", { method: "GET" });
}

beforeEach(() => {
  vi.mocked(query).mockReset();
  vi.mocked(encrypt).mockClear();
  vi.mocked(decrypt).mockClear();
});

describe("POST /api/signup-answers", () => {
  it("saves encrypted answers", async () => {
    const answers = { full_name: "***REDACTED***", zip_code: "***REDACTED***" };

    // SELECT valid question IDs
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([
        { id: "full_name" },
        { id: "zip_code" },
        { id: "birthdate" },
        { id: "gender" },
      ])
    );
    // UPDATE users
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const res = await POST(
      makePostRequest({ answers }) as any,
      { params: Promise.resolve({}) }
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);

    // Verify encrypt was called with the JSON-stringified answers
    expect(encrypt).toHaveBeenCalledWith(JSON.stringify(answers));

    // Verify UPDATE query was called
    const updateCall = vi.mocked(query).mock.calls[1];
    expect(updateCall[0]).toContain("UPDATE users");
    expect(updateCall[1]![1]).toBe("test-user");
  });

  it("rejects invalid question keys with 400", async () => {
    // SELECT valid question IDs
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([
        { id: "full_name" },
        { id: "zip_code" },
        { id: "birthdate" },
        { id: "gender" },
      ])
    );

    const res = await POST(
      makePostRequest({ answers: { bogus_key: "nope" } }) as any,
      { params: Promise.resolve({}) }
    );
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/bogus_key/);
  });

  it("rejects empty answers with 400", async () => {
    const res = await POST(
      makePostRequest({ answers: {} }) as any,
      { params: Promise.resolve({}) }
    );
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/empty/i);
  });

  it("rejects missing answers field with 400", async () => {
    const res = await POST(
      makePostRequest({ something: "else" }) as any,
      { params: Promise.resolve({}) }
    );
    expect(res.status).toBe(400);
  });

  it("rejects invalid JSON with 400", async () => {
    const req = new Request("http://localhost/api/signup-answers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    const res = await POST(req as any, { params: Promise.resolve({}) });
    expect(res.status).toBe(400);
  });
});

describe("GET /api/signup-answers", () => {
  it("decrypts and returns stored answers", async () => {
    const answers = { full_name: "***REDACTED***", zip_code: "***REDACTED***" };
    const encryptedBuf = Buffer.from(`encrypted:${JSON.stringify(answers)}`);

    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ signup_answers_enc: encryptedBuf }])
    );

    const res = await GET(
      makeGetRequest() as any,
      { params: Promise.resolve({}) }
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.answers).toEqual(answers);
    expect(decrypt).toHaveBeenCalled();
  });

  it("returns empty object when signup_answers_enc is null", async () => {
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ signup_answers_enc: null }])
    );

    const res = await GET(
      makeGetRequest() as any,
      { params: Promise.resolve({}) }
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.answers).toEqual({});
    expect(decrypt).not.toHaveBeenCalled();
  });

  it("returns empty object when user not found", async () => {
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const res = await GET(
      makeGetRequest() as any,
      { params: Promise.resolve({}) }
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.answers).toEqual({});
  });
});
