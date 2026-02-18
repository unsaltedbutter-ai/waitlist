import { NextRequest, NextResponse } from "next/server";
import { withOperator } from "@/lib/operator-auth";
import { query } from "@/lib/db";

const EXPECTED_COMPONENTS = ["orchestrator", "agent", "inference"] as const;

type HeartbeatStatus = "healthy" | "warning" | "critical" | "unknown";

interface HeartbeatRow {
  component: string;
  last_seen_at: string;
  payload: unknown;
  updated_at: string;
}

interface ComponentStatus {
  component: string;
  status: HeartbeatStatus;
  last_seen_at: string | null;
  payload: unknown;
}

function computeStatus(lastSeenAt: Date): HeartbeatStatus {
  const ageMs = Date.now() - lastSeenAt.getTime();
  const ageMinutes = ageMs / 60_000;

  if (ageMinutes < 10) return "healthy";
  if (ageMinutes < 30) return "warning";
  return "critical";
}

export const GET = withOperator(async (_req: NextRequest) => {
  try {
    const result = await query<HeartbeatRow>(
      `SELECT component, last_seen_at, payload, updated_at
       FROM system_heartbeats`
    );

    const rowMap = new Map<string, HeartbeatRow>();
    for (const row of result.rows) {
      rowMap.set(row.component, row);
    }

    const components: ComponentStatus[] = EXPECTED_COMPONENTS.map((name) => {
      const row = rowMap.get(name);
      if (!row) {
        return {
          component: name,
          status: "unknown" as HeartbeatStatus,
          last_seen_at: null,
          payload: null,
        };
      }
      return {
        component: name,
        status: computeStatus(new Date(row.last_seen_at)),
        last_seen_at: row.last_seen_at,
        payload: row.payload,
      };
    });

    return NextResponse.json({ components });
  } catch (err) {
    console.error("Heartbeats fetch error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
});
