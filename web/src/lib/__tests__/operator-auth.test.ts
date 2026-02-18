import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock db module before importing the module under test
const mockQuery = vi.fn();
vi.mock("@/lib/db", () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}));

// Mock auth module
const mockAuthenticateRequest = vi.fn();
vi.mock("@/lib/auth", () => ({
  authenticateRequest: (...args: unknown[]) => mockAuthenticateRequest(...args),
}));

// We need a fresh module for each test because of the module-level cache.
// Use resetModules + dynamic import to get fresh state.
let resolveOperatorId: () => Promise<string | null>;
let withOperator: typeof import("@/lib/operator-auth").withOperator;

beforeEach(async () => {
  vi.unstubAllEnvs();
  mockQuery.mockReset();
  mockAuthenticateRequest.mockReset();

  // Reset the module registry so the cached variables reset
  vi.resetModules();

  const mod = await import("@/lib/operator-auth");
  // resolveOperatorId is not exported, so we test it indirectly through withOperator.
  // But we can also access it via the module internals if needed.
  // Since it is not exported, we will test its behavior through withOperator.
  withOperator = mod.withOperator;

  // We also need a way to call resolveOperatorId directly for caching tests.
  // Since it is not exported, we will test caching through repeated withOperator calls.
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
      // UUID path should not query the DB
      expect(mockQuery).not.toHaveBeenCalled();
    });
  });

  describe("when OPERATOR_USER_ID is an email", () => {
    it("queries DB and allows matching user", async () => {
      vi.stubEnv("OPERATOR_USER_ID", "admin@unsaltedbutter.ai");
      mockAuthenticateRequest.mockResolvedValue("uuid-from-db");
      mockQuery.mockResolvedValue({
        rows: [{ id: "uuid-from-db" }],
      });

      const handler = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { status: 200 })
      );
      const wrapped = withOperator(handler);

      const res = await wrapped(makeRequest() as any, {
        params: Promise.resolve({}),
      });

      expect(res.status).toBe(200);
      expect(handler).toHaveBeenCalledOnce();
      expect(mockQuery).toHaveBeenCalledWith(
        "SELECT id FROM users WHERE email = $1",
        ["admin@unsaltedbutter.ai"]
      );
    });

    it("returns null (403) when email lookup finds no user", async () => {
      vi.stubEnv("OPERATOR_USER_ID", "nobody@example.com");
      mockAuthenticateRequest.mockResolvedValue("some-user-id");
      mockQuery.mockResolvedValue({ rows: [] });

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

  describe("caching", () => {
    it("caches the resolved operator ID (second call does not hit DB)", async () => {
      vi.stubEnv("OPERATOR_USER_ID", "cached@example.com");
      mockAuthenticateRequest.mockResolvedValue("cached-uuid");
      mockQuery.mockResolvedValue({ rows: [{ id: "cached-uuid" }] });

      const handler = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { status: 200 })
      );
      const wrapped = withOperator(handler);

      // First call: should query DB
      await wrapped(makeRequest() as any, { params: Promise.resolve({}) });
      expect(mockQuery).toHaveBeenCalledTimes(1);

      // Second call: should use cache, no additional DB query
      await wrapped(makeRequest() as any, { params: Promise.resolve({}) });
      expect(mockQuery).toHaveBeenCalledTimes(1);
    });

    it("invalidates cache when env var changes", async () => {
      // First: set up with one email
      vi.stubEnv("OPERATOR_USER_ID", "first@example.com");
      mockAuthenticateRequest.mockResolvedValue("first-uuid");
      mockQuery.mockResolvedValue({ rows: [{ id: "first-uuid" }] });

      const handler = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { status: 200 })
      );
      const wrapped = withOperator(handler);

      await wrapped(makeRequest() as any, { params: Promise.resolve({}) });
      expect(mockQuery).toHaveBeenCalledTimes(1);

      // Change the env var to a different email
      vi.stubEnv("OPERATOR_USER_ID", "second@example.com");
      mockAuthenticateRequest.mockResolvedValue("second-uuid");
      mockQuery.mockResolvedValue({ rows: [{ id: "second-uuid" }] });

      await wrapped(makeRequest() as any, { params: Promise.resolve({}) });
      // Should have queried DB again because the source changed
      expect(mockQuery).toHaveBeenCalledTimes(2);
      expect(mockQuery).toHaveBeenLastCalledWith(
        "SELECT id FROM users WHERE email = $1",
        ["second@example.com"]
      );
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

  describe("DB query failure", () => {
    it("propagates DB errors during email resolution", async () => {
      vi.stubEnv("OPERATOR_USER_ID", "broken@example.com");
      mockAuthenticateRequest.mockResolvedValue("some-user-id");
      mockQuery.mockRejectedValue(new Error("connection refused"));

      const handler = vi.fn();
      const wrapped = withOperator(handler);

      await expect(
        wrapped(makeRequest() as any, { params: Promise.resolve({}) })
      ).rejects.toThrow("connection refused");
      expect(handler).not.toHaveBeenCalled();
    });
  });
});
