import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

// Import after module loads; clearPriceCache is needed for isolation
let usdCentsToSats: typeof import("@/lib/btc-price").usdCentsToSats;
let satsToUsdCents: typeof import("@/lib/btc-price").satsToUsdCents;
let clearPriceCache: typeof import("@/lib/btc-price").clearPriceCache;

beforeEach(async () => {
  vi.unstubAllEnvs();
  // No BTCPay configured → will use CoinGecko path
  vi.stubEnv("BTCPAY_URL", "");

  const mod = await import("@/lib/btc-price");
  usdCentsToSats = mod.usdCentsToSats;
  satsToUsdCents = mod.satsToUsdCents;
  clearPriceCache = mod.clearPriceCache;
  clearPriceCache();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function mockCoinGecko(priceUsd: number) {
  return vi.spyOn(global, "fetch").mockImplementation(async () =>
    new Response(JSON.stringify({ bitcoin: { usd: priceUsd } }), {
      status: 200,
    })
  );
}

describe("BTC price conversions", () => {
  // At $100,000/BTC: 1 sat = $0.001, satsPerUsdCent = 100M / (100000*100) = 10
  it("usdCentsToSats at $100k BTC", async () => {
    mockCoinGecko(100_000);
    // 999 cents (= $9.99) * 10 sats/cent = 9990 sats
    const sats = await usdCentsToSats(999);
    expect(sats).toBe(9990);
  });

  it("satsToUsdCents at $100k BTC", async () => {
    mockCoinGecko(100_000);
    // 10000 sats / 10 sats/cent = 1000 cents = $10
    const cents = await satsToUsdCents(10000);
    expect(cents).toBe(1000);
  });

  it("usdCentsToSats rounds up (ceil)", async () => {
    mockCoinGecko(67_000);
    // satsPerUsdCent = 100M / (67000*100) = 14.925...
    // 100 cents * 14.925 = 1492.537... → ceil = 1493
    const sats = await usdCentsToSats(100);
    expect(sats).toBe(1493);
  });

  it("satsToUsdCents rounds to nearest (round)", async () => {
    mockCoinGecko(67_000);
    // satsPerUsdCent = 14.925...
    // 1000 sats / 14.925 = 67.0... cents → round = 67
    const cents = await satsToUsdCents(1000);
    expect(cents).toBe(67);
  });

  it("cache reuse — fetch called once for two conversions", async () => {
    const spy = mockCoinGecko(100_000);
    await usdCentsToSats(100);
    await satsToUsdCents(100);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("cache expires after 5 minutes", async () => {
    vi.useFakeTimers();
    const spy = mockCoinGecko(100_000);

    await usdCentsToSats(100);
    expect(spy).toHaveBeenCalledTimes(1);

    // Advance 6 minutes
    vi.advanceTimersByTime(6 * 60 * 1000);
    await usdCentsToSats(100);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("CoinGecko API error throws", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response("Too Many Requests", { status: 429 })
    );
    await expect(usdCentsToSats(100)).rejects.toThrow("CoinGecko API error");
  });
});
