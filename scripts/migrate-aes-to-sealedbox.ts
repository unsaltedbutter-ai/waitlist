/**
 * One-time migration: AES-256-GCM credentials -> libsodium sealed boxes.
 *
 * Run on the VPS where the old AES keyfile and database live:
 *
 *   cd /home/butter/unsaltedbutter/web
 *   npx tsx ../scripts/migrate-aes-to-sealedbox.ts
 *
 * Requires:
 *   - ENCRYPTION_KEY_PATH set in .env.production (old AES keyfile)
 *   - CREDENTIAL_PUBLIC_KEY set in .env.production (new sealed box public key)
 *   - DATABASE_URL set in .env.production
 *
 * What it does:
 *   1. Reads all rows from streaming_credentials
 *   2. Decrypts email_enc and password_enc with the old AES key
 *   3. Re-encrypts with libsodium sealed box using CREDENTIAL_PUBLIC_KEY
 *   4. Computes email_hash (SHA-256 of normalized email)
 *   5. Updates each row in place
 *
 * Safe to run multiple times (idempotent: re-encrypts everything).
 * Run --dry-run to preview without writing.
 */

import { readFileSync } from "fs";
import { createHash, createDecipheriv } from "crypto";
import { Pool } from "pg";
import sodium from "libsodium-wrappers";

// ---------- Config ----------

const DRY_RUN = process.argv.includes("--dry-run");

function loadEnv(): void {
  // Load .env.production if present
  try {
    const envFile = readFileSync(".env.production", "utf-8");
    for (const line of envFile.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq);
      const val = trimmed.slice(eq + 1);
      if (!process.env[key]) process.env[key] = val;
    }
  } catch {
    // no .env.production
  }
}

// ---------- Old AES decrypt ----------

function loadAesKey(): Buffer {
  const keyPath = process.env.ENCRYPTION_KEY_PATH;
  if (!keyPath) throw new Error("ENCRYPTION_KEY_PATH not set");
  const key = readFileSync(keyPath);
  if (key.length !== 32) throw new Error(`AES key must be 32 bytes, got ${key.length}`);
  return key;
}

function aesDecrypt(encrypted: Buffer, key: Buffer): string {
  if (encrypted.length < 29) throw new Error("Encrypted data too short");
  const iv = encrypted.subarray(0, 12);
  const tag = encrypted.subarray(encrypted.length - 16);
  const ciphertext = encrypted.subarray(12, encrypted.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString("utf-8");
}

// ---------- New sealed box encrypt ----------

function loadPublicKey(): Uint8Array {
  const hex = process.env.CREDENTIAL_PUBLIC_KEY;
  if (!hex) throw new Error("CREDENTIAL_PUBLIC_KEY not set");
  const key = Buffer.from(hex, "hex");
  if (key.length !== 32) throw new Error(`Public key must be 32 bytes, got ${key.length}`);
  return key;
}

function sealedBoxEncrypt(plaintext: string, pubkey: Uint8Array): Buffer {
  const message = sodium.from_string(plaintext);
  const ciphertext = sodium.crypto_box_seal(message, pubkey);
  return Buffer.from(ciphertext);
}

function hashEmail(email: string): string {
  return createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
}

// ---------- Main ----------

async function main(): Promise<void> {
  loadEnv();

  console.log(DRY_RUN ? "=== DRY RUN (no writes) ===" : "=== LIVE MIGRATION ===");

  const aesKey = loadAesKey();
  console.log("AES key loaded from:", process.env.ENCRYPTION_KEY_PATH);

  await sodium.ready;
  const pubkey = loadPublicKey();
  console.log("Sealed box public key loaded");

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  try {
    const { rows } = await pool.query(
      "SELECT id, email_enc, password_enc FROM streaming_credentials"
    );
    console.log(`Found ${rows.length} credential row(s) to migrate`);

    let migrated = 0;
    let failed = 0;

    for (const row of rows) {
      try {
        // Decrypt with old AES key
        const email = aesDecrypt(row.email_enc, aesKey);
        const password = aesDecrypt(row.password_enc, aesKey);

        // Re-encrypt with sealed box
        const emailEnc = sealedBoxEncrypt(email, pubkey);
        const passwordEnc = sealedBoxEncrypt(password, pubkey);
        const emailHash = hashEmail(email);

        if (DRY_RUN) {
          console.log(`  [dry-run] ${row.id}: email_hash=${emailHash.slice(0, 12)}...`);
        } else {
          await pool.query(
            `UPDATE streaming_credentials
             SET email_enc = $1, password_enc = $2, email_hash = $3, updated_at = NOW()
             WHERE id = $4`,
            [emailEnc, passwordEnc, emailHash, row.id]
          );
          console.log(`  migrated ${row.id}: email_hash=${emailHash.slice(0, 12)}...`);
        }
        migrated++;
      } catch (err) {
        console.error(`  FAILED ${row.id}:`, err);
        failed++;
      }
    }

    console.log(`\nDone: ${migrated} migrated, ${failed} failed`);
    if (DRY_RUN) console.log("Re-run without --dry-run to apply changes.");
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
