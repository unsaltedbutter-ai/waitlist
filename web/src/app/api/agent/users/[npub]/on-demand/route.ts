import { NextRequest, NextResponse } from "next/server";
import { withAgentAuth } from "@/lib/agent-auth";
import { query } from "@/lib/db";
import { getUserByNpub } from "@/lib/queries";
import { parseJsonBody } from "@/lib/parse-json-body";

const VALID_ACTIONS = ["cancel", "resume"];

export const POST = withAgentAuth(async (_req: NextRequest, { body: rawBody, params }) => {
  const npub = params?.npub;

  if (!npub) {
    return NextResponse.json({ error: "Missing npub" }, { status: 400 });
  }

  const { data: parsed, error } = parseJsonBody<{ service?: string; action?: string }>(rawBody);
  if (error) return error;

  const { service, action } = parsed;

  if (!service || !action) {
    return NextResponse.json(
      { error: "Missing required fields: service, action" },
      { status: 400 }
    );
  }

  if (!VALID_ACTIONS.includes(action)) {
    return NextResponse.json(
      { error: `Invalid action: must be one of ${VALID_ACTIONS.join(", ")}` },
      { status: 400 }
    );
  }

  try {
    // Verify user exists
    const user = await getUserByNpub(npub);

    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    // Check for outstanding debt
    if (user.debt_sats > 0) {
      return NextResponse.json(
        { error: "Outstanding debt", debt_sats: user.debt_sats },
        { status: 403 }
      );
    }

    // Verify service exists
    const serviceResult = await query<{ id: string }>(
      "SELECT id FROM streaming_services WHERE id = $1",
      [service]
    );

    if (serviceResult.rows.length === 0) {
      return NextResponse.json(
        { error: `Invalid service: ${service}` },
        { status: 400 }
      );
    }

    // Verify user has credentials for this service
    const credResult = await query<{ id: string }>(
      "SELECT id FROM streaming_credentials WHERE user_id = $1 AND service_id = $2",
      [user.id, service]
    );

    if (credResult.rows.length === 0) {
      return NextResponse.json(
        { error: `No credentials for service: ${service}` },
        { status: 400 }
      );
    }

    // Attempt insert; the partial unique index idx_jobs_active_user_service
    // prevents duplicate non-terminal jobs for the same user+service.
    const jobResult = await query<{ id: string }>(
      `INSERT INTO jobs (user_id, service_id, action, trigger, status)
       VALUES ($1, $2, $3, 'on_demand', 'pending')
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [user.id, service, action]
    );

    if (jobResult.rows.length === 0) {
      return NextResponse.json(
        { error: "A non-terminal job already exists for this user and service" },
        { status: 409 }
      );
    }

    return NextResponse.json({
      job_id: jobResult.rows[0].id,
      status: "pending",
    });
  } catch (err) {
    console.error("Agent on-demand job create error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
});
