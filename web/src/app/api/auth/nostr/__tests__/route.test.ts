import { describe, it, expect, beforeEach, vi } from "vitest";
import { TEST_JWT_SECRET, mockQueryResult } from "@/__test-utils__/fixtures";
import { generateSecretKey, getPublicKey, finalizeEvent } from "nostr-tools";

vi.mock("@/lib/db", () => ({
  query: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({
  createToken: vi.fn(),
  needsOnboarding: vi.fn().mockResolvedValue(false),
}));
vi.mock("@/lib/capacity", () => ({
  isAtCapacity: vi.fn(),
}));

import { query } from "@/lib/db";
import { createToken, needsOnboarding } from "@/lib/auth";
import { isAtCapacity } from "@/lib/capacity";
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
  vi.mocked(needsOnboarding).mockReset();
  vi.mocked(needsOnboarding).mockResolvedValue(false);
  vi.mocked(isAtCapacity).mockReset();
  vi.mocked(isAtCapacity).mockResolvedValue(false);
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
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("SELECT id FROM users"),
      [pubkey]
    );
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

  it("existing user, onboarding incomplete → needsOnboarding in response", async () => {
    vi.mocked(needsOnboarding).mockResolvedValue(true);
    const { event } = makeNip42Event();

    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ id: "user-abc" }])
    );
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const res = await POST(makeRequest({ event }) as any);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.needsOnboarding).toBe(true);
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

  it("new user, valid code → 201", async () => {
    const { event } = makeNip42Event();

    // SELECT users: no user found
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));
    // SELECT waitlist: code found
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ id: "wl-1" }])
    );
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
  });

  it("new user, invalid code → 403", async () => {
    const { event } = makeNip42Event();

    // SELECT users: no user found
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));
    // SELECT waitlist: code not found
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const res = await POST(
      makeRequest({ event, inviteCode: "BADCODE" }) as any
    );
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toMatch(/invalid or expired/i);
  });

  it("new user, at capacity → 403", async () => {
    const { event } = makeNip42Event();

    // SELECT users: no user found
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));
    // SELECT waitlist: code found
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ id: "wl-1" }])
    );
    vi.mocked(isAtCapacity).mockResolvedValueOnce(true);

    const res = await POST(
      makeRequest({ event, inviteCode: "VALIDCODE123" }) as any
    );
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toMatch(/at capacity/i);
  });

  // --- Validation tests ---

  it("wrong kind (not 22242) → 400", async () => {
    const { event } = makeNip42Event({ kind: 1 });

    const res = await POST(makeRequest({ event }) as any);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/kind/i);
  });

  it("invalid signature → 401", async () => {
    const { event } = makeNip42Event();
    const tampered = {
      ...event,
      sig: event.sig.replace(/^./, event.sig[0] === "a" ? "b" : "a"),
    };

    const res = await POST(makeRequest({ event: tampered }) as any);
    expect(res.status).toBe(401);
  });

  it("expired event (>5 min old) → 401", async () => {
    const old = Math.floor(Date.now() / 1000) - 600;
    const { event } = makeNip42Event({ created_at: old });

    const res = await POST(makeRequest({ event }) as any);
    expect(res.status).toBe(401);
  });

  it("future event (>5 min ahead) → 401", async () => {
    const future = Math.floor(Date.now() / 1000) + 600;
    const { event } = makeNip42Event({ created_at: future });

    const res = await POST(makeRequest({ event }) as any);
    expect(res.status).toBe(401);
  });

  it("missing event in body → 400", async () => {
    const res = await POST(makeRequest({}) as any);
    expect(res.status).toBe(400);
  });
});
