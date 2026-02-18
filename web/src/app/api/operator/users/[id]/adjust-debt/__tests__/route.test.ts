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
import { POST } from "../route";

const USER_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

function makeRequest(body: unknown): Request {
  return new Request(
    `http://localhost/api/operator/users/${USER_ID}/adjust-debt`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  );
}

beforeEach(() => {
  vi.mocked(query).mockReset();
});

describe("POST /api/operator/users/[id]/adjust-debt", () => {
  it("adjusts debt and writes audit log", async () => {
    // 1. User lookup
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ id: USER_ID, debt_sats: 6000 }])
    );
    // 2. Update
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([
        {
          id: USER_ID,
          nostr_npub: "npub1test",
          debt_sats: 0,
          onboarded_at: "2026-01-01T00:00:00Z",
          created_at: "2026-01-01T00:00:00Z",
        },
      ])
    );
    // 3. Audit log insert
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const res = await POST(
      makeRequest({ debt_sats: 0, reason: "Forgiven by operator" }) as any,
      { params: Promise.resolve({ id: USER_ID }) }
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.user.debt_sats).toBe(0);

    // Verify audit log was written
    const auditCall = vi.mocked(query).mock.calls[2];
    expect(auditCall[0]).toContain("operator_audit_log");
    const detail = JSON.parse(auditCall[1]![3] as string);
    expect(detail.previous_debt_sats).toBe(6000);
    expect(detail.new_debt_sats).toBe(0);
    expect(detail.reason).toBe("Forgiven by operator");
  });

  it("returns 404 when user not found", async () => {
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const res = await POST(
      makeRequest({ debt_sats: 0, reason: "test" }) as any,
      { params: Promise.resolve({ id: USER_ID }) }
    );
    expect(res.status).toBe(404);
  });

  it("returns 400 for negative debt_sats", async () => {
    const res = await POST(
      makeRequest({ debt_sats: -100, reason: "test" }) as any,
      { params: Promise.resolve({ id: USER_ID }) }
    );
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/non-negative integer/);
  });

  it("returns 400 for non-integer debt_sats", async () => {
    const res = await POST(
      makeRequest({ debt_sats: 1.5, reason: "test" }) as any,
      { params: Promise.resolve({ id: USER_ID }) }
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 for string debt_sats", async () => {
    const res = await POST(
      makeRequest({ debt_sats: "zero", reason: "test" }) as any,
      { params: Promise.resolve({ id: USER_ID }) }
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when reason is missing", async () => {
    const res = await POST(
      makeRequest({ debt_sats: 0 }) as any,
      { params: Promise.resolve({ id: USER_ID }) }
    );
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/reason/);
  });

  it("returns 400 when reason is empty string", async () => {
    const res = await POST(
      makeRequest({ debt_sats: 0, reason: "   " }) as any,
      { params: Promise.resolve({ id: USER_ID }) }
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when id param is missing", async () => {
    const res = await POST(
      makeRequest({ debt_sats: 0, reason: "test" }) as any,
      { params: Promise.resolve({}) }
    );
    expect(res.status).toBe(400);
  });
});
