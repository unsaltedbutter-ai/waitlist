import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock auth module
const mockAuthenticateRequest = vi.fn();
vi.mock("@/lib/auth", () => ({
  authenticateRequest: (...args: unknown[]) => mockAuthenticateRequest(...args),
}));

let withOperator: typeof import("@/lib/operator-auth").withOperator;

beforeEach(async () => {
  vi.unstubAllEnvs();
  mockAuthenticateRequest.mockReset();

  // Reset the module registry to pick up fresh env vars
  vi.resetModules();

  const mod = await import("@/lib/operator-auth");
  withOperator = mod.withOperator;
});

function makeRequest(path = "/api/operator/test"): Request {
  return new Request(`http://localhost${path}`, {
    method: "GET",
    headers: { authorization: "Bearer valid-token" },
  });
}

describe("withOperator", () => {
  describe("when OPERATOR_USER_ID is a UUID", () => {
    it("allows the operator through and calls the handler", async () => {
      vi.stubEnv("OPERATOR_USER_ID", "uuid-operator-123");
      mockAuthenticateRequest.mockResolvedValue("uuid-operator-123");

      const handler = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { status: 200 })
      );
      const wrapped = withOperator(handler);

      const req = makeRequest();
      const res = await wrapped(req as any, {
        params: Promise.resolve({ serviceId: "netflix" }),
      });

      expect(res.status).toBe(200);
      expect(handler).toHaveBeenCalledOnce();
      expect(handler.mock.calls[0][1].userId).toBe("uuid-operator-123");
      expect(handler.mock.calls[0][1].params).toEqual({ serviceId: "netflix" });
    });
  });

  describe("auth rejection", () => {
    it("returns 401 when authenticateRequest returns null", async () => {
      vi.stubEnv("OPERATOR_USER_ID", "uuid-operator-123");
      mockAuthenticateRequest.mockResolvedValue(null);

      const handler = vi.fn();
      const wrapped = withOperator(handler);

      const res = await wrapped(makeRequest() as any, {
        params: Promise.resolve({}),
      });

      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toBe("Unauthorized");
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe("non-operator user rejection", () => {
    it("returns 403 when authenticated user is not the operator", async () => {
      vi.stubEnv("OPERATOR_USER_ID", "uuid-operator-123");
      mockAuthenticateRequest.mockResolvedValue("uuid-regular-user");

      const handler = vi.fn();
      const wrapped = withOperator(handler);

      const res = await wrapped(makeRequest() as any, {
        params: Promise.resolve({}),
      });

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toBe("Forbidden");
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe("OPERATOR_USER_ID not set", () => {
    it("returns 403 when OPERATOR_USER_ID is not configured", async () => {
      // Do not set OPERATOR_USER_ID (it will be undefined)
      mockAuthenticateRequest.mockResolvedValue("some-user-id");

      const handler = vi.fn();
      const wrapped = withOperator(handler);

      const res = await wrapped(makeRequest() as any, {
        params: Promise.resolve({}),
      });

      expect(res.status).toBe(403);
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe("reads env var on each call (no stale cache)", () => {
    it("picks up a changed OPERATOR_USER_ID between calls", async () => {
      vi.stubEnv("OPERATOR_USER_ID", "first-uuid");
      mockAuthenticateRequest.mockResolvedValue("first-uuid");

      const handler = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { status: 200 })
      );
      const wrapped = withOperator(handler);

      // First call with first-uuid
      const res1 = await wrapped(makeRequest() as any, {
        params: Promise.resolve({}),
      });
      expect(res1.status).toBe(200);

      // Change operator and authenticated user
      vi.stubEnv("OPERATOR_USER_ID", "second-uuid");
      mockAuthenticateRequest.mockResolvedValue("second-uuid");

      const res2 = await wrapped(makeRequest() as any, {
        params: Promise.resolve({}),
      });
      expect(res2.status).toBe(200);
      expect(handler).toHaveBeenCalledTimes(2);
    });
  });
});
