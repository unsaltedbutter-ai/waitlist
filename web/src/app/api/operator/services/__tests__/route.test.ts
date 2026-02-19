import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockQueryResult } from "@/__test-utils__/fixtures";

vi.mock("@/lib/db", () => ({
  query: vi.fn(),
}));
vi.mock("@/lib/operator-auth", () => ({
  withOperator: vi.fn((handler: Function) => {
    return async (req: Request, segmentData: any) => {
      const params = segmentData?.params ? await segmentData.params : undefined;
      return handler(req, { userId: "operator-user-id", params });
    };
  }),
}));

import { query } from "@/lib/db";
import { GET, POST } from "../route";

function makeRequest(method: string, body?: unknown): Request {
  return new Request("http://localhost/api/operator/services", {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

beforeEach(() => {
  vi.mocked(query).mockReset();
});

describe("GET /api/operator/services", () => {
  it("returns all services", async () => {
    const services = [
      { id: "netflix", display_name: "Netflix", supported: true },
      { id: "hulu", display_name: "Hulu", supported: false },
    ];
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult(services));

    const res = await GET(makeRequest("GET") as any, {});
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.services).toHaveLength(2);
    expect(data.services[0].id).toBe("netflix");
  });

  it("returns empty array when no services exist", async () => {
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const res = await GET(makeRequest("GET") as any, {});
    const data = await res.json();
    expect(data.services).toEqual([]);
  });
});

describe("POST /api/operator/services", () => {
  it("creates service with slugified id", async () => {
    // Duplicate check
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));
    // INSERT
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ id: "crunchyroll", display_name: "Crunchyroll", supported: true }])
    );
    // Audit log
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const res = await POST(
      makeRequest("POST", {
        display_name: "Crunchyroll",
        signup_url: "https://crunchyroll.com/signup",
      }) as any,
      {}
    );
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.service.id).toBe("crunchyroll");

    // Verify INSERT was called with slugified id
    const insertCall = vi.mocked(query).mock.calls[1];
    expect(insertCall[0]).toContain("INSERT INTO streaming_services");
    expect(insertCall[1]![0]).toBe("crunchyroll");
  });

  it("returns 409 on duplicate service id", async () => {
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ id: "netflix" }])
    );

    const res = await POST(
      makeRequest("POST", {
        display_name: "Netflix",
        signup_url: "https://netflix.com",
      }) as any,
      {}
    );
    expect(res.status).toBe(409);
  });

  it("returns 400 when display_name is missing", async () => {
    const res = await POST(
      makeRequest("POST", { signup_url: "https://example.com" }) as any,
      {}
    );
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/display_name/);
  });

  it("returns 400 when signup_url is missing", async () => {
    const res = await POST(
      makeRequest("POST", { display_name: "Test Service" }) as any,
      {}
    );
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/signup_url/);
  });

  it("writes audit log on create", async () => {
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ id: "test", display_name: "Test" }])
    );
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    await POST(
      makeRequest("POST", {
        display_name: "Test",
        signup_url: "https://test.com",
      }) as any,
      {}
    );

    const auditCall = vi.mocked(query).mock.calls[2];
    expect(auditCall[0]).toContain("operator_audit_log");
    expect(auditCall[1]![1]).toBe("streaming_service");
  });
});
