import { NextResponse } from "next/server";

/**
 * Parse a JSON body string, returning either the parsed data or
 * a 400 error response. Used by agent routes where withAgentAuth
 * passes the raw body string.
 */
export function parseJsonBody<T>(
  body: string
): { data: T; error: null } | { data: null; error: NextResponse } {
  try {
    const data = JSON.parse(body || "{}") as T;
    return { data, error: null };
  } catch {
    return {
      data: null,
      error: NextResponse.json({ error: "Invalid JSON" }, { status: 400 }),
    };
  }
}
