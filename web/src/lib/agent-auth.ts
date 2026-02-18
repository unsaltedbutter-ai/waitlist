import { createHmac, createHash, timingSafeEqual } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { createRateLimiter, getClientIp } from "@/lib/rate-limit";

// Rate limiter for agent endpoints: 100 requests per 60 seconds
const agentRateLimiter = createRateLimiter(100, 60_000);

// In-memory nonce store with timestamps for TTL cleanup
const seenNonces = new Map<string, number>();
const NONCE_TTL_MS = 120_000; // 120 seconds
const TIMESTAMP_WINDOW_S = 60; // +/- 60 seconds
export const MAX_NONCES = 100_000;

/** Remove nonces older than NONCE_TTL_MS. */
function cleanupNonces() {
  const cutoff = Date.now() - NONCE_TTL_MS;
  for (const [nonce, ts] of seenNonces) {
    if (ts < cutoff) {
      seenNonces.delete(nonce);
    }
  }
}

/** Exposed for testing only. */
export function _resetNonces() {
  seenNonces.clear();
}

/** Exposed for testing only: returns current nonce count. */
export function _nonceCount(): number {
  return seenNonces.size;
}

/** Exposed for testing only: bulk-fill nonces without cleanup overhead. */
export function _fillNonces(count: number) {
  const now = Date.now();
  for (let i = 0; i < count; i++) {
    seenNonces.set(`_fill_${i}`, now);
  }
}

function getHmacSecret(): string {
  const secret = process.env.AGENT_HMAC_SECRET;
  if (!secret) throw new Error("AGENT_HMAC_SECRET not set");
  return secret;
}

/**
 * Verify HMAC signature from the orchestrator.
 * Returns true if valid, false otherwise.
 */
export function verifyAgentSignature(
  method: string,
  path: string,
  body: string,
  timestamp: string,
  nonce: string,
  signature: string
): boolean {
  const secret = getHmacSecret();
  const bodyHash = createHash("sha256").update(body).digest("hex");
  const message = timestamp + nonce + method + path + bodyHash;
  const expected = createHmac("sha256", secret).update(message).digest("hex");
  if (expected.length !== signature.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

/**
 * Validate timestamp is within the allowed window.
 * Returns true if valid.
 */
export function isTimestampValid(timestamp: string): boolean {
  const ts = parseInt(timestamp, 10);
  if (isNaN(ts)) return false;
  const now = Math.floor(Date.now() / 1000);
  return Math.abs(now - ts) <= TIMESTAMP_WINDOW_S;
}

/**
 * Check and record a nonce. Returns true if the nonce has not been seen before.
 */
export function checkNonce(nonce: string): boolean {
  cleanupNonces();
  if (seenNonces.size >= MAX_NONCES) return false;
  if (seenNonces.has(nonce)) return false;
  seenNonces.set(nonce, Date.now());
  return true;
}

/**
 * Wrap a route handler to require agent HMAC auth.
 * The handler receives the raw request body string via ctx.body
 * (empty string for GET requests).
 */
export function withAgentAuth(
  handler: (
    req: NextRequest,
    ctx: { body: string; params?: Record<string, string> }
  ) => Promise<NextResponse>
) {
  return async (
    req: NextRequest,
    segmentData: { params: Promise<Record<string, string>> }
  ) => {
    // Rate limit by IP before any other work
    const ip = getClientIp(req);
    const { allowed } = agentRateLimiter.check(ip);
    if (!allowed) {
      return NextResponse.json({ error: "Too many requests" }, { status: 429 });
    }

    const timestamp = req.headers.get("x-agent-timestamp");
    const nonce = req.headers.get("x-agent-nonce");
    const signature = req.headers.get("x-agent-signature");

    if (!timestamp || !nonce || !signature) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    if (!isTimestampValid(timestamp)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Verify signature BEFORE consuming the nonce, so attackers
    // cannot pre-consume nonces with invalid signatures.
    const body = await req.text();
    const url = new URL(req.url);
    const method = req.method;
    const path = url.pathname;

    if (!verifyAgentSignature(method, path, body, timestamp, nonce, signature)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    if (!checkNonce(nonce)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const params = await segmentData.params;
    return handler(req, { body, params });
  };
}
