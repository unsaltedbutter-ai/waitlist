import { describe, it, expect, beforeEach, vi } from "vitest";
import { TEST_JWT_SECRET, mockQueryResult } from "@/__test-utils__/fixtures";
import { generateSecretKey, getPublicKey, finalizeEvent } from "nostr-tools";

vi.mock("@/lib/db", () => ({
  query: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({
  createToken: vi.fn(),
}));
vi.mock("@/lib/capacity", () => ({
  validateInviteCode: vi.fn(),
  consumeInviteCode: vi.fn(),
  isAtCapacity: vi.fn(),
  getActiveUserCount: vi.fn(),
  generateReferralCodes: vi.fn(),
}));

import { query } from "@/lib/db";
import { createToken } from "@/lib/auth";
import {
  validateInviteCode,
  consumeInviteCode,
  isAtCapacity,
  getActiveUserCount,
  generateReferralCodes,
} from "@/lib/capacity";
import { POST } from "../route";

function makeNip42Event(
  overrides: {
    kind?: number;
    created_at?: number;
    secretKey?: Uint8Array;
  } = {}
) {
  const sk = overrides.secretKey ?? generateSecretKey();
  const kind = overrides.kind ?? 22242;
  const created_at = overrides.created_at ?? Math.floor(Date.now() / 1000);

  const event = finalizeEvent(
    {
      kind,
      created_at,
      tags: [["relay", "wss://relay.test"]],
      content: "",
    },
    sk
  );

  return { event, sk, pubkey: getPublicKey(sk) };
}

function makeRequest(body: object): Request {
  return new Request("http://localhost/api/auth/nostr", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("JWT_SECRET", TEST_JWT_SECRET);
  vi.mocked(query).mockReset();
  vi.mocked(createToken).mockReset();
  vi.mocked(createToken).mockResolvedValue("mock-jwt-token");
  vi.mocked(validateInviteCode).mockReset();
  vi.mocked(consumeInviteCode).mockReset();
  vi.mocked(isAtCapacity).mockReset();
  vi.mocked(getActiveUserCount).mockReset();
  vi.mocked(generateReferralCodes).mockReset();

  // Default: invite code passes all gates (for new user tests)
  vi.mocked(validateInviteCode).mockResolvedValue({
    valid: true,
    codeRow: {
      id: "code-123",
      owner_id: "owner-1",
      status: "active",
      expires_at: null,
    },
  });
  vi.mocked(isAtCapacity).mockResolvedValue(false);
  vi.mocked(consumeInviteCode).mockResolvedValue(undefined);
  vi.mocked(getActiveUserCount).mockResolvedValue(100);
  vi.mocked(generateReferralCodes).mockResolvedValue(undefined);
});

describe("Nostr auth (NIP-42)", () => {
  // --- Existing user path ---

  it("existing user, valid NIP-42 event → 200 + token (no invite code needed)", async () => {
    const { event, pubkey } = makeNip42Event();

    // SELECT: user found
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ id: "user-abc" }])
    );
    // UPDATE updated_at
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const res = await POST(makeRequest({ event }) as any);
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.token).toBe("mock-jwt-token");
    expect(data.userId).toBe("user-abc");
    // Verify SELECT was called with the pubkey
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("SELECT id FROM users"),
      [pubkey]
    );
    // Verify UPDATE was called
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE users SET updated_at"),
      ["user-abc"]
    );
  });

  it("existing user, no invite code → 200", async () => {
    const { event } = makeNip42Event();

    // SELECT: user found
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ id: "user-existing" }])
    );
    // UPDATE updated_at
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const res = await POST(makeRequest({ event }) as any);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.token).toBe("mock-jwt-token");
    expect(data.userId).toBe("user-existing");
  });

  // --- New user path ---

  it("new user, no invite code → 403", async () => {
    const { event } = makeNip42Event();

    // SELECT: no user found
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const res = await POST(makeRequest({ event }) as any);
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toMatch(/invite code required/i);
  });

  it("new user, valid code → 201, consumes code and generates referral codes", async () => {
    const { event } = makeNip42Event();

    // SELECT: no user found
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));
    // INSERT: new user created
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ id: "new-user-xyz" }])
    );

    const res = await POST(
      makeRequest({ event, inviteCode: "VALIDCODE123" }) as any
    );
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.token).toBe("mock-jwt-token");
    expect(data.userId).toBe("new-user-xyz");

    expect(consumeInviteCode).toHaveBeenCalledWith("code-123", "new-user-xyz");
    expect(getActiveUserCount).toHaveBeenCalled();
    expect(generateReferralCodes).toHaveBeenCalledWith("new-user-xyz", 100);
  });

  it("new user, invalid code → 403", async () => {
    const { event } = makeNip42Event();

    // SELECT: no user found
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));
    vi.mocked(validateInviteCode).mockResolvedValueOnce({ valid: false });

    const res = await POST(
      makeRequest({ event, inviteCode: "BADCODE" }) as any
    );
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toMatch(/invalid or expired/i);
  });

  it("new user, at capacity → 403", async () => {
    const { event } = makeNip42Event();

    // SELECT: no user found
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));
    vi.mocked(isAtCapacity).mockResolvedValueOnce(true);

    const res = await POST(
      makeRequest({ event, inviteCode: "VALIDCODE123" }) as any
    );
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toMatch(/at capacity/i);
  });

  // --- Validation tests (fail before user lookup, no invite code changes needed) ---

  it("wrong kind (not 22242) → 400", async () => {
    const { event } = makeNip42Event({ kind: 1 });

    const res = await POST(makeRequest({ event }) as any);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/kind/i);
  });

  it("invalid signature → 401", async () => {
    const { event } = makeNip42Event();
    // Tamper with the signature
    const tampered = {
      ...event,
      sig: event.sig.replace(/^./, event.sig[0] === "a" ? "b" : "a"),
    };

    const res = await POST(makeRequest({ event: tampered }) as any);
    expect(res.status).toBe(401);
  });

  it("expired event (>5 min old) → 401", async () => {
    const old = Math.floor(Date.now() / 1000) - 600; // 10 minutes ago
    const { event } = makeNip42Event({ created_at: old });

    const res = await POST(makeRequest({ event }) as any);
    expect(res.status).toBe(401);
  });

  it("future event (>5 min ahead) → 401", async () => {
    const future = Math.floor(Date.now() / 1000) + 600; // 10 minutes from now
    const { event } = makeNip42Event({ created_at: future });

    const res = await POST(makeRequest({ event }) as any);
    expect(res.status).toBe(401);
  });

  it("missing event in body → 400", async () => {
    const res = await POST(makeRequest({}) as any);
    expect(res.status).toBe(400);
  });
});
