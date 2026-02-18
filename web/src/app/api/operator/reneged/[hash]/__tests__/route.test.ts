import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockQueryResult } from "@/__test-utils__/fixtures";

vi.mock("@/lib/db", () => ({
  query: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({
  authenticateRequest: vi.fn().mockResolvedValue("operator-user-id"),
}));
vi.mock("@/lib/operator-auth", () => ({
  withOperator: vi.fn((handler: Function) => {
    return async (req: Request, segmentData: any) => {
      const params = segmentData?.params ? await segmentData.params : undefined;
      return handler(req, { userId: "operator-user-id", params });
    };
  }),
}));

import { query } from "@/lib/db";
import { DELETE } from "../route";

const EMAIL_HASH = "abc123def456";

function makeRequest(body: unknown): Request {
  return new Request(
    `http://localhost/api/operator/reneged/${EMAIL_HASH}`,
    {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  );
}

beforeEach(() => {
  vi.mocked(query).mockReset();
});

describe("DELETE /api/operator/reneged/[hash]", () => {
  it("deletes reneged email entry and writes audit log", async () => {
    // 1. Lookup
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ email_hash: EMAIL_HASH, total_debt_sats: 9000 }])
    );
    // 2. Delete
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));
    // 3. Audit log
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const res = await DELETE(
      makeRequest({ reason: "False positive" }) as any,
      { params: Promise.resolve({ hash: EMAIL_HASH }) }
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);

    // Verify delete was called
    const deleteCall = vi.mocked(query).mock.calls[1];
    expect(deleteCall[0]).toContain("DELETE FROM reneged_emails");
    expect(deleteCall[1]).toEqual([EMAIL_HASH]);

    // Verify audit log
    const auditCall = vi.mocked(query).mock.calls[2];
    expect(auditCall[0]).toContain("operator_audit_log");
    const detail = JSON.parse(auditCall[1]![3] as string);
    expect(detail.total_debt_sats).toBe(9000);
    expect(detail.reason).toBe("False positive");
  });

  it("returns 404 when entry not found", async () => {
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const res = await DELETE(
      makeRequest({ reason: "test" }) as any,
      { params: Promise.resolve({ hash: "nonexistent" }) }
    );
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toMatch(/not found/);
  });

  it("returns 400 when reason is missing", async () => {
    const res = await DELETE(
      makeRequest({}) as any,
      { params: Promise.resolve({ hash: EMAIL_HASH }) }
    );
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/reason/);
  });

  it("returns 400 when reason is whitespace-only", async () => {
    const res = await DELETE(
      makeRequest({ reason: "   " }) as any,
      { params: Promise.resolve({ hash: EMAIL_HASH }) }
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when hash param is missing", async () => {
    const res = await DELETE(
      makeRequest({ reason: "test" }) as any,
      { params: Promise.resolve({}) }
    );
    expect(res.status).toBe(400);
  });
});
