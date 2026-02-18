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
    `http://localhost/api/operator/users/${USER_ID}/delete`,
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

describe("POST /api/operator/users/[id]/delete", () => {
  it("deletes user with zero debt and writes audit log", async () => {
    // 1. User lookup
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ id: USER_ID, nostr_npub: "npub1test", debt_sats: 0 }])
    );
    // 2. DELETE users
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));
    // 3. DELETE waitlist
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));
    // 4. Audit log insert
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const res = await POST(
      makeRequest({ reason: "User requested via support" }) as any,
      { params: Promise.resolve({ id: USER_ID }) }
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);

    // Verify CASCADE delete was called
    const deleteCall = vi.mocked(query).mock.calls[1];
    expect(deleteCall[0]).toContain("DELETE FROM users");
    expect(deleteCall[1]).toEqual([USER_ID]);

    // Verify waitlist cleanup
    const waitlistCall = vi.mocked(query).mock.calls[2];
    expect(waitlistCall[0]).toContain("DELETE FROM waitlist");
    expect(waitlistCall[1]).toEqual(["npub1test"]);

    // Verify audit log
    const auditCall = vi.mocked(query).mock.calls[3];
    expect(auditCall[0]).toContain("operator_audit_log");
    const detail = JSON.parse(auditCall[1]![3] as string);
    expect(detail.nostr_npub).toBe("npub1test");
    expect(detail.reason).toBe("User requested via support");
  });

  it("returns 402 when user has outstanding debt", async () => {
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ id: USER_ID, nostr_npub: "npub1test", debt_sats: 3000 }])
    );

    const res = await POST(
      makeRequest({ reason: "test" }) as any,
      { params: Promise.resolve({ id: USER_ID }) }
    );
    expect(res.status).toBe(402);
    const data = await res.json();
    expect(data.debt_sats).toBe(3000);
    expect(data.error).toMatch(/3000 sats/);
  });

  it("returns 404 when user not found", async () => {
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const res = await POST(
      makeRequest({ reason: "test" }) as any,
      { params: Promise.resolve({ id: USER_ID }) }
    );
    expect(res.status).toBe(404);
  });

  it("returns 400 when reason is missing", async () => {
    const res = await POST(
      makeRequest({}) as any,
      { params: Promise.resolve({ id: USER_ID }) }
    );
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/reason/);
  });

  it("returns 400 when reason is whitespace-only", async () => {
    const res = await POST(
      makeRequest({ reason: "  " }) as any,
      { params: Promise.resolve({ id: USER_ID }) }
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when id param is missing", async () => {
    const res = await POST(
      makeRequest({ reason: "test" }) as any,
      { params: Promise.resolve({}) }
    );
    expect(res.status).toBe(400);
  });
});
