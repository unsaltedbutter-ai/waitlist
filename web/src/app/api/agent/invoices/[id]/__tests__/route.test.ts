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
import { GET } from "../route";

function makeRequest(): Request {
  return new Request("http://localhost/api/agent/invoices/inv-1", {
    method: "GET",
  });
}

beforeEach(() => {
  vi.mocked(query).mockReset();
});

const validUuid = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
const validUuid2 = "b2c3d4e5-f6a7-8901-bcde-f12345678901";
const validUuid3 = "c3d4e5f6-a7b8-9012-cdef-123456789012";

describe("GET /api/agent/invoices/[id]", () => {
  it("happy path: returns invoice details", async () => {
    // Job lookup by invoice_id
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{
        id: "job-uuid-1",
        status: "active",
        amount_sats: 3000,
        invoice_id: validUuid,
      }])
    );
    // Transaction lookup
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{
        status: "invoice_sent",
        amount_sats: 3000,
        paid_at: null,
      }])
    );

    const req = makeRequest();
    const res = await GET(req as any, { params: Promise.resolve({ id: validUuid }) });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.invoice_id).toBe(validUuid);
    expect(data.status).toBe("invoice_sent");
    expect(data.amount_sats).toBe(3000);
    expect(data.paid_at).toBeNull();
  });

  it("paid invoice: returns paid status with paid_at", async () => {
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{
        id: "job-uuid-1",
        status: "completed_paid",
        amount_sats: 3000,
        invoice_id: validUuid2,
      }])
    );
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{
        status: "paid",
        amount_sats: 3000,
        paid_at: "2026-02-18T12:00:00Z",
      }])
    );

    const req = makeRequest();
    const res = await GET(req as any, { params: Promise.resolve({ id: validUuid2 }) });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe("paid");
    expect(data.paid_at).toBe("2026-02-18T12:00:00Z");
  });

  it("invoice not found: returns 404", async () => {
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const req = makeRequest();
    const res = await GET(req as any, { params: Promise.resolve({ id: validUuid }) });

    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toMatch(/Invoice not found/);
  });

  it("job exists but no transaction: returns unknown status", async () => {
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{
        id: "job-uuid-1",
        status: "active",
        amount_sats: 3000,
        invoice_id: validUuid3,
      }])
    );
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const req = makeRequest();
    const res = await GET(req as any, { params: Promise.resolve({ id: validUuid3 }) });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe("unknown");
    expect(data.amount_sats).toBe(3000);
  });

  it("invalid UUID format: returns 400", async () => {
    const req = makeRequest();
    const res = await GET(req as any, { params: Promise.resolve({ id: "not-a-uuid" }) });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/Invalid invoice ID format/);
  });

  it("SQL injection attempt in ID: returns 400", async () => {
    const req = makeRequest();
    const res = await GET(req as any, { params: Promise.resolve({ id: "'; DROP TABLE jobs;--" }) });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/Invalid invoice ID format/);
  });
});
