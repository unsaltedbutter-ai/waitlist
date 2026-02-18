import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRateLimiter, getClientIp } from "@/lib/rate-limit";
import { NextRequest } from "next/server";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createRateLimiter", () => {
  it("creates a limiter that allows requests under the limit", () => {
    const limiter = createRateLimiter(5, 60_000);

    const r1 = limiter.check("user-a");
    expect(r1.allowed).toBe(true);
    expect(r1.remaining).toBe(4);

    const r2 = limiter.check("user-a");
    expect(r2.allowed).toBe(true);
    expect(r2.remaining).toBe(3);
  });

  it("blocks requests over the limit", () => {
    const limiter = createRateLimiter(3, 60_000);

    limiter.check("user-b"); // 1 of 3
    limiter.check("user-b"); // 2 of 3
    limiter.check("user-b"); // 3 of 3

    const blocked = limiter.check("user-b");
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
  });

  it("returns correct remaining count on the final allowed request", () => {
    const limiter = createRateLimiter(2, 60_000);

    limiter.check("user-c"); // 1 of 2, remaining = 1
    const last = limiter.check("user-c"); // 2 of 2, remaining = 0
    expect(last.allowed).toBe(true);
    expect(last.remaining).toBe(0);
  });

  it("resets the window after expiry", () => {
    const limiter = createRateLimiter(2, 10_000);

    limiter.check("user-d"); // 1 of 2
    limiter.check("user-d"); // 2 of 2

    const blocked = limiter.check("user-d");
    expect(blocked.allowed).toBe(false);

    // Advance time past the window
    vi.advanceTimersByTime(11_000);

    const afterReset = limiter.check("user-d");
    expect(afterReset.allowed).toBe(true);
    expect(afterReset.remaining).toBe(1);
  });

  it("tracks different keys independently", () => {
    const limiter = createRateLimiter(1, 60_000);

    const alpha = limiter.check("key-alpha");
    expect(alpha.allowed).toBe(true);
    expect(alpha.remaining).toBe(0);

    // key-alpha is now exhausted
    const alphaBlocked = limiter.check("key-alpha");
    expect(alphaBlocked.allowed).toBe(false);

    // key-beta is independent, should still be allowed
    const beta = limiter.check("key-beta");
    expect(beta.allowed).toBe(true);
    expect(beta.remaining).toBe(0);
  });

  it("first request in a window returns remaining = maxAttempts - 1", () => {
    const limiter = createRateLimiter(10, 60_000);

    const first = limiter.check("fresh-key");
    expect(first.allowed).toBe(true);
    expect(first.remaining).toBe(9);
  });

  it("handles a limit of 1 (single request per window)", () => {
    const limiter = createRateLimiter(1, 5_000);

    const first = limiter.check("once");
    expect(first.allowed).toBe(true);
    expect(first.remaining).toBe(0);

    const second = limiter.check("once");
    expect(second.allowed).toBe(false);
    expect(second.remaining).toBe(0);

    vi.advanceTimersByTime(6_000);

    const afterWindow = limiter.check("once");
    expect(afterWindow.allowed).toBe(true);
  });
});

describe("getClientIp", () => {
  it("extracts IP from x-forwarded-for header (first entry)", () => {
    const req = new NextRequest("http://localhost/api/test", {
      headers: { "x-forwarded-for": "1.2.3.4, 10.0.0.1, 192.168.1.1" },
    });
    expect(getClientIp(req)).toBe("1.2.3.4");
  });

  it("extracts IP from x-forwarded-for with a single value", () => {
    const req = new NextRequest("http://localhost/api/test", {
      headers: { "x-forwarded-for": "5.6.7.8" },
    });
    expect(getClientIp(req)).toBe("5.6.7.8");
  });

  it("trims whitespace from x-forwarded-for value", () => {
    const req = new NextRequest("http://localhost/api/test", {
      headers: { "x-forwarded-for": "  9.10.11.12  , 10.0.0.1" },
    });
    expect(getClientIp(req)).toBe("9.10.11.12");
  });

  it("falls back to x-real-ip when x-forwarded-for is absent", () => {
    const req = new NextRequest("http://localhost/api/test", {
      headers: { "x-real-ip": "100.200.100.200" },
    });
    expect(getClientIp(req)).toBe("100.200.100.200");
  });

  it("falls back to 'unknown' when no IP headers are present", () => {
    const req = new NextRequest("http://localhost/api/test");
    expect(getClientIp(req)).toBe("unknown");
  });

  it("prefers x-forwarded-for over x-real-ip when both are set", () => {
    const req = new NextRequest("http://localhost/api/test", {
      headers: {
        "x-forwarded-for": "1.1.1.1",
        "x-real-ip": "2.2.2.2",
      },
    });
    expect(getClientIp(req)).toBe("1.1.1.1");
  });
});
