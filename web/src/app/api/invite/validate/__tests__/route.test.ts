import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/capacity", () => ({
  validateInviteCode: vi.fn(),
}));

import { validateInviteCode } from "@/lib/capacity";
import { POST } from "../route";

function makeRequest(body: object): Request {
  return new Request("http://localhost/api/invite/validate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.mocked(validateInviteCode).mockReset();
});

describe("POST /api/invite/validate", () => {
  it("valid code → { valid: true }", async () => {
    vi.mocked(validateInviteCode).mockResolvedValueOnce({
      valid: true,
      codeRow: {
        id: "code-1",
        owner_id: "user-1",
        status: "active",
        expires_at: null,
      },
    });

    const res = await POST(makeRequest({ code: "VALIDCODE123" }) as any);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({ valid: true });
  });

  it("nonexistent code → { valid: false }", async () => {
    vi.mocked(validateInviteCode).mockResolvedValueOnce({ valid: false });

    const res = await POST(makeRequest({ code: "DOESNOTEXIST" }) as any);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({ valid: false });
  });

  it("expired code → { valid: false, expired: true }", async () => {
    vi.mocked(validateInviteCode).mockResolvedValueOnce({
      valid: false,
      expired: true,
    });

    const res = await POST(makeRequest({ code: "EXPIREDCODE1" }) as any);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({ valid: false, expired: true });
  });

  it("used code → { valid: false }", async () => {
    vi.mocked(validateInviteCode).mockResolvedValueOnce({ valid: false });

    const res = await POST(makeRequest({ code: "USEDCODE1234" }) as any);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({ valid: false });
  });

  it("missing code in body → 400", async () => {
    const res = await POST(makeRequest({}) as any);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/invite code/i);
  });
});
