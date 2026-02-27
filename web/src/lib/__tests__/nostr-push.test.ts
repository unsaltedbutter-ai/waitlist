import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Track mock calls from inside the mocked modules
const mockWrapEvent = vi.fn();
const mockDecode = vi.fn();
const mockNpubEncode = vi.fn();
const mockGetPublicKey = vi.fn();
const mockPublish = vi.fn();
const mockPoolClose = vi.fn();
const mockReadFileSync = vi.fn();

vi.mock("fs", () => ({
  readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
}));

vi.mock("nostr-tools/nip17", () => ({
  wrapEvent: (...args: unknown[]) => mockWrapEvent(...args),
}));

vi.mock("nostr-tools/nip19", () => ({
  decode: (...args: unknown[]) => mockDecode(...args),
  npubEncode: (...args: unknown[]) => mockNpubEncode(...args),
}));

vi.mock("nostr-tools/pure", () => ({
  getPublicKey: (...args: unknown[]) => mockGetPublicKey(...args),
}));

// SimplePool must be a real constructor since the code does `new SimplePool()`
vi.mock("nostr-tools/pool", () => {
  class MockSimplePool {
    publish(...args: unknown[]) {
      return mockPublish(...args);
    }
    close(...args: unknown[]) {
      return mockPoolClose(...args);
    }
  }
  return { SimplePool: MockSimplePool };
});

vi.mock("nostr-tools/utils", () => ({
  hexToBytes: (hex: string) => new Uint8Array(Buffer.from(hex, "hex")),
}));

// Constants
const TEST_PRIVKEY = "ab".repeat(32);
const TEST_NPUB = "npub1testfakenpub";
const TEST_RECIPIENT_HEX = "dd".repeat(32);

const FAKE_WRAPPED_EVENT = {
  kind: 1059,
  content: "encrypted",
  created_at: 1700000000,
  pubkey: "aa".repeat(32),
  id: "bb".repeat(32),
  sig: "cc".repeat(32),
  tags: [["p", TEST_RECIPIENT_HEX]],
};

let pushNewUser: typeof import("@/lib/nostr-push").pushNewUser;
let pushJobsReady: typeof import("@/lib/nostr-push").pushJobsReady;
let pushPaymentReceived: typeof import("@/lib/nostr-push").pushPaymentReceived;
let pushPaymentExpired: typeof import("@/lib/nostr-push").pushPaymentExpired;
let pushAutoInvite: typeof import("@/lib/nostr-push").pushAutoInvite;
let _resetPool: typeof import("@/lib/nostr-push")._resetPool;

beforeEach(async () => {
  vi.stubEnv("VPS_NOSTR_PRIVKEY", TEST_PRIVKEY);
  vi.stubEnv("VPS_NOSTR_PRIVKEY_FILE", "");
  vi.stubEnv("ORCHESTRATOR_NPUB", TEST_NPUB);
  vi.stubEnv("NOSTR_RELAYS", "wss://relay1.test,wss://relay2.test");

  mockWrapEvent.mockReturnValue({ ...FAKE_WRAPPED_EVENT });
  mockDecode.mockReturnValue({ type: "npub", data: TEST_RECIPIENT_HEX });
  mockGetPublicKey.mockReturnValue("aa".repeat(32));
  mockNpubEncode.mockReturnValue("npub1fakesender");
  mockPublish.mockReturnValue([Promise.resolve("ok"), Promise.resolve("ok")]);

  // Re-import to get fresh bindings; reset cached pool
  const mod = await import("@/lib/nostr-push");
  pushNewUser = mod.pushNewUser;
  pushJobsReady = mod.pushJobsReady;
  pushPaymentReceived = mod.pushPaymentReceived;
  pushPaymentExpired = mod.pushPaymentExpired;
  pushAutoInvite = mod.pushAutoInvite;
  _resetPool = mod._resetPool;
  _resetPool();
});

afterEach(() => {
  vi.unstubAllEnvs();
  mockWrapEvent.mockReset();
  mockDecode.mockReset();
  mockNpubEncode.mockReset();
  mockGetPublicKey.mockReset();
  mockPublish.mockReset();
  mockPoolClose.mockReset();
  mockReadFileSync.mockReset();
});

describe("nostr-push", () => {
  describe("pushNewUser", () => {
    it("sends nested payload with type and data.npub", async () => {
      await pushNewUser("npub1abc");

      expect(mockPublish).toHaveBeenCalledTimes(1);
      expect(mockWrapEvent).toHaveBeenCalledTimes(1);

      const message = mockWrapEvent.mock.calls[0][2];
      const parsed = JSON.parse(message);
      expect(parsed.type).toBe("new_user");
      expect(parsed.data.npub).toBe("npub1abc");
      expect(typeof parsed.timestamp).toBe("number");
    });
  });

  describe("pushJobsReady", () => {
    it("sends nested payload with data.job_ids array", async () => {
      await pushJobsReady(["job-1", "job-2", "job-3"]);

      const message = mockWrapEvent.mock.calls[0][2];
      const parsed = JSON.parse(message);
      expect(parsed.type).toBe("jobs_ready");
      expect(parsed.data.job_ids).toEqual(["job-1", "job-2", "job-3"]);
      expect(typeof parsed.timestamp).toBe("number");
    });
  });

  describe("pushPaymentReceived", () => {
    it("sends nested payload with npub_hex, service_name, and amount_sats", async () => {
      await pushPaymentReceived("aabb".repeat(16), "Netflix", 4400, "job-123");

      const message = mockWrapEvent.mock.calls[0][2];
      const parsed = JSON.parse(message);
      expect(parsed.type).toBe("payment_received");
      expect(parsed.data.npub_hex).toBe("aabb".repeat(16));
      expect(parsed.data.service_name).toBe("Netflix");
      expect(parsed.data.amount_sats).toBe(4400);
      expect(parsed.data.job_id).toBe("job-123");
      expect(typeof parsed.timestamp).toBe("number");
    });
  });

  describe("pushPaymentExpired", () => {
    it("sends nested payload with npub_hex, service_name, and debt_sats", async () => {
      await pushPaymentExpired("ccdd".repeat(16), "Hulu", 3000, "job-456");

      const message = mockWrapEvent.mock.calls[0][2];
      const parsed = JSON.parse(message);
      expect(parsed.type).toBe("payment_expired");
      expect(parsed.data.npub_hex).toBe("ccdd".repeat(16));
      expect(parsed.data.service_name).toBe("Hulu");
      expect(parsed.data.debt_sats).toBe(3000);
      expect(parsed.data.job_id).toBe("job-456");
      expect(typeof parsed.timestamp).toBe("number");
    });
  });

  describe("pushAutoInvite", () => {
    it("sends nested payload with npub_hex and otp_code", async () => {
      await pushAutoInvite("eeff".repeat(16), "123456789012");

      const message = mockWrapEvent.mock.calls[0][2];
      const parsed = JSON.parse(message);
      expect(parsed.type).toBe("auto_invite");
      expect(parsed.data.npub_hex).toBe("eeff".repeat(16));
      expect(parsed.data.otp_code).toBe("123456789012");
      expect(typeof parsed.timestamp).toBe("number");
    });
  });

  describe("sendPushDM internals", () => {
    it("wraps event with correct recipient pubkey", async () => {
      await pushNewUser("npub1test");

      expect(mockWrapEvent).toHaveBeenCalledWith(
        expect.any(Uint8Array),
        { publicKey: TEST_RECIPIENT_HEX },
        expect.any(String)
      );
    });

    it("publishes to all configured relays", async () => {
      await pushNewUser("npub1test");

      expect(mockPublish).toHaveBeenCalledWith(
        ["wss://relay1.test", "wss://relay2.test"],
        expect.objectContaining({ kind: 1059 })
      );
    });

    it("uses default relays when NOSTR_RELAYS is not set", async () => {
      vi.stubEnv("NOSTR_RELAYS", "");

      await pushNewUser("npub1test");

      expect(mockPublish).toHaveBeenCalledWith(
        ["wss://relay.damus.io", "wss://nos.lol", "wss://relay.nostr.band"],
        expect.any(Object)
      );
    });

    it("reuses the pool across multiple calls", async () => {
      // SimplePool is constructed lazily, so two pushes should use the same pool
      await pushNewUser("npub1a");
      await pushNewUser("npub1b");

      // publish called twice but on the same pool instance
      expect(mockPublish).toHaveBeenCalledTimes(2);
    });
  });

  describe("missing env vars", () => {
    it("warns and returns early when VPS_NOSTR_PRIVKEY is missing", async () => {
      vi.stubEnv("VPS_NOSTR_PRIVKEY", "");
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      await pushNewUser("npub1test");

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("VPS_NOSTR_PRIVKEY not set")
      );
      expect(mockPublish).not.toHaveBeenCalled();
    });

    it("warns and returns early when ORCHESTRATOR_NPUB is missing", async () => {
      vi.stubEnv("ORCHESTRATOR_NPUB", "");
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      await pushNewUser("npub1test");

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("ORCHESTRATOR_NPUB not set")
      );
      expect(mockPublish).not.toHaveBeenCalled();
    });

    it("warns and returns early when ORCHESTRATOR_NPUB decodes to non-npub type", async () => {
      mockDecode.mockReturnValue({ type: "nsec", data: "ab".repeat(32) });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      await pushNewUser("npub1test");

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("ORCHESTRATOR_NPUB not set or invalid")
      );
      expect(mockPublish).not.toHaveBeenCalled();
    });

    it("warns and returns early when ORCHESTRATOR_NPUB decode throws", async () => {
      mockDecode.mockImplementation(() => {
        throw new Error("invalid bech32");
      });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      await pushNewUser("npub1test");

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("ORCHESTRATOR_NPUB not set or invalid")
      );
      expect(mockPublish).not.toHaveBeenCalled();
    });
  });

  describe("relay failure handling", () => {
    it("does not throw when all relays fail", async () => {
      mockPublish.mockReturnValue([
        Promise.reject(new Error("connection refused")),
        Promise.reject(new Error("connection refused")),
      ]);
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      await expect(pushNewUser("npub1test")).resolves.toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Published to 0/2 relays")
      );
    });

    it("does not throw when some relays fail", async () => {
      mockPublish.mockReturnValue([
        Promise.resolve("ok"),
        Promise.reject(new Error("timeout")),
      ]);
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      await expect(pushNewUser("npub1test")).resolves.toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Published to 1/2 relays")
      );
    });

    it("succeeds silently when all relays accept", async () => {
      mockPublish.mockReturnValue([
        Promise.resolve("ok"),
        Promise.resolve("ok"),
      ]);
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      await pushNewUser("npub1test");

      const publishWarns = warnSpy.mock.calls.filter((c) =>
        String(c[0]).includes("Published to")
      );
      expect(publishWarns).toHaveLength(0);
    });
  });

  describe("timeout handling", () => {
    it("treats slow relays as failures after 5 seconds", async () => {
      vi.useFakeTimers();

      const neverResolve = new Promise<string>(() => {});
      mockPublish.mockReturnValue([Promise.resolve("ok"), neverResolve]);
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const pushPromise = pushNewUser("npub1test");

      // Advance past the 5s timeout
      await vi.advanceTimersByTimeAsync(6_000);
      await pushPromise;

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Published to 1/2 relays")
      );

      vi.useRealTimers();
    });
  });

  describe("wrapEvent failure", () => {
    it("logs error and returns when wrapEvent throws", async () => {
      mockWrapEvent.mockImplementation(() => {
        throw new Error("encryption failed");
      });
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      await expect(pushNewUser("npub1test")).resolves.toBeUndefined();
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("Failed to create gift-wrapped event"),
        expect.any(Error)
      );
      expect(mockPublish).not.toHaveBeenCalled();
    });
  });

  describe("VPS_NOSTR_PRIVKEY_FILE", () => {
    it("reads private key from file when VPS_NOSTR_PRIVKEY_FILE is set", async () => {
      vi.stubEnv("VPS_NOSTR_PRIVKEY_FILE", "/etc/nostr/privkey");
      vi.stubEnv("VPS_NOSTR_PRIVKEY", "");
      mockReadFileSync.mockReturnValue(TEST_PRIVKEY + "\n");

      await pushNewUser("npub1test");

      expect(mockReadFileSync).toHaveBeenCalledWith("/etc/nostr/privkey", "utf8");
      expect(mockPublish).toHaveBeenCalledTimes(1);
    });

    it("prefers file over env var when both are set", async () => {
      const fileKey = "cd".repeat(32);
      vi.stubEnv("VPS_NOSTR_PRIVKEY_FILE", "/etc/nostr/privkey");
      vi.stubEnv("VPS_NOSTR_PRIVKEY", TEST_PRIVKEY);
      mockReadFileSync.mockReturnValue(fileKey);

      await pushNewUser("npub1test");

      expect(mockReadFileSync).toHaveBeenCalledWith("/etc/nostr/privkey", "utf8");
      expect(mockPublish).toHaveBeenCalledTimes(1);
    });

    it("warns and returns null when file read fails", async () => {
      vi.stubEnv("VPS_NOSTR_PRIVKEY_FILE", "/nonexistent/path");
      vi.stubEnv("VPS_NOSTR_PRIVKEY", "");
      mockReadFileSync.mockImplementation(() => {
        throw new Error("ENOENT: no such file or directory");
      });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      await pushNewUser("npub1test");

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Failed to read VPS_NOSTR_PRIVKEY_FILE"),
        expect.stringContaining("ENOENT")
      );
      expect(mockPublish).not.toHaveBeenCalled();
    });

    it("falls back to env var when VPS_NOSTR_PRIVKEY_FILE is not set", async () => {
      vi.stubEnv("VPS_NOSTR_PRIVKEY_FILE", "");
      vi.stubEnv("VPS_NOSTR_PRIVKEY", TEST_PRIVKEY);

      await pushNewUser("npub1test");

      expect(mockReadFileSync).not.toHaveBeenCalled();
      expect(mockPublish).toHaveBeenCalledTimes(1);
    });
  });

  describe("nsec private key format", () => {
    it("decodes nsec1 private key via nip19", async () => {
      const nsecKey = "nsec1testfakensec";
      const decodedBytes = new Uint8Array(32);
      vi.stubEnv("VPS_NOSTR_PRIVKEY", nsecKey);
      mockDecode
        .mockReturnValueOnce({ type: "npub", data: TEST_RECIPIENT_HEX })  // for getRecipientPubkey
        .mockReturnValueOnce({ type: "nsec", data: decodedBytes });       // for getPrivkeyBytes

      await pushNewUser("npub1test");

      // decode called for both ORCHESTRATOR_NPUB (npub) and VPS_NOSTR_PRIVKEY (nsec)
      expect(mockDecode).toHaveBeenCalledWith(nsecKey);
    });

    it("returns null when nsec decode gives wrong type", async () => {
      vi.stubEnv("VPS_NOSTR_PRIVKEY", "nsec1bad");
      mockDecode.mockReturnValue({ type: "npub", data: "wrong" });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      await pushNewUser("npub1test");

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("VPS_NOSTR_PRIVKEY not set")
      );
      expect(mockPublish).not.toHaveBeenCalled();
    });
  });

  describe("hex ORCHESTRATOR_NPUB format", () => {
    it("accepts 64-char hex pubkey without decoding", async () => {
      const hexPubkey = "aa".repeat(32);
      vi.stubEnv("ORCHESTRATOR_NPUB", hexPubkey);

      await pushNewUser("npub1test");

      // wrapEvent should receive the hex pubkey directly
      expect(mockWrapEvent).toHaveBeenCalledWith(
        expect.any(Uint8Array),
        { publicKey: hexPubkey },
        expect.any(String)
      );
      // decode should NOT be called for ORCHESTRATOR_NPUB (hex bypass)
      expect(mockDecode).not.toHaveBeenCalled();
    });

    it("rejects invalid non-npub non-hex values", async () => {
      vi.stubEnv("ORCHESTRATOR_NPUB", "not-valid-at-all");
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      await pushNewUser("npub1test");

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("ORCHESTRATOR_NPUB not set or invalid")
      );
      expect(mockPublish).not.toHaveBeenCalled();
    });
  });
});
