import { describe, it, expect, beforeEach, vi } from "vitest";
import { TEST_JWT_SECRET } from "@/__test-utils__/fixtures";
import { generateSecretKey, getPublicKey, finalizeEvent } from "nostr-tools";

vi.mock("@/lib/auth-login", () => ({
  loginExistingUser: vi.fn(),
  createUserWithInvite: vi.fn(),
  lookupInviteByNpub: vi.fn(),
}));

import {
  loginExistingUser,
  createUserWithInvite,
  lookupInviteByNpub,
} from "@/lib/auth-login";
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
  vi.mocked(loginExistingUser).mockReset();
  vi.mocked(createUserWithInvite).mockReset();
  vi.mocked(lookupInviteByNpub).mockReset();
});

describe("Nostr auth (NIP-42)", () => {
  // --- Existing user path ---

  it("existing user, valid NIP-42 event: 200 + token", async () => {
    const { event } = makeNip42Event();

    vi.mocked(loginExistingUser).mockResolvedValueOnce({
      status: 200,
      body: { token: "mock-jwt-token", userId: "user-abc" },
    });

    const res = await POST(makeRequest({ event }) as any);
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.token).toBe("mock-jwt-token");
    expect(data.userId).toBe("user-abc");
    expect(loginExistingUser).toHaveBeenCalledWith(event.pubkey);
  });

  it("existing user, no invite needed: 200", async () => {
    const { event } = makeNip42Event();

    vi.mocked(loginExistingUser).mockResolvedValueOnce({
      status: 200,
      body: { token: "mock-jwt-token", userId: "user-existing" },
    });

    const res = await POST(makeRequest({ event }) as any);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.token).toBe("mock-jwt-token");
    expect(data.userId).toBe("user-existing");
  });

  it("existing user, onboarding incomplete: needsOnboarding in response", async () => {
    const { event } = makeNip42Event();

    vi.mocked(loginExistingUser).mockResolvedValueOnce({
      status: 200,
      body: { token: "mock-jwt-token", userId: "user-abc", needsOnboarding: true },
    });

    const res = await POST(makeRequest({ event }) as any);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.needsOnboarding).toBe(true);
  });

  // --- New user path ---

  it("new user, no invite found by npub: 403", async () => {
    const { event } = makeNip42Event();

    vi.mocked(loginExistingUser).mockResolvedValueOnce(null);
    vi.mocked(lookupInviteByNpub).mockResolvedValueOnce(null);

    const res = await POST(makeRequest({ event }) as any);
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toMatch(/no invite/i);
  });

  it("new user, invite found by npub: 201", async () => {
    const { event } = makeNip42Event();

    vi.mocked(loginExistingUser).mockResolvedValueOnce(null);
    vi.mocked(lookupInviteByNpub).mockResolvedValueOnce("wl-1");
    vi.mocked(createUserWithInvite).mockResolvedValueOnce({
      status: 201,
      body: { token: "mock-jwt-token", userId: "new-user-xyz" },
    });

    const res = await POST(makeRequest({ event }) as any);
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.token).toBe("mock-jwt-token");
    expect(data.userId).toBe("new-user-xyz");
  });

  it("new user, at capacity: 403", async () => {
    const { event } = makeNip42Event();

    vi.mocked(loginExistingUser).mockResolvedValueOnce(null);
    vi.mocked(lookupInviteByNpub).mockResolvedValueOnce("wl-1");
    vi.mocked(createUserWithInvite).mockResolvedValueOnce({
      status: 403,
      body: { error: "At capacity" },
    });

    const res = await POST(makeRequest({ event }) as any);
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toMatch(/at capacity/i);
  });

  // --- Validation tests ---

  it("wrong kind (not 22242): 400", async () => {
    const { event } = makeNip42Event({ kind: 1 });

    const res = await POST(makeRequest({ event }) as any);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/kind/i);
  });

  it("invalid signature: 401", async () => {
    const { event } = makeNip42Event();
    const tampered = {
      ...event,
      sig: event.sig.replace(/^./, event.sig[0] === "a" ? "b" : "a"),
    };

    const res = await POST(makeRequest({ event: tampered }) as any);
    expect(res.status).toBe(401);
  });

  it("expired event (>5 min old): 401", async () => {
    const old = Math.floor(Date.now() / 1000) - 600;
    const { event } = makeNip42Event({ created_at: old });

    const res = await POST(makeRequest({ event }) as any);
    expect(res.status).toBe(401);
  });

  it("future event (>5 min ahead): 401", async () => {
    const future = Math.floor(Date.now() / 1000) + 600;
    const { event } = makeNip42Event({ created_at: future });

    const res = await POST(makeRequest({ event }) as any);
    expect(res.status).toBe(401);
  });

  it("missing event in body: 400", async () => {
    const res = await POST(makeRequest({}) as any);
    expect(res.status).toBe(400);
  });
});
