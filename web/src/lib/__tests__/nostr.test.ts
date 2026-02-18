import { describe, it, expect } from "vitest";
import { npubToHex, hexToNpub } from "@/lib/nostr";

// Known test vector: a real npub/hex pair
const TEST_HEX =
  "7e7e9c42a91bfef19fa929e5fda1b72e0ebc1a4c1141673e2794234036b91bef";
const TEST_NPUB =
  "npub10elfcs4fr0l0r8af98jlmgdh9c8tcxjvz9qkw038js35qd4er0hswkumaa";

describe("npubToHex", () => {
  it("returns hex as-is when given a valid 64-char hex string", () => {
    expect(npubToHex(TEST_HEX)).toBe(TEST_HEX);
  });

  it("decodes a bech32 npub1... string to hex", () => {
    expect(npubToHex(TEST_NPUB)).toBe(TEST_HEX);
  });

  it("handles uppercase hex by lowercasing", () => {
    const upper = TEST_HEX.toUpperCase();
    expect(npubToHex(upper)).toBe(TEST_HEX);
  });

  it("trims whitespace", () => {
    expect(npubToHex(`  ${TEST_NPUB}  `)).toBe(TEST_HEX);
    expect(npubToHex(`  ${TEST_HEX}  `)).toBe(TEST_HEX);
  });

  it("throws for a random non-npub string", () => {
    expect(() => npubToHex("hello-world")).toThrow(/Invalid npub/);
  });

  it("throws for an empty string", () => {
    expect(() => npubToHex("")).toThrow(/Invalid npub/);
  });

  it("throws for hex that is not 64 chars", () => {
    expect(() => npubToHex("abcdef")).toThrow(/Invalid npub/);
  });

  it("throws for npub1 with invalid bech32 payload", () => {
    expect(() => npubToHex("npub1invalidchecksum")).toThrow();
  });

  it("returns consistent hex for all-zero key", () => {
    const zeroHex = "0".repeat(64);
    expect(npubToHex(zeroHex)).toBe(zeroHex);
  });
});

describe("hexToNpub", () => {
  it("encodes a 64-char hex string to bech32 npub", () => {
    expect(hexToNpub(TEST_HEX)).toBe(TEST_NPUB);
  });

  it("returns npub as-is when given an npub1 string", () => {
    expect(hexToNpub(TEST_NPUB)).toBe(TEST_NPUB);
  });

  it("handles uppercase hex by lowercasing first", () => {
    const upper = TEST_HEX.toUpperCase();
    expect(hexToNpub(upper)).toBe(TEST_NPUB);
  });

  it("trims whitespace", () => {
    expect(hexToNpub(`  ${TEST_HEX}  `)).toBe(TEST_NPUB);
  });

  it("roundtrips with npubToHex", () => {
    const npub = hexToNpub(TEST_HEX);
    expect(npubToHex(npub)).toBe(TEST_HEX);
  });

  it("throws for hex that is not 64 chars", () => {
    expect(() => hexToNpub("abcdef")).toThrow(/Invalid hex pubkey/);
  });

  it("throws for an empty string", () => {
    expect(() => hexToNpub("")).toThrow(/Invalid hex pubkey/);
  });

  it("throws for a random non-hex string", () => {
    expect(() => hexToNpub("hello-world-not-hex-at-all")).toThrow(/Invalid hex pubkey/);
  });
});
