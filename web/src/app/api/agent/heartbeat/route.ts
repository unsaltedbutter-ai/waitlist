import { NextRequest, NextResponse } from "next/server";
import { withAgentAuth } from "@/lib/agent-auth";
import { query } from "@/lib/db";
import { TERMINAL_STATUSES } from "@/lib/constants";
import { UUID_REGEX } from "@/lib/constants";

const VALID_COMPONENTS = ["orchestrator", "agent", "inference"] as const;
type Component = (typeof VALID_COMPONENTS)[number];

const MAX_JOB_IDS = 200;

function isValidComponent(value: unknown): value is Component {
  return typeof value === "string" && VALID_COMPONENTS.includes(value as Component);
}

export const POST = withAgentAuth(async (_req: NextRequest, ctx) => {
  let parsed: { component: unknown; payload?: unknown; job_ids?: unknown };
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

    // Check for job_ids to reconcile
    let cancelledJobs: { id: string; status: string }[] = [];

    if (Array.isArray(parsed.job_ids) && parsed.job_ids.length > 0) {
      const jobIds = parsed.job_ids.slice(0, MAX_JOB_IDS);

      // Validate all entries are UUID strings
      const valid = jobIds.every(
        (id: unknown) => typeof id === "string" && UUID_REGEX.test(id)
      );

      if (valid && jobIds.length > 0) {
        const terminalPlaceholders = TERMINAL_STATUSES.map(
          (_, i) => `$${jobIds.length + i + 1}`
        ).join(", ");
        const idPlaceholders = jobIds.map((_: string, i: number) => `$${i + 1}`).join(", ");

        const result = await query<{ id: string; status: string }>(
          `SELECT id, status FROM jobs
           WHERE id IN (${idPlaceholders})
             AND status IN (${terminalPlaceholders})`,
          [...jobIds, ...TERMINAL_STATUSES]
        );
        cancelledJobs = result.rows;
      }
    }

    return NextResponse.json({ ok: true, cancelled_jobs: cancelledJobs });
  } catch (err) {
    console.error("Heartbeat upsert error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
});
