import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockQueryResult } from "@/__test-utils__/fixtures";

vi.mock("@/lib/db", () => ({
  query: vi.fn(),
}));

vi.mock("@/lib/capacity", () => ({
  isAtCapacity: vi.fn(),
  generateInviteCode: vi.fn(() => "TESTCODE1234"),
}));

vi.mock("@/lib/nostr-push", () => ({
  pushAutoInvite: vi.fn(),
}));

import { query } from "@/lib/db";
import { isAtCapacity } from "@/lib/capacity";
import { pushAutoInvite } from "@/lib/nostr-push";
import { POST } from "../route";

// Real npub/hex pair for valid-input tests
const TEST_HEX =
  "7e7e9c42a91bfef19fa929e5fda1b72e0ebc1a4c1141673e2794234036b91bef";
const TEST_NPUB =
  "npub10elfcs4fr0l0r8af98jlmgdh9c8tcxjvz9qkw038js35qd4er0hswkumaa";

// Each test gets a unique IP so the in-memory rate limiter doesn't bleed state
let testIpCounter = 0;
function uniqueIp(): string {
  testIpCounter++;
  return `10.4.${Math.floor(testIpCounter / 256)}.${testIpCounter % 256}`;
}

function makeRequest(body: object): Request {
  return new Request("http://localhost/api/waitlist", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": uniqueIp(),
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.mocked(query).mockReset();
  vi.mocked(isAtCapacity).mockReset();
  vi.mocked(pushAutoInvite).mockReset();
  vi.mocked(isAtCapacity).mockResolvedValue(false); // default: below capacity
  vi.mocked(pushAutoInvite).mockResolvedValue(undefined);
});

describe("POST /api/waitlist", () => {
  // ================================================================
  // Validation
  // ================================================================

  it("missing nostrNpub -> 400", async () => {
    const res = await POST(makeRequest({}) as any);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/nostrNpub/);
  });

  it("invalid npub format -> 400", async () => {
    const res = await POST(makeRequest({ nostrNpub: "not-an-npub" }) as any);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/npub/i);
  });

  it("invalid bech32 npub -> 400", async () => {
    const res = await POST(
      makeRequest({ nostrNpub: "npub1invalidchecksum" }) as any
    );
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/npub/i);
  });

  it("invalid JSON -> 400", async () => {
    const req = new Request("http://localhost/api/waitlist", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": uniqueIp(),
      },
      body: "not json",
    });
    const res = await POST(req as any);
    expect(res.status).toBe(400);
  });

  // ================================================================
  // Auto-invite path (below capacity, new user)
  // ================================================================

  it("new user below capacity -> 201 autoInvited:true", async () => {
    // No existing entry
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));
    // INSERT waitlist
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));
    // OTP upsert
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ npub_hex: TEST_HEX }])
    );

    const res = await POST(makeRequest({ nostrNpub: TEST_NPUB }) as any);
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.autoInvited).toBe(true);
  });

  it("auto-invite generates OTP and pushes", async () => {
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ npub_hex: TEST_HEX }])
    );

    await POST(makeRequest({ nostrNpub: TEST_NPUB }) as any);

    expect(pushAutoInvite).toHaveBeenCalledTimes(1);
    expect(vi.mocked(pushAutoInvite).mock.calls[0][0]).toBe(TEST_HEX);
    // OTP is a 12-digit string
    const otpCode = vi.mocked(pushAutoInvite).mock.calls[0][1];
    expect(otpCode).toMatch(/^\d{12}$/);
  });

  it("auto-invite inserts waitlist with invited=TRUE", async () => {
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ npub_hex: TEST_HEX }])
    );

    await POST(makeRequest({ nostrNpub: TEST_NPUB }) as any);

    const insertCall = vi.mocked(query).mock.calls[1];
    expect(insertCall[0]).toContain("INSERT INTO waitlist");
    expect(insertCall[0]).toContain("invited");
    expect(insertCall[0]).toContain("TRUE");
  });

  it("valid hex npub below capacity -> 201 autoInvited:true", async () => {
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ npub_hex: TEST_HEX }])
    );

    const res = await POST(makeRequest({ nostrNpub: TEST_HEX }) as any);
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.autoInvited).toBe(true);
  });

  // ================================================================
  // Waitlist path (at capacity, new user)
  // ================================================================

  it("new user at capacity -> 201 autoInvited:false", async () => {
    vi.mocked(isAtCapacity).mockResolvedValue(true);
    // No existing entry
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));
    // INSERT waitlist (plain, no invite)
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const res = await POST(makeRequest({ nostrNpub: TEST_NPUB }) as any);
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.autoInvited).toBe(false);
  });

  it("at capacity does not push auto_invite", async () => {
    vi.mocked(isAtCapacity).mockResolvedValue(true);
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    await POST(makeRequest({ nostrNpub: TEST_NPUB }) as any);

    expect(pushAutoInvite).not.toHaveBeenCalled();
  });

  // ================================================================
  // Duplicate cases
  // ================================================================

  it("already redeemed -> 409", async () => {
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ id: "wl-1", invited: true, redeemed_at: "2026-01-01" }])
    );

    const res = await POST(makeRequest({ nostrNpub: TEST_NPUB }) as any);
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.error).toMatch(/already have an account/i);
  });

  it("already invited -> 409", async () => {
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ id: "wl-1", invited: true, redeemed_at: null }])
    );

    const res = await POST(makeRequest({ nostrNpub: TEST_NPUB }) as any);
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.error).toMatch(/already been invited/i);
  });

  it("existing waitlisted + below capacity -> upgrade to invited", async () => {
    // Existing entry, not invited
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ id: "wl-1", invited: false, redeemed_at: null }])
    );
    // UPDATE waitlist
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));
    // OTP upsert
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ npub_hex: TEST_HEX }])
    );

    const res = await POST(makeRequest({ nostrNpub: TEST_NPUB }) as any);
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.autoInvited).toBe(true);

    // Should UPDATE, not INSERT
    const updateCall = vi.mocked(query).mock.calls[1];
    expect(updateCall[0]).toContain("UPDATE waitlist");
  });

  it("existing waitlisted + at capacity -> 409", async () => {
    vi.mocked(isAtCapacity).mockResolvedValue(true);
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ id: "wl-1", invited: false, redeemed_at: null }])
    );

    const res = await POST(makeRequest({ nostrNpub: TEST_NPUB }) as any);
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.error).toMatch(/already on the list/i);
  });

  // ================================================================
  // INSERT uses hex (not bech32)
  // ================================================================

  it("INSERT query receives hex (not bech32)", async () => {
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ npub_hex: TEST_HEX }])
    );

    await POST(makeRequest({ nostrNpub: TEST_NPUB }) as any);

    const insertCall = vi.mocked(query).mock.calls[1];
    expect(insertCall[0]).toContain("INSERT INTO waitlist");
    // Second param array should contain hex
    expect(insertCall[1]).toContain(TEST_HEX);
  });
});
