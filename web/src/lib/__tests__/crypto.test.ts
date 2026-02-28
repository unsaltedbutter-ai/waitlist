import { describe, it, expect, beforeEach, vi } from "vitest";

let sealedBoxEncrypt: typeof import("@/lib/crypto").sealedBoxEncrypt;
let clearKeyCache: typeof import("@/lib/crypto").clearKeyCache;
let hashEmail: typeof import("@/lib/crypto").hashEmail;

beforeEach(async () => {
  vi.unstubAllEnvs();
  const mod = await import("@/lib/crypto");
  sealedBoxEncrypt = mod.sealedBoxEncrypt;
  clearKeyCache = mod.clearKeyCache;
  hashEmail = mod.hashEmail;
  clearKeyCache();
});

describe("sealedBoxEncrypt", () => {
  // 32-byte test public key (not a real key, just for format validation)
  const TEST_PUBKEY_HEX = "a".repeat(64);

  function setup() {
    vi.stubEnv("CREDENTIAL_PUBLIC_KEY", TEST_PUBKEY_HEX);
    clearKeyCache();
  }

  it("returns a Buffer", async () => {
    setup();
    const result = await sealedBoxEncrypt("hello");
    expect(Buffer.isBuffer(result)).toBe(true);
  });

  it("produces different ciphertext each call (nonce randomness)", async () => {
    setup();
    const a = await sealedBoxEncrypt("same-input");
    const b = await sealedBoxEncrypt("same-input");
    expect(Buffer.compare(a, b)).not.toBe(0);
  });

  it("ciphertext is longer than plaintext (overhead from sealed box)", async () => {
    setup();
    const plaintext = "short";
    const encrypted = await sealedBoxEncrypt(plaintext);
    // Sealed box overhead is 48 bytes (32 ephemeral pubkey + 16 MAC)
    expect(encrypted.length).toBeGreaterThan(plaintext.length + 40);
  });

  it("throws when CREDENTIAL_PUBLIC_KEY is not set", async () => {
    vi.stubEnv("CREDENTIAL_PUBLIC_KEY", "");
    clearKeyCache();
    await expect(sealedBoxEncrypt("test")).rejects.toThrow(
      "CREDENTIAL_PUBLIC_KEY not set"
    );
  });

  it("throws when public key is wrong length", async () => {
    vi.stubEnv("CREDENTIAL_PUBLIC_KEY", "aabb"); // 2 bytes, not 32
    clearKeyCache();
    await expect(sealedBoxEncrypt("test")).rejects.toThrow("32 bytes");
  });
});

describe("hashEmail", () => {
  it("produces consistent hash for same email", () => {
    const a = hashEmail("user@example.com");
    const b = hashEmail("user@example.com");
    expect(a).toBe(b);
  });

  it("normalizes to lowercase", () => {
    const lower = hashEmail("user@example.com");
    const upper = hashEmail("USER@EXAMPLE.COM");
    const mixed = hashEmail("User@Example.Com");
    expect(lower).toBe(upper);
    expect(lower).toBe(mixed);
  });

  it("trims whitespace", () => {
    const clean = hashEmail("user@example.com");
    const padded = hashEmail("  user@example.com  ");
    const tabbed = hashEmail("\tuser@example.com\n");
    expect(clean).toBe(padded);
    expect(clean).toBe(tabbed);
  });

  it("returns a 64-character hex string", () => {
    const hash = hashEmail("test@test.com");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("different emails produce different hashes", () => {
    const a = hashEmail("alice@example.com");
    const b = hashEmail("bob@example.com");
    expect(a).not.toBe(b);
  });
});
