import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockQueryResult } from "@/__test-utils__/fixtures";

vi.mock("@/lib/db", () => ({
  query: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({
  authenticateRequest: vi.fn(),
}));

import { query } from "@/lib/db";
import { authenticateRequest } from "@/lib/auth";
import { GET, DELETE } from "../route";

function makeGetRequest(): Request {
  return new Request("http://localhost/api/operator/refunds", {
    method: "GET",
  });
}

function makeDeleteRequest(body: object): Request {
  return new Request("http://localhost/api/operator/refunds", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.mocked(query).mockReset();
  vi.mocked(authenticateRequest).mockReset();
  vi.stubEnv("OPERATOR_USER_ID", "operator-123");
});

describe("GET /api/operator/refunds", () => {
  it("returns pending refunds with amount_sats as number", async () => {
    vi.mocked(authenticateRequest).mockResolvedValueOnce("operator-123");
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([
        {
          id: "r1",
          contact: "user@test.com",
          amount_sats: "5000",
          created_at: "2026-02-14T00:00:00Z",
        },
      ])
    );

    const res = await GET(
      makeGetRequest() as any,
      { params: Promise.resolve({}) }
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.refunds).toHaveLength(1);
    expect(data.refunds[0].id).toBe("r1");
    expect(data.refunds[0].contact).toBe("user@test.com");
    expect(data.refunds[0].amount_sats).toBe(5000);
    expect(typeof data.refunds[0].amount_sats).toBe("number");
  });

  it("non-operator -> 403", async () => {
    vi.mocked(authenticateRequest).mockResolvedValueOnce("not-operator");

    const res = await GET(
      makeGetRequest() as any,
      { params: Promise.resolve({}) }
    );
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toMatch(/[Ff]orbidden/);
  });

  it("unauthenticated -> 401", async () => {
    vi.mocked(authenticateRequest).mockResolvedValueOnce(null as any);

    const res = await GET(
      makeGetRequest() as any,
      { params: Promise.resolve({}) }
    );
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.error).toMatch(/[Uu]nauthorized/);
  });
});

describe("DELETE /api/operator/refunds", () => {
  it("removes single refund -> 200", async () => {
    vi.mocked(authenticateRequest).mockResolvedValueOnce("operator-123");

    const result = mockQueryResult([]);
    (result as any).rowCount = 1;
    vi.mocked(query).mockResolvedValueOnce(result);

    const res = await DELETE(
      makeDeleteRequest({ refundId: "refund-abc" }) as any,
      { params: Promise.resolve({}) }
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
  });

  it("nonexistent refund -> 404", async () => {
    vi.mocked(authenticateRequest).mockResolvedValueOnce("operator-123");

    const result = mockQueryResult([]);
    (result as any).rowCount = 0;
    vi.mocked(query).mockResolvedValueOnce(result);

    const res = await DELETE(
      makeDeleteRequest({ refundId: "nonexistent" }) as any,
      { params: Promise.resolve({}) }
    );
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toMatch(/[Nn]ot found/);
  });

  it("non-operator -> 403", async () => {
    vi.mocked(authenticateRequest).mockResolvedValueOnce("not-operator");

    const res = await DELETE(
      makeDeleteRequest({ refundId: "refund-abc" }) as any,
      { params: Promise.resolve({}) }
    );
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toMatch(/[Ff]orbidden/);
  });

  it("unauthenticated -> 401", async () => {
    vi.mocked(authenticateRequest).mockResolvedValueOnce(null as any);

    const res = await DELETE(
      makeDeleteRequest({ refundId: "refund-abc" }) as any,
      { params: Promise.resolve({}) }
    );
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.error).toMatch(/[Uu]nauthorized/);
  });
});
