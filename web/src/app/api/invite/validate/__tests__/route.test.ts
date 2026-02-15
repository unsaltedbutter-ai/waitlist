import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockQueryResult } from "@/__test-utils__/fixtures";

vi.mock("@/lib/db", () => ({
  query: vi.fn(),
}));

import { query } from "@/lib/db";
import { POST } from "../route";

function makeRequest(body: object): Request {
  return new Request("http://localhost/api/invite/validate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.mocked(query).mockReset();
});

describe("POST /api/invite/validate", () => {
  it("valid code → { valid: true }", async () => {
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ id: "wl-1" }])
    );

    const res = await POST(makeRequest({ code: "VALIDCODE123" }) as any);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({ valid: true });
  });

  it("nonexistent code → { valid: false }", async () => {
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const res = await POST(makeRequest({ code: "DOESNOTEXIST" }) as any);
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
