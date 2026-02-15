import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockQueryResult } from "@/__test-utils__/fixtures";

vi.mock("@/lib/db", () => ({
  query: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({
  authenticateRequest: vi.fn(),
}));
vi.mock("@/lib/capacity", () => ({
  isAtCapacity: vi.fn(),
  generateInviteCode: vi.fn(),
}));

import { query } from "@/lib/db";
import { authenticateRequest } from "@/lib/auth";
import { isAtCapacity, generateInviteCode } from "@/lib/capacity";
import { POST } from "../route";

function makeRequest(body: object): Request {
  return new Request("http://localhost/api/operator/invite", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.mocked(query).mockReset();
  vi.mocked(authenticateRequest).mockReset();
  vi.mocked(isAtCapacity).mockReset();
  vi.mocked(generateInviteCode).mockReset();
  vi.stubEnv("OPERATOR_USER_ID", "operator-123");
});

describe("POST /api/operator/invite", () => {
  it("generates invite for waitlist entry -> 201", async () => {
    vi.mocked(authenticateRequest).mockResolvedValueOnce("operator-123");
    vi.mocked(isAtCapacity).mockResolvedValueOnce(false);
    vi.mocked(generateInviteCode).mockReturnValueOnce("TESTCODE1234");

    // SELECT waitlist entry
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ id: "wl-1", invited: false }])
    );
    // UPDATE waitlist (set invite_code + invited)
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const res = await POST(
      makeRequest({ waitlistId: "wl-1" }) as any,
      { params: Promise.resolve({}) }
    );
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.code).toBe("TESTCODE1234");
    expect(data.inviteLink).toContain("TESTCODE1234");
  });

  it("waitlist entry already invited -> 409", async () => {
    vi.mocked(authenticateRequest).mockResolvedValueOnce("operator-123");
    vi.mocked(isAtCapacity).mockResolvedValueOnce(false);

    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ id: "wl-1", invited: true }])
    );

    const res = await POST(
      makeRequest({ waitlistId: "wl-1" }) as any,
      { params: Promise.resolve({}) }
    );
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.error).toMatch(/[Aa]lready invited/);
  });

  it("at capacity -> 403", async () => {
    vi.mocked(authenticateRequest).mockResolvedValueOnce("operator-123");
    vi.mocked(isAtCapacity).mockResolvedValueOnce(true);

    const res = await POST(
      makeRequest({ waitlistId: "wl-1" }) as any,
      { params: Promise.resolve({}) }
    );
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toMatch(/[Cc]apacity/);
  });

  it("non-operator user -> 403", async () => {
    vi.mocked(authenticateRequest).mockResolvedValueOnce("not-operator-id");

    const res = await POST(
      makeRequest({ waitlistId: "wl-1" }) as any,
      { params: Promise.resolve({}) }
    );
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toMatch(/[Ff]orbidden/);
  });

  it("unauthenticated -> 401", async () => {
    vi.mocked(authenticateRequest).mockResolvedValueOnce(null as any);

    const res = await POST(
      makeRequest({ waitlistId: "wl-1" }) as any,
      { params: Promise.resolve({}) }
    );
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.error).toMatch(/[Uu]nauthorized/);
  });
});
