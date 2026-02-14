import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  createTestKeyFile,
  createTestKeyFileWithSize,
} from "@/__test-utils__/fixtures";

// Must be imported AFTER env stubs are set, so use dynamic import in helpers
let encrypt: typeof import("@/lib/crypto").encrypt;
let decrypt: typeof import("@/lib/crypto").decrypt;
let clearKeyCache: typeof import("@/lib/crypto").clearKeyCache;

beforeEach(async () => {
  vi.unstubAllEnvs();
  // Re-import to get fresh module state
  const mod = await import("@/lib/crypto");
  encrypt = mod.encrypt;
  decrypt = mod.decrypt;
  clearKeyCache = mod.clearKeyCache;
  clearKeyCache();
});

describe("crypto", () => {
  function setup() {
    const keyPath = createTestKeyFile();
    vi.stubEnv("ENCRYPTION_KEY_PATH", keyPath);
    clearKeyCache();
    return keyPath;
  }

  it("encrypt → decrypt round-trip", () => {
    setup();
    const plaintext = "hunter2-super-secret";
    const encrypted = encrypt(plaintext);
    expect(decrypt(encrypted)).toBe(plaintext);
  });

  it("encrypt produces different ciphertext each call (IV randomness)", () => {
    setup();
    const plaintext = "same-input";
    const a = encrypt(plaintext);
    const b = encrypt(plaintext);
    expect(Buffer.compare(a, b)).not.toBe(0);
  });

  it("decrypt rejects tampered ciphertext", () => {
    setup();
    const encrypted = encrypt("secret");
    // Flip a byte in the ciphertext body (after IV, before tag)
    encrypted[15] ^= 0xff;
    expect(() => decrypt(encrypted)).toThrow();
  });

  it("decrypt rejects tampered auth tag", () => {
    setup();
    const encrypted = encrypt("secret");
    // Flip a byte in the last 16 bytes (auth tag)
    encrypted[encrypted.length - 1] ^= 0xff;
    expect(() => decrypt(encrypted)).toThrow();
  });

  it("decrypt rejects truncated data", () => {
    setup();
    // IV(12) + tag(16) + 1 = 29 minimum; send 28
    const short = Buffer.alloc(28);
    expect(() => decrypt(short)).toThrow("Encrypted data too short");
  });

  it("decrypt fails with wrong key", () => {
    const keyA = createTestKeyFile();
    vi.stubEnv("ENCRYPTION_KEY_PATH", keyA);
    clearKeyCache();
    const encrypted = encrypt("secret");

    // Switch to a different key
    const keyB = createTestKeyFile();
    vi.stubEnv("ENCRYPTION_KEY_PATH", keyB);
    clearKeyCache();
    expect(() => decrypt(encrypted)).toThrow();
  });

  it("throws when ENCRYPTION_KEY_PATH is not set", () => {
    vi.stubEnv("ENCRYPTION_KEY_PATH", "");
    clearKeyCache();
    // Empty string is falsy — the code checks `if (!keyPath)`
    expect(() => encrypt("test")).toThrow("ENCRYPTION_KEY_PATH not set");
  });

  it("throws when key file is wrong length", () => {
    const badPath = createTestKeyFileWithSize(16);
    vi.stubEnv("ENCRYPTION_KEY_PATH", badPath);
    clearKeyCache();
    expect(() => encrypt("test")).toThrow("32 bytes");
  });
});
