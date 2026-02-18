import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockQueryResult } from "@/__test-utils__/fixtures";

vi.mock("@/lib/db", () => ({
  query: vi.fn(),
}));

import { query } from "@/lib/db";
import { POST } from "../route";

// Each test gets a unique IP so the in-memory rate limiter doesn't bleed state
let testIpCounter = 0;
function uniqueIp(): string {
  testIpCounter++;
  return `10.3.${Math.floor(testIpCounter / 256)}.${testIpCounter % 256}`;
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
});

describe("POST /api/waitlist", () => {
  it("valid npub -> 201", async () => {
    // Duplicate check: none found
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));
    // Insert
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const res = await POST(
      makeRequest({ nostrNpub: "npub1abc123def456" }) as any
    );
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.message).toMatch(/in/i);
  });

  it("missing nostrNpub -> 400", async () => {
    const res = await POST(
      makeRequest({}) as any
    );
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/nostrNpub/);
  });

  it("invalid npub format -> 400", async () => {
    const res = await POST(
      makeRequest({ nostrNpub: "not-an-npub" }) as any
    );
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/npub/i);
  });

  it("duplicate npub -> 409", async () => {
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ id: "existing" }])
    );

    const res = await POST(
      makeRequest({ nostrNpub: "npub1already_here" }) as any
    );
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.error).toMatch(/already/i);
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

  it("INSERT query receives correct npub", async () => {
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    await POST(
      makeRequest({ nostrNpub: "npub1testvalue" }) as any
    );

    const insertCall = vi.mocked(query).mock.calls[1];
    expect(insertCall[0]).toContain("INSERT INTO waitlist");
    expect(insertCall[1]).toEqual(["npub1testvalue"]);
  });
});
