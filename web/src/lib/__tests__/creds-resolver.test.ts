import { describe, it, expect } from "vitest";
import { getCredsForGroup } from "../creds-resolver";

const sharedCreds = { email: "shared@example.com", password: "shared-pass" };

const perServiceCreds: Record<string, { email: string; password: string }> = {
  netflix: { email: "netflix@example.com", password: "netflix-pass" },
  hulu: { email: "hulu@example.com", password: "hulu-pass" },
};

describe("getCredsForGroup", () => {
  // --- useSameCreds = true ---

  it("returns shared creds when useSameCreds is true, even if per-service creds exist", () => {
    const result = getCredsForGroup("netflix", true, sharedCreds, perServiceCreds);
    expect(result).toEqual(sharedCreds);
  });

  it("returns shared creds for a service with no per-service creds when useSameCreds is true", () => {
    const result = getCredsForGroup("disney_plus", true, sharedCreds, perServiceCreds);
    expect(result).toEqual(sharedCreds);
  });

  it("returns shared creds for all services when useSameCreds is true", () => {
    const services = ["netflix", "hulu", "disney_plus", "prime_video"];
    for (const svc of services) {
      const result = getCredsForGroup(svc, true, sharedCreds, perServiceCreds);
      expect(result).toEqual(sharedCreds);
    }
  });

  // --- useSameCreds = false ---

  it("returns per-service creds when useSameCreds is false", () => {
    const result = getCredsForGroup("netflix", false, sharedCreds, perServiceCreds);
    expect(result).toEqual({ email: "netflix@example.com", password: "netflix-pass" });
  });

  it("returns different creds per service when useSameCreds is false", () => {
    const netflix = getCredsForGroup("netflix", false, sharedCreds, perServiceCreds);
    const hulu = getCredsForGroup("hulu", false, sharedCreds, perServiceCreds);
    expect(netflix.email).toBe("netflix@example.com");
    expect(hulu.email).toBe("hulu@example.com");
    expect(netflix).not.toEqual(hulu);
  });

  it("returns empty creds for unknown group when useSameCreds is false", () => {
    const result = getCredsForGroup("unknown", false, sharedCreds, perServiceCreds);
    expect(result).toEqual({ email: "", password: "" });
  });

  // --- The critical scenario: user enters per-service creds, then toggles shared ---

  it("scenario: per-service creds entered first, then shared toggle — shared wins", () => {
    // User typed netflix-specific creds, then checked "use same" and typed shared creds
    const perService = {
      netflix: { email: "old-netflix@example.com", password: "old-netflix-pass" },
      hulu: { email: "old-hulu@example.com", password: "old-hulu-pass" },
    };
    const shared = { email: "new-shared@example.com", password: "new-shared-pass" };

    // With useSameCreds = true, every service gets shared creds
    const netflixCreds = getCredsForGroup("netflix", true, shared, perService);
    const huluCreds = getCredsForGroup("hulu", true, shared, perService);

    expect(netflixCreds).toEqual(shared);
    expect(huluCreds).toEqual(shared);
    // Old per-service creds are NOT used
    expect(netflixCreds.email).not.toBe("old-netflix@example.com");
    expect(huluCreds.email).not.toBe("old-hulu@example.com");
  });

  it("scenario: shared creds entered, then toggle off — per-service creds restored", () => {
    const shared = { email: "shared@example.com", password: "shared-pass" };
    const perService = {
      netflix: { email: "my-netflix@example.com", password: "my-pass" },
    };

    // Toggle off — per-service creds are used again
    const result = getCredsForGroup("netflix", false, shared, perService);
    expect(result).toEqual({ email: "my-netflix@example.com", password: "my-pass" });
  });
});
