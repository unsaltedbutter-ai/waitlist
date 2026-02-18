import { NextRequest, NextResponse } from "next/server";
import { withAgentAuth } from "@/lib/agent-auth";
import { query } from "@/lib/db";

const VALID_COMPONENTS = ["orchestrator", "agent", "inference"] as const;
type Component = (typeof VALID_COMPONENTS)[number];

function isValidComponent(value: unknown): value is Component {
  return typeof value === "string" && VALID_COMPONENTS.includes(value as Component);
}

export const POST = withAgentAuth(async (_req: NextRequest, ctx) => {
  let parsed: { component: unknown; payload?: unknown };
  try {
    parsed = JSON.parse(ctx.body);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!isValidComponent(parsed.component)) {
    return NextResponse.json(
      { error: "Invalid component. Must be one of: orchestrator, agent, inference" },
      { status: 400 }
    );
  }

  const payload = parsed.payload !== undefined ? JSON.stringify(parsed.payload) : null;

  try {
    await query(
      `INSERT INTO system_heartbeats (component, last_seen_at, payload, updated_at)
       VALUES ($1, NOW(), $2::jsonb, NOW())
       ON CONFLICT (component) DO UPDATE
         SET last_seen_at = NOW(),
             payload = EXCLUDED.payload,
             updated_at = NOW()`,
      [parsed.component, payload]
    );

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("Heartbeat upsert error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
});
