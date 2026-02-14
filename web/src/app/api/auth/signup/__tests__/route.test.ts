import { describe, it, expect, beforeEach, vi } from "vitest";
import { TEST_JWT_SECRET, mockQueryResult } from "@/__test-utils__/fixtures";

vi.mock("@/lib/db", () => ({
  query: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({
  createToken: vi.fn().mockResolvedValue("mock-jwt"),
  hashPassword: vi.fn().mockResolvedValue("hashed-pw"),
}));

import { query } from "@/lib/db";
import { POST } from "../route";

function makeRequest(body: object): Request {
  return new Request("http://localhost/api/auth/signup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.mocked(query).mockReset();
});

describe("POST /api/auth/signup", () => {
  it("valid signup → 201 + token", async () => {
    // Check existing: none
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));
    // Insert returning id
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ id: "new-user-123" }])
    );

    const res = await POST(
      makeRequest({ email: "test@example.com", password: "strongpassword" }) as any
    );
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.token).toBe("mock-jwt");
    expect(data.userId).toBe("new-user-123");
  });

  it("invalid email → 400", async () => {
    const res = await POST(
      makeRequest({ email: "not-an-email", password: "strongpassword" }) as any
    );
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/email/i);
  });

  it("short password → 400", async () => {
    const res = await POST(
      makeRequest({ email: "test@example.com", password: "short" }) as any
    );
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/8 characters/);
  });

  it("duplicate email → 409", async () => {
    // Existing user found
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ id: "existing-user" }])
    );

    const res = await POST(
      makeRequest({ email: "taken@example.com", password: "strongpassword" }) as any
    );
    expect(res.status).toBe(409);
  });

  it("missing fields → 400", async () => {
    const res = await POST(makeRequest({ email: "test@example.com" }) as any);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/required/i);
  });

  it("missing email → 400", async () => {
    const res = await POST(
      makeRequest({ password: "strongpassword" }) as any
    );
    expect(res.status).toBe(400);
  });
});
