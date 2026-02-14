let cachedRate: { satsPerUsdCent: number; fetchedAt: number } | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function fetchBtcPriceUsd(): Promise<number> {
  const btcpayUrl = process.env.BTCPAY_URL;
  if (btcpayUrl) {
    try {
      const res = await fetch(`${btcpayUrl}/api/rates?currencyPair=BTC_USD`);
      if (res.ok) {
        const data = await res.json();
        if (data?.[0]?.rate) return parseFloat(data[0].rate);
      }
    } catch {
      // Fall through to CoinGecko
    }
  }

  const res = await fetch(
    "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd"
  );
  if (!res.ok) throw new Error(`CoinGecko API error: ${res.status}`);
  const data = await res.json();
  return data.bitcoin.usd;
}

async function getSatsPerUsdCent(): Promise<number> {
  if (cachedRate && Date.now() - cachedRate.fetchedAt < CACHE_TTL_MS) {
    return cachedRate.satsPerUsdCent;
  }

  const btcPriceUsd = await fetchBtcPriceUsd();
  // 1 BTC = 100,000,000 sats, 1 USD = 100 cents
  const satsPerUsdCent = 100_000_000 / (btcPriceUsd * 100);

  cachedRate = { satsPerUsdCent, fetchedAt: Date.now() };
  return satsPerUsdCent;
}

export async function usdCentsToSats(cents: number): Promise<number> {
  const rate = await getSatsPerUsdCent();
  return Math.ceil(cents * rate);
}

export async function satsToUsdCents(sats: number): Promise<number> {
  const rate = await getSatsPerUsdCent();
  return Math.round(sats / rate);
}

/** Clear cached rate (for testing). */
export function clearPriceCache(): void {
  cachedRate = null;
}
