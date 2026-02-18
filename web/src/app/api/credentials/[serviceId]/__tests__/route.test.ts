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

import { query } from "@/lib/db";
import { DELETE } from "../route";

function makeRequest(): Request {
  return new Request("http://localhost/api/credentials/netflix", {
    method: "DELETE",
  });
}

beforeEach(() => {
  vi.mocked(query).mockReset();
});

describe("DELETE /api/credentials/[serviceId]", () => {
  it("deletes credentials and returns success", async () => {
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ id: "cred-uuid-1" }])
    );

    const res = await DELETE(makeRequest() as any, {
      params: Promise.resolve({ serviceId: "netflix" }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
  });

  it("passes correct userId and serviceId to delete query", async () => {
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ id: "cred-uuid-1" }])
    );

    await DELETE(makeRequest() as any, {
      params: Promise.resolve({ serviceId: "hulu" }),
    });

    expect(query).toHaveBeenCalledOnce();
    const [sql, params] = vi.mocked(query).mock.calls[0];
    expect(sql).toContain("DELETE FROM streaming_credentials");
    expect(sql).toContain("user_id = $1");
    expect(sql).toContain("service_id = $2");
    expect(params).toEqual(["test-user", "hulu"]);
  });

  it("returns 404 when no credentials found for the service", async () => {
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const res = await DELETE(makeRequest() as any, {
      params: Promise.resolve({ serviceId: "netflix" }),
    });
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toMatch(/not found/i);
  });

  it("scopes delete to the authenticated user (cannot delete another user's creds)", async () => {
    // The DELETE query includes user_id = $1, so even if serviceId matches,
    // it will not delete another user's credentials. The mock withAuth always
    // injects "test-user", so the query is scoped to that user.
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const res = await DELETE(makeRequest() as any, {
      params: Promise.resolve({ serviceId: "netflix" }),
    });

    // Returns 404 because the credential belongs to a different user
    expect(res.status).toBe(404);

    // Verify the query was called with the authenticated user's ID
    const params = vi.mocked(query).mock.calls[0][1] as unknown[];
    expect(params[0]).toBe("test-user");
  });

  it("returns 400 when serviceId param is missing", async () => {
    const res = await DELETE(makeRequest() as any, {
      params: Promise.resolve({}),
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/missing/i);
  });
});
