import { NextRequest, NextResponse } from "next/server";
import { withAgentAuth } from "@/lib/agent-auth";
import { query } from "@/lib/db";

const VALID_ACTIONS = ["cancel", "resume"];

const TERMINAL_STATUSES = [
  "completed_paid",
  "completed_eventual",
  "completed_reneged",
  "user_skip",
  "user_abandon",
  "implied_skip",
];

export const POST = withAgentAuth(async (_req: NextRequest, { body: rawBody, params }) => {
  const npub = params?.npub;

  if (!npub) {
    return NextResponse.json({ error: "Missing npub" }, { status: 400 });
  }

  const decodedNpub = decodeURIComponent(npub);

  let parsed: { service?: string; action?: string };
  try {
    parsed = JSON.parse(rawBody || "{}");
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

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

  // Verify user exists
  const userResult = await query<{ id: string; debt_sats: number }>(
    "SELECT id, debt_sats FROM users WHERE nostr_npub = $1",
    [decodedNpub]
  );

  if (userResult.rows.length === 0) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  const user = userResult.rows[0];

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

  // Check for existing non-terminal job for this user+service
  const placeholders = TERMINAL_STATUSES.map((_, i) => `$${i + 3}`).join(", ");
  const existingJob = await query<{ id: string }>(
    `SELECT id FROM jobs
     WHERE user_id = $1 AND service_id = $2 AND status NOT IN (${placeholders})
     LIMIT 1`,
    [user.id, service, ...TERMINAL_STATUSES]
  );

  if (existingJob.rows.length > 0) {
    return NextResponse.json(
      { error: "A non-terminal job already exists for this user and service" },
      { status: 409 }
    );
  }

  // Create the job
  const jobResult = await query<{ id: string }>(
    `INSERT INTO jobs (user_id, service_id, action, trigger, status)
     VALUES ($1, $2, $3, 'on_demand', 'pending')
     RETURNING id`,
    [user.id, service, action]
  );

  return NextResponse.json({
    job_id: jobResult.rows[0].id,
    status: "pending",
  });
});
