import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockQueryResult } from "@/__test-utils__/fixtures";

vi.mock("@/lib/db", () => ({
  query: vi.fn(),
}));

import { query } from "@/lib/db";
import { POST } from "../route";

function makeRequest(body: object): Request {
  return new Request("http://localhost/api/waitlist", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.mocked(query).mockReset();
});

describe("POST /api/waitlist", () => {
  it("valid email → 201", async () => {
    // Duplicate check: none found
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));
    // Insert
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const res = await POST(
      makeRequest({
        contactType: "email",
        contactValue: "new@example.com",
        currentServices: ["netflix"],
      }) as any
    );
    expect(res.status).toBe(201);
  });

  it("valid npub → 201", async () => {
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const res = await POST(
      makeRequest({
        contactType: "npub",
        contactValue: "npub1abc123def456",
        currentServices: [],
      }) as any
    );
    expect(res.status).toBe(201);
  });

  it("invalid contactType → 400", async () => {
    const res = await POST(
      makeRequest({
        contactType: "phone",
        contactValue: "555-1234",
        currentServices: [],
      }) as any
    );
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/email or npub/);
  });

  it("invalid email format → 400", async () => {
    const res = await POST(
      makeRequest({
        contactType: "email",
        contactValue: "not-an-email",
        currentServices: [],
      }) as any
    );
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/email/i);
  });

  it("invalid npub format → 400", async () => {
    const res = await POST(
      makeRequest({
        contactType: "npub",
        contactValue: "not-an-npub",
        currentServices: [],
      }) as any
    );
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/npub/i);
  });

  it("duplicate email → 409", async () => {
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ id: "existing" }])
    );

    const res = await POST(
      makeRequest({
        contactType: "email",
        contactValue: "taken@example.com",
        currentServices: [],
      }) as any
    );
    expect(res.status).toBe(409);
  });

  it("duplicate npub → 409", async () => {
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ id: "existing" }])
    );

    const res = await POST(
      makeRequest({
        contactType: "npub",
        contactValue: "npub1already_here",
        currentServices: [],
      }) as any
    );
    expect(res.status).toBe(409);
  });
});
