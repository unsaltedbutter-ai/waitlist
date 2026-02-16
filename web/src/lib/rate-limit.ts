import { NextRequest } from "next/server";

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

interface RateLimitResult {
  allowed: boolean;
  remaining: number;
}

/**
 * Creates an in-memory rate limiter backed by a Map.
 * Single-process safe (PM2 runs 1 instance).
 */
export function createRateLimiter(maxAttempts: number, windowMs: number) {
  const entries = new Map<string, RateLimitEntry>();

  // Periodic cleanup of expired entries (every 60 seconds)
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of entries) {
      if (now > entry.resetAt) {
        entries.delete(key);
      }
    }
  }, 60_000);
  timer.unref?.();

  return {
    check(key: string): RateLimitResult {
      const now = Date.now();
      const entry = entries.get(key);

      if (!entry || now > entry.resetAt) {
        entries.set(key, { count: 1, resetAt: now + windowMs });
        return { allowed: true, remaining: maxAttempts - 1 };
      }

      if (entry.count >= maxAttempts) {
        return { allowed: false, remaining: 0 };
      }

      entry.count++;
      return { allowed: true, remaining: maxAttempts - entry.count };
    },
  };
}

/** Extract the client IP from a NextRequest (reverse proxy aware). */
export function getClientIp(req: NextRequest): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    req.headers.get("x-real-ip") ??
    "unknown"
  );
}
