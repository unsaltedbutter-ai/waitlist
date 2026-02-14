import { describe, it, expect, beforeEach, vi } from "vitest";
import { TEST_JWT_SECRET } from "@/__test-utils__/fixtures";

let createToken: typeof import("@/lib/auth").createToken;
let verifyToken: typeof import("@/lib/auth").verifyToken;
let hashPassword: typeof import("@/lib/auth").hashPassword;
let verifyPassword: typeof import("@/lib/auth").verifyPassword;
let authenticateRequest: typeof import("@/lib/auth").authenticateRequest;

beforeEach(async () => {
  vi.unstubAllEnvs();
  vi.stubEnv("JWT_SECRET", TEST_JWT_SECRET);
  const mod = await import("@/lib/auth");
  createToken = mod.createToken;
  verifyToken = mod.verifyToken;
  hashPassword = mod.hashPassword;
  verifyPassword = mod.verifyPassword;
  authenticateRequest = mod.authenticateRequest;
});

describe("JWT tokens", () => {
  it("createToken → verifyToken round-trip", async () => {
    const token = await createToken("user-123");
    const result = await verifyToken(token);
    expect(result).toEqual({ userId: "user-123" });
  });

  it("verifyToken returns null for garbage", async () => {
    const result = await verifyToken("not-a-jwt");
    expect(result).toBeNull();
  });

  it("verifyToken returns null for wrong secret", async () => {
    const token = await createToken("user-123");
    // Sign was done with TEST_JWT_SECRET; verify with different secret
    vi.stubEnv("JWT_SECRET", "completely-different-secret");
    const result = await verifyToken(token);
    expect(result).toBeNull();
  });

  it("verifyToken returns null for expired token", async () => {
    // Create a token that's already expired using jose directly
    const { SignJWT } = await import("jose");
    const secret = new TextEncoder().encode(TEST_JWT_SECRET);
    const token = await new SignJWT({ sub: "user-123" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(Math.floor(Date.now() / 1000) - 86400 * 2) // 2 days ago
      .setExpirationTime(Math.floor(Date.now() / 1000) - 86400) // expired 1 day ago
      .sign(secret);

    const result = await verifyToken(token);
    expect(result).toBeNull();
  });
});

describe("password hashing", () => {
  it("hashPassword → verifyPassword round-trip", async () => {
    const hashed = await hashPassword("correct-horse-battery");
    const ok = await verifyPassword("correct-horse-battery", hashed);
    expect(ok).toBe(true);
  });

  it("verifyPassword rejects wrong password", async () => {
    const hashed = await hashPassword("correct-horse-battery");
    const ok = await verifyPassword("wrong-password", hashed);
    expect(ok).toBe(false);
  });

  it("hashPassword produces different hashes for same input (salt)", async () => {
    const a = await hashPassword("same-password");
    const b = await hashPassword("same-password");
    expect(a).not.toBe(b);
  });
});

describe("authenticateRequest", () => {
  it("extracts userId from valid Bearer token", async () => {
    const token = await createToken("user-456");
    const req = new Request("http://localhost/api/test", {
      headers: { Authorization: `Bearer ${token}` },
    });
    // NextRequest is a superset of Request; cast for test
    const userId = await authenticateRequest(req as any);
    expect(userId).toBe("user-456");
  });

  it("returns null without auth header", async () => {
    const req = new Request("http://localhost/api/test");
    const userId = await authenticateRequest(req as any);
    expect(userId).toBeNull();
  });
});
