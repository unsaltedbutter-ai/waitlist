/**
 * Auth integration tests: verify that every route actually requires
 * authentication when the auth middleware runs un-mocked.
 *
 * We mock ONLY the database layer (and crypto/btcpay), never the auth wrappers.
 * If someone removes withAuth/withAgentAuth/withOperator from a route export,
 * these tests will catch it.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { TEST_JWT_SECRET } from "@/__test-utils__/fixtures";

// ---------------------------------------------------------------------------
// Mock the database layer (never the auth middleware)
// ---------------------------------------------------------------------------
vi.mock("@/lib/db", () => ({
  query: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock("@/lib/queries", () => ({
  getUserByNpub: vi.fn(),
}));

vi.mock("@/lib/crypto", () => ({
  encrypt: vi.fn(() => Buffer.from("encrypted")),
  decrypt: vi.fn(() => "decrypted"),
}));

vi.mock("@/lib/btcpay-invoice", () => ({
  createLightningInvoice: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Set env vars BEFORE any auth module is loaded
// ---------------------------------------------------------------------------
const NON_OPERATOR_USER_ID = "non-operator-user-id-1234";
const OPERATOR_USER_ID = "the-real-operator-id-5678";

process.env.JWT_SECRET = TEST_JWT_SECRET;
process.env.AGENT_HMAC_SECRET = "test-hmac-secret-for-integration";
process.env.OPERATOR_USER_ID = OPERATOR_USER_ID;

// ---------------------------------------------------------------------------
// Import createToken AFTER env is set so jose picks up the secret
// ---------------------------------------------------------------------------
import { createToken } from "@/lib/auth";

// ---------------------------------------------------------------------------
// Import route handlers (these are wrapped in withAuth / withAgentAuth / withOperator)
// ---------------------------------------------------------------------------
import { GET as meGET } from "@/app/api/me/route";
import { POST as consentPOST } from "@/app/api/consent/route";
import { GET as credentialsGET, POST as credentialsPOST } from "@/app/api/credentials/route";
import { GET as queueGET, PUT as queuePUT } from "@/app/api/queue/route";
import { GET as accountGET, DELETE as accountDELETE } from "@/app/api/account/route";

import { POST as agentJobsClaimPOST } from "@/app/api/agent/jobs/claim/route";
import { PATCH as agentJobsStatusPATCH } from "@/app/api/agent/jobs/[id]/status/route";
import { POST as agentJobsPaidPOST } from "@/app/api/agent/jobs/[id]/paid/route";
import { GET as agentInvoicesIdGET } from "@/app/api/agent/invoices/[id]/route";
import { GET as agentUsersNpubGET } from "@/app/api/agent/users/[npub]/route";
import { GET as agentCredentialsGET } from "@/app/api/agent/credentials/[npub]/[service]/route";

import { GET as operatorAlertsGET } from "@/app/api/operator/alerts/route";
import { GET as operatorMetricsGET } from "@/app/api/operator/metrics/route";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a NextRequest with optional headers. */
function makeReq(
  url: string,
  opts?: { method?: string; headers?: Record<string, string>; body?: string }
): NextRequest {
  const init: RequestInit = { method: opts?.method ?? "GET" };
  if (opts?.headers) init.headers = opts.headers;
  if (opts?.body) init.body = opts.body;
  return new NextRequest(new URL(url, "http://localhost"), init);
}

/** Default segmentData passed by Next.js to route handlers. */
function seg(params: Record<string, string> = {}): {
  params: Promise<Record<string, string>>;
} {
  return { params: Promise.resolve(params) };
}

// ==========================================================================
// 1. User routes (withAuth): no token -> 401, bad token -> 401
// ==========================================================================
describe("withAuth routes reject unauthenticated requests", () => {
  const userRoutes: {
    name: string;
    handler: Function;
    method: string;
    url: string;
    params?: Record<string, string>;
    body?: string;
  }[] = [
    { name: "GET /api/me", handler: meGET, method: "GET", url: "/api/me" },
    {
      name: "POST /api/consent",
      handler: consentPOST,
      method: "POST",
      url: "/api/consent",
      body: JSON.stringify({ consentType: "authorization" }),
    },
    {
      name: "GET /api/credentials",
      handler: credentialsGET,
      method: "GET",
      url: "/api/credentials",
    },
    {
      name: "POST /api/credentials",
      handler: credentialsPOST,
      method: "POST",
      url: "/api/credentials",
      body: JSON.stringify({
        serviceId: "netflix",
        email: "a@b.com",
        password: "pw",
      }),
    },
    { name: "GET /api/queue", handler: queueGET, method: "GET", url: "/api/queue" },
    {
      name: "PUT /api/queue",
      handler: queuePUT,
      method: "PUT",
      url: "/api/queue",
      body: JSON.stringify({ order: ["netflix"] }),
    },
    { name: "GET /api/account", handler: accountGET, method: "GET", url: "/api/account" },
    {
      name: "DELETE /api/account",
      handler: accountDELETE,
      method: "DELETE",
      url: "/api/account",
    },
  ];

  describe("no Authorization header", () => {
    for (const route of userRoutes) {
      it(`${route.name} returns 401`, async () => {
        const req = makeReq(route.url, {
          method: route.method,
          headers: { "content-type": "application/json" },
          body: route.body,
        });
        const res = await (route.handler as Function)(req, seg(route.params));
        expect(res.status).toBe(401);
        const data = await res.json();
        expect(data.error).toBe("Unauthorized");
      });
    }
  });

  describe("invalid JWT token", () => {
    for (const route of userRoutes) {
      it(`${route.name} returns 401`, async () => {
        const req = makeReq(route.url, {
          method: route.method,
          headers: {
            "content-type": "application/json",
            authorization: "Bearer totally-not-a-valid-jwt",
          },
          body: route.body,
        });
        const res = await (route.handler as Function)(req, seg(route.params));
        expect(res.status).toBe(401);
        const data = await res.json();
        expect(data.error).toBe("Unauthorized");
      });
    }
  });

  describe("malformed Authorization header (no Bearer prefix)", () => {
    for (const route of userRoutes) {
      it(`${route.name} returns 401`, async () => {
        const req = makeReq(route.url, {
          method: route.method,
          headers: {
            "content-type": "application/json",
            authorization: "Token some-value",
          },
          body: route.body,
        });
        const res = await (route.handler as Function)(req, seg(route.params));
        expect(res.status).toBe(401);
        const data = await res.json();
        expect(data.error).toBe("Unauthorized");
      });
    }
  });
});

// ==========================================================================
// 2. Agent routes (withAgentAuth): missing/invalid HMAC headers -> 401
// ==========================================================================
describe("withAgentAuth routes reject unauthenticated requests", () => {
  const agentRoutes: {
    name: string;
    handler: Function;
    method: string;
    url: string;
    params?: Record<string, string>;
    body?: string;
  }[] = [
    {
      name: "POST /api/agent/jobs/claim",
      handler: agentJobsClaimPOST,
      method: "POST",
      url: "/api/agent/jobs/claim",
      body: JSON.stringify({ job_ids: ["a1b2c3d4-e5f6-7890-abcd-ef1234567890"] }),
    },
    {
      name: "PATCH /api/agent/jobs/[id]/status",
      handler: agentJobsStatusPATCH,
      method: "PATCH",
      url: "/api/agent/jobs/a1b2c3d4-e5f6-7890-abcd-ef1234567890/status",
      params: { id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890" },
      body: JSON.stringify({ status: "active" }),
    },
    {
      name: "POST /api/agent/jobs/[id]/paid",
      handler: agentJobsPaidPOST,
      method: "POST",
      url: "/api/agent/jobs/a1b2c3d4-e5f6-7890-abcd-ef1234567890/paid",
      params: { id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890" },
      body: JSON.stringify({}),
    },
    {
      name: "GET /api/agent/invoices/[id]",
      handler: agentInvoicesIdGET,
      method: "GET",
      url: "/api/agent/invoices/a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      params: { id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890" },
    },
    {
      name: "GET /api/agent/users/[npub]",
      handler: agentUsersNpubGET,
      method: "GET",
      url: "/api/agent/users/npub1abc123",
      params: { npub: "npub1abc123" },
    },
    {
      name: "GET /api/agent/credentials/[npub]/[service]",
      handler: agentCredentialsGET,
      method: "GET",
      url: "/api/agent/credentials/npub1abc123/netflix",
      params: { npub: "npub1abc123", service: "netflix" },
    },
  ];

  describe("no HMAC headers at all", () => {
    for (const route of agentRoutes) {
      it(`${route.name} returns 401`, async () => {
        const req = makeReq(route.url, {
          method: route.method,
          headers: { "content-type": "application/json" },
          body: route.body,
        });
        const res = await (route.handler as Function)(req, seg(route.params));
        expect(res.status).toBe(401);
        const data = await res.json();
        expect(data.error).toBe("Unauthorized");
      });
    }
  });

  describe("HMAC headers present but signature is invalid", () => {
    for (const route of agentRoutes) {
      it(`${route.name} returns 401`, async () => {
        const now = Math.floor(Date.now() / 1000).toString();
        const req = makeReq(route.url, {
          method: route.method,
          headers: {
            "content-type": "application/json",
            "x-agent-timestamp": now,
            "x-agent-nonce": "bad-nonce-value-123",
            "x-agent-signature": "definitely-not-a-valid-hmac-signature",
          },
          body: route.body,
        });
        const res = await (route.handler as Function)(req, seg(route.params));
        expect(res.status).toBe(401);
        const data = await res.json();
        expect(data.error).toBe("Unauthorized");
      });
    }
  });

  describe("HMAC headers with expired timestamp", () => {
    for (const route of agentRoutes) {
      it(`${route.name} returns 401`, async () => {
        // Timestamp 10 minutes in the past (well outside the 60s window)
        const staleTs = (Math.floor(Date.now() / 1000) - 600).toString();
        const req = makeReq(route.url, {
          method: route.method,
          headers: {
            "content-type": "application/json",
            "x-agent-timestamp": staleTs,
            "x-agent-nonce": "stale-nonce-456",
            "x-agent-signature": "does-not-matter",
          },
          body: route.body,
        });
        const res = await (route.handler as Function)(req, seg(route.params));
        expect(res.status).toBe(401);
        const data = await res.json();
        expect(data.error).toBe("Unauthorized");
      });
    }
  });
});

// ==========================================================================
// 3. Operator routes (withOperator): valid JWT but non-operator user -> 403
// ==========================================================================
describe("withOperator routes reject non-operator users", () => {
  let nonOperatorToken: string;

  beforeAll(async () => {
    // Create a real, valid JWT for a user who is NOT the operator
    nonOperatorToken = await createToken(NON_OPERATOR_USER_ID);
  });

  const operatorRoutes: {
    name: string;
    handler: Function;
    method: string;
    url: string;
  }[] = [
    {
      name: "GET /api/operator/alerts",
      handler: operatorAlertsGET,
      method: "GET",
      url: "/api/operator/alerts",
    },
    {
      name: "GET /api/operator/metrics",
      handler: operatorMetricsGET,
      method: "GET",
      url: "/api/operator/metrics",
    },
  ];

  describe("no Authorization header (should be 401, not 403)", () => {
    for (const route of operatorRoutes) {
      it(`${route.name} returns 401`, async () => {
        const req = makeReq(route.url, { method: route.method });
        const res = await (route.handler as Function)(req, seg());
        expect(res.status).toBe(401);
        const data = await res.json();
        expect(data.error).toBe("Unauthorized");
      });
    }
  });

  describe("valid JWT for non-operator user (should be 403)", () => {
    for (const route of operatorRoutes) {
      it(`${route.name} returns 403`, async () => {
        const req = makeReq(route.url, {
          method: route.method,
          headers: { authorization: `Bearer ${nonOperatorToken}` },
        });
        const res = await (route.handler as Function)(req, seg());
        expect(res.status).toBe(403);
        const data = await res.json();
        expect(data.error).toBe("Forbidden");
      });
    }
  });

  describe("invalid JWT (should be 401, not 403)", () => {
    for (const route of operatorRoutes) {
      it(`${route.name} returns 401`, async () => {
        const req = makeReq(route.url, {
          method: route.method,
          headers: { authorization: "Bearer garbage-token" },
        });
        const res = await (route.handler as Function)(req, seg());
        expect(res.status).toBe(401);
        const data = await res.json();
        expect(data.error).toBe("Unauthorized");
      });
    }
  });
});
