import { describe, it, expect, beforeEach, vi } from "vitest";
import { TEST_JWT_SECRET, mockQueryResult } from "@/__test-utils__/fixtures";
import { generateSecretKey, getPublicKey, finalizeEvent } from "nostr-tools";

vi.mock("@/lib/db", () => ({
  query: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({
  createToken: vi.fn(),
}));

import { query } from "@/lib/db";
import { createToken } from "@/lib/auth";
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
});

describe("Nostr auth (NIP-42)", () => {
  it("valid NIP-42 event → token + userId", async () => {
    const { event, pubkey } = makeNip42Event();

    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ id: "user-abc" }])
    );

    const res = await POST(makeRequest({ event }) as any);
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.token).toBe("mock-jwt-token");
    expect(data.userId).toBe("user-abc");
    // Verify upsert was called with the pubkey
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO users"),
      [pubkey]
    );
  });

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
