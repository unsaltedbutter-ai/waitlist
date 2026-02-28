import { createHash } from "crypto";
import sodium from "libsodium-wrappers";

let sodiumReady = false;
let cachedPublicKey: Uint8Array | null = null;

async function ensureSodium(): Promise<void> {
  if (!sodiumReady) {
    await sodium.ready;
    sodiumReady = true;
  }
}

function loadPublicKey(): Uint8Array {
  if (cachedPublicKey) return cachedPublicKey;
  const hex = process.env.CREDENTIAL_PUBLIC_KEY;
  if (!hex) throw new Error("CREDENTIAL_PUBLIC_KEY not set");
  cachedPublicKey = Buffer.from(hex, "hex");
  if (cachedPublicKey.length !== 32) {
    throw new Error(
      `CREDENTIAL_PUBLIC_KEY must be 32 bytes (64 hex chars), got ${cachedPublicKey.length}`
    );
  }
  return cachedPublicKey;
}

/**
 * Encrypt plaintext using libsodium sealed box (crypto_box_seal).
 * Only the holder of the corresponding private key can decrypt.
 * Returns the ciphertext as a Buffer (suitable for BYTEA storage).
 */
export async function sealedBoxEncrypt(plaintext: string): Promise<Buffer> {
  await ensureSodium();
  const pubkey = loadPublicKey();
  const message = sodium.from_string(plaintext);
  const ciphertext = sodium.crypto_box_seal(message, pubkey);
  return Buffer.from(ciphertext);
}

export function hashEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  return createHash("sha256").update(normalized).digest("hex");
}

/** Clear cached key (for testing or key rotation) */
export function clearKeyCache(): void {
  cachedPublicKey = null;
}
