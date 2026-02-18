import { describe, it, expect, beforeEach, vi } from "vitest";
import { createHmac, createHash } from "crypto";

// Must use vi.hoisted so the mock fn is available when vi.mock is hoisted
const { mockCheck } = vi.hoisted(() => ({
  mockCheck: vi.fn().mockReturnValue({ allowed: true, remaining: 99 }),
}));

vi.mock("@/lib/rate-limit", () => ({
  createRateLimiter: () => ({ check: mockCheck }),
  getClientIp: () => "127.0.0.1",
}));

import {
  verifyAgentSignature,
  isTimestampValid,
  checkNonce,
  withAgentAuth,
  _resetNonces,
  _nonceCount,
  _fillNonces,
  MAX_NONCES,
} from "@/lib/agent-auth";

const TEST_HMAC_SECRET = "test-hmac-secret-for-unit-tests";

beforeEach(() => {
  vi.stubEnv("AGENT_HMAC_SECRET", TEST_HMAC_SECRET);
  _resetNonces();
  mockCheck.mockReturnValue({ allowed: true, remaining: 99 });
});

function makeSignature(
  timestamp: string,
  nonce: string,
  method: string,
  path: string,
  body: string,
  secret: string = TEST_HMAC_SECRET
): string {
  const bodyHash = createHash("sha256").update(body).digest("hex");
  const message = timestamp + nonce + method + path + bodyHash;
  return createHmac("sha256", secret).update(message).digest("hex");
}

function nowTimestamp(): string {
  return String(Math.floor(Date.now() / 1000));
}

describe("verifyAgentSignature", () => {
  it("returns true for a valid signature", () => {
    const ts = nowTimestamp();
    const nonce = "abc123";
    const method = "GET";
    const path = "/api/agent/jobs/pending";
    const body = "";
    const sig = makeSignature(ts, nonce, method, path, body);

    expect(verifyAgentSignature(method, path, body, ts, nonce, sig)).toBe(true);
  });

  it("returns false for wrong signature", () => {
    const ts = nowTimestamp();
    const nonce = "abc123";
    const method = "GET";
    const path = "/api/agent/jobs/pending";
    const body = "";

    expect(verifyAgentSignature(method, path, body, ts, nonce, "bad-sig")).toBe(false);
  });

  it("returns false for wrong-length signature", () => {
    const ts = nowTimestamp();
    const nonce = "abc123";
    const method = "GET";
    const path = "/api/agent/jobs/pending";
    const body = "";

    // A signature with different length than the expected 64-char hex digest
    expect(verifyAgentSignature(method, path, body, ts, nonce, "short")).toBe(false);
  });

  it("returns false for correct-length but wrong signature", () => {
    const ts = nowTimestamp();
    const nonce = "abc123";
    const method = "GET";
    const path = "/api/agent/jobs/pending";
    const body = "";

    // 64-char hex string that is wrong
    const wrongSig = "a".repeat(64);
    expect(verifyAgentSignature(method, path, body, ts, nonce, wrongSig)).toBe(false);
  });

  it("works with POST body", () => {
    const ts = nowTimestamp();
    const nonce = "xyz789";
    const method = "POST";
    const path = "/api/agent/jobs/claim";
    const body = JSON.stringify({ job_ids: ["id-1", "id-2"] });
    const sig = makeSignature(ts, nonce, method, path, body);

    expect(verifyAgentSignature(method, path, body, ts, nonce, sig)).toBe(true);
  });
});

describe("isTimestampValid", () => {
  it("accepts current timestamp", () => {
    expect(isTimestampValid(nowTimestamp())).toBe(true);
  });

  it("accepts timestamp 30s in the past", () => {
    const ts = String(Math.floor(Date.now() / 1000) - 30);
    expect(isTimestampValid(ts)).toBe(true);
  });

  it("accepts timestamp 30s in the future", () => {
    const ts = String(Math.floor(Date.now() / 1000) + 30);
    expect(isTimestampValid(ts)).toBe(true);
  });

  it("rejects timestamp 90s in the past", () => {
    const ts = String(Math.floor(Date.now() / 1000) - 90);
    expect(isTimestampValid(ts)).toBe(false);
  });

  it("rejects timestamp 90s in the future", () => {
    const ts = String(Math.floor(Date.now() / 1000) + 90);
    expect(isTimestampValid(ts)).toBe(false);
  });

  it("rejects non-numeric timestamp", () => {
    expect(isTimestampValid("not-a-number")).toBe(false);
  });
});

describe("checkNonce", () => {
  it("accepts a new nonce", () => {
    expect(checkNonce("nonce-1")).toBe(true);
  });

  it("rejects a repeated nonce", () => {
    checkNonce("nonce-dup");
    expect(checkNonce("nonce-dup")).toBe(false);
  });

  it("accepts same nonce after TTL expires", () => {
    const originalNow = Date.now;
    const fakeNow = originalNow();

    // First call: record nonce at fakeNow
    vi.spyOn(Date, "now").mockReturnValue(fakeNow);
    checkNonce("nonce-ttl");

    // Second call: 130s later (past 120s TTL), cleanup should remove it
    vi.spyOn(Date, "now").mockReturnValue(fakeNow + 130_000);
    expect(checkNonce("nonce-ttl")).toBe(true);

    vi.spyOn(Date, "now").mockRestore();
  });

  it("rejects when nonce map reaches MAX_NONCES", () => {
    // Bulk-fill the nonce map to capacity (bypasses per-call cleanup overhead)
    _fillNonces(MAX_NONCES);
    expect(_nonceCount()).toBe(MAX_NONCES);

    // Next nonce should be rejected because we are at the cap
    expect(checkNonce("one-too-many")).toBe(false);
    expect(_nonceCount()).toBe(MAX_NONCES);
  });
});

describe("withAgentAuth (middleware integration)", () => {
  function makeAgentRequest(
    method: string,
    path: string,
    body: string,
    overrides?: {
      timestamp?: string;
      nonce?: string;
      signature?: string;
      omitHeaders?: boolean;
      ip?: string;
    }
  ): Request {
    const ts = overrides?.timestamp ?? nowTimestamp();
    const nonce = overrides?.nonce ?? `nonce-${Math.random().toString(36).slice(2)}`;
    const sig = overrides?.signature ?? makeSignature(ts, nonce, method, path, body);

    const headers: Record<string, string> = {
      "content-type": "application/json",
    };

    if (!overrides?.omitHeaders) {
      headers["x-agent-timestamp"] = ts;
      headers["x-agent-nonce"] = nonce;
      headers["x-agent-signature"] = sig;
    }

    if (overrides?.ip) {
      headers["x-forwarded-for"] = overrides.ip;
    }

    return new Request(`http://localhost${path}`, {
      method,
      headers,
      body: method === "GET" ? undefined : body,
    });
  }

  it("valid signature passes through to handler", async () => {
    const handler = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    );
    const wrapped = withAgentAuth(handler);

    const path = "/api/agent/jobs/pending";
    const req = makeAgentRequest("GET", path, "");
    await wrapped(req as any, { params: Promise.resolve({}) });

    expect(handler).toHaveBeenCalledOnce();
  });

  it("missing headers returns 401", async () => {
    const handler = vi.fn();
    const wrapped = withAgentAuth(handler);

    const req = new Request("http://localhost/api/agent/jobs/pending", {
      method: "GET",
    });
    const res = await wrapped(req as any, { params: Promise.resolve({}) });

    expect(res.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it("expired timestamp returns 401", async () => {
    const handler = vi.fn();
    const wrapped = withAgentAuth(handler);

    const path = "/api/agent/jobs/pending";
    const oldTs = String(Math.floor(Date.now() / 1000) - 120);
    const req = makeAgentRequest("GET", path, "", { timestamp: oldTs });
    const res = await wrapped(req as any, { params: Promise.resolve({}) });

    expect(res.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it("future timestamp (>60s) returns 401", async () => {
    const handler = vi.fn();
    const wrapped = withAgentAuth(handler);

    const path = "/api/agent/jobs/pending";
    const futureTs = String(Math.floor(Date.now() / 1000) + 120);
    const req = makeAgentRequest("GET", path, "", { timestamp: futureTs });
    const res = await wrapped(req as any, { params: Promise.resolve({}) });

    expect(res.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it("wrong signature returns 401", async () => {
    const handler = vi.fn();
    const wrapped = withAgentAuth(handler);

    const path = "/api/agent/jobs/pending";
    const req = makeAgentRequest("GET", path, "", { signature: "deadbeef" });
    const res = await wrapped(req as any, { params: Promise.resolve({}) });

    expect(res.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it("invalid signature does not consume the nonce", async () => {
    const handler = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    );
    const wrapped = withAgentAuth(handler);

    const path = "/api/agent/jobs/pending";
    const fixedNonce = "nonce-ordering-test";
    const ts = nowTimestamp();
    const validSig = makeSignature(ts, fixedNonce, "GET", path, "");

    // Send request with correct nonce but wrong signature
    const badReq = new Request(`http://localhost${path}`, {
      method: "GET",
      headers: {
        "x-agent-timestamp": ts,
        "x-agent-nonce": fixedNonce,
        "x-agent-signature": "deadbeef",
      },
    });
    const badRes = await wrapped(badReq as any, { params: Promise.resolve({}) });
    expect(badRes.status).toBe(401);

    // The nonce should NOT have been consumed, so a valid request
    // with the same nonce should succeed.
    const goodReq = new Request(`http://localhost${path}`, {
      method: "GET",
      headers: {
        "x-agent-timestamp": ts,
        "x-agent-nonce": fixedNonce,
        "x-agent-signature": validSig,
      },
    });
    const goodRes = await wrapped(goodReq as any, { params: Promise.resolve({}) });
    expect(goodRes.status).toBe(200);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("replayed nonce returns 401", async () => {
    const handler = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    );
    const wrapped = withAgentAuth(handler);

    const path = "/api/agent/jobs/pending";
    const fixedNonce = "replay-nonce";
    const ts = nowTimestamp();
    const sig = makeSignature(ts, fixedNonce, "GET", path, "");

    // First request succeeds
    const req1 = new Request(`http://localhost${path}`, {
      method: "GET",
      headers: {
        "x-agent-timestamp": ts,
        "x-agent-nonce": fixedNonce,
        "x-agent-signature": sig,
      },
    });
    const res1 = await wrapped(req1 as any, { params: Promise.resolve({}) });
    expect(res1.status).toBe(200);

    // Second request with same nonce fails
    const req2 = new Request(`http://localhost${path}`, {
      method: "GET",
      headers: {
        "x-agent-timestamp": ts,
        "x-agent-nonce": fixedNonce,
        "x-agent-signature": sig,
      },
    });
    const res2 = await wrapped(req2 as any, { params: Promise.resolve({}) });
    expect(res2.status).toBe(401);
  });

  it("empty body (GET request) signature works", async () => {
    const handler = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    );
    const wrapped = withAgentAuth(handler);

    const path = "/api/agent/jobs/pending";
    const req = makeAgentRequest("GET", path, "");
    const res = await wrapped(req as any, { params: Promise.resolve({}) });

    expect(res.status).toBe(200);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("POST with JSON body signature works", async () => {
    const handler = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    );
    const wrapped = withAgentAuth(handler);

    const path = "/api/agent/jobs/claim";
    const body = JSON.stringify({ job_ids: ["abc-123"] });
    const req = makeAgentRequest("POST", path, body);
    const res = await wrapped(req as any, { params: Promise.resolve({}) });

    expect(res.status).toBe(200);
    expect(handler).toHaveBeenCalledOnce();
    // Verify handler received the body
    const ctx = handler.mock.calls[0][1];
    expect(ctx.body).toBe(body);
  });

  it("nonce cleanup allows reuse after TTL", async () => {
    _resetNonces();

    const handler = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    );
    const wrapped = withAgentAuth(handler);

    const path = "/api/agent/jobs/pending";
    const fixedNonce = "ttl-nonce";
    const originalNow = Date.now;
    const baseTime = originalNow();

    // First request at baseTime
    vi.spyOn(Date, "now").mockReturnValue(baseTime);
    const ts1 = String(Math.floor(baseTime / 1000));
    const sig1 = makeSignature(ts1, fixedNonce, "GET", path, "");
    const req1 = new Request(`http://localhost${path}`, {
      method: "GET",
      headers: {
        "x-agent-timestamp": ts1,
        "x-agent-nonce": fixedNonce,
        "x-agent-signature": sig1,
      },
    });
    const res1 = await wrapped(req1 as any, { params: Promise.resolve({}) });
    expect(res1.status).toBe(200);

    // Second request 130s later (past 120s TTL)
    const futureTime = baseTime + 130_000;
    vi.spyOn(Date, "now").mockReturnValue(futureTime);
    const ts2 = String(Math.floor(futureTime / 1000));
    const sig2 = makeSignature(ts2, fixedNonce, "GET", path, "");
    const req2 = new Request(`http://localhost${path}`, {
      method: "GET",
      headers: {
        "x-agent-timestamp": ts2,
        "x-agent-nonce": fixedNonce,
        "x-agent-signature": sig2,
      },
    });
    const res2 = await wrapped(req2 as any, { params: Promise.resolve({}) });
    expect(res2.status).toBe(200);

    vi.spyOn(Date, "now").mockRestore();
  });

  it("returns 429 when rate limited", async () => {
    mockCheck.mockReturnValue({ allowed: false, remaining: 0 });

    const handler = vi.fn();
    const wrapped = withAgentAuth(handler);

    const path = "/api/agent/jobs/pending";
    const req = makeAgentRequest("GET", path, "");
    const res = await wrapped(req as any, { params: Promise.resolve({}) });

    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toBe("Too many requests");
    expect(handler).not.toHaveBeenCalled();
  });

  it("rate limit is checked before HMAC validation", async () => {
    mockCheck.mockReturnValue({ allowed: false, remaining: 0 });

    const handler = vi.fn();
    const wrapped = withAgentAuth(handler);

    // Send request with no auth headers at all; should still get 429, not 401
    const req = new Request("http://localhost/api/agent/jobs/pending", {
      method: "GET",
    });
    const res = await wrapped(req as any, { params: Promise.resolve({}) });

    expect(res.status).toBe(429);
    expect(handler).not.toHaveBeenCalled();
  });
});
