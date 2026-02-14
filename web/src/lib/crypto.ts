import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import { readFileSync } from "fs";

const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const ALGORITHM = "aes-256-gcm";

let cachedKey: Buffer | null = null;

function loadKey(): Buffer {
  if (cachedKey) return cachedKey;
  const keyPath = process.env.ENCRYPTION_KEY_PATH;
  if (!keyPath) throw new Error("ENCRYPTION_KEY_PATH not set");
  cachedKey = readFileSync(keyPath);
  if (cachedKey.length !== 32) {
    throw new Error(`Encryption key must be 32 bytes, got ${cachedKey.length}`);
  }
  return cachedKey;
}

/**
 * Encrypt a plaintext string.
 * Returns: IV (12 bytes) || ciphertext || auth tag (16 bytes)
 */
export function encrypt(plaintext: string): Buffer {
  const key = loadKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, encrypted, tag]);
}

/**
 * Decrypt a buffer produced by encrypt().
 * Expects: IV (12 bytes) || ciphertext || auth tag (16 bytes)
 */
export function decrypt(data: Buffer): string {
  const key = loadKey();
  if (data.length < IV_LENGTH + TAG_LENGTH + 1) {
    throw new Error("Encrypted data too short");
  }
  const iv = data.subarray(0, IV_LENGTH);
  const tag = data.subarray(data.length - TAG_LENGTH);
  const ciphertext = data.subarray(IV_LENGTH, data.length - TAG_LENGTH);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(ciphertext) + decipher.final("utf8");
}

/** Clear cached key (for testing or key rotation) */
export function clearKeyCache(): void {
  cachedKey = null;
}
