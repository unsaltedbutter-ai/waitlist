import { bech32 } from "@scure/base";

const HEX_64_RE = /^[0-9a-f]{64}$/;

/**
 * Convert any npub representation (bech32 "npub1..." or 64-char hex) to hex.
 *
 * - If already a 64-character lowercase hex string, returns as-is.
 * - If a bech32 npub1 string, decodes and returns the hex pubkey.
 * - Otherwise throws.
 */
export function npubToHex(npub: string): string {
  const trimmed = npub.trim().toLowerCase();

  if (HEX_64_RE.test(trimmed)) {
    return trimmed;
  }

  if (trimmed.startsWith("npub1")) {
    const decoded = bech32.decode(trimmed as `${string}1${string}`, 1_000);
    if (decoded.prefix !== "npub") {
      throw new Error(`Expected npub prefix, got "${decoded.prefix}"`);
    }
    const bytes = bech32.fromWords(decoded.words);
    return Buffer.from(bytes).toString("hex");
  }

  throw new Error(
    `Invalid npub: must be a 64-char hex string or bech32 npub1... string`
  );
}
