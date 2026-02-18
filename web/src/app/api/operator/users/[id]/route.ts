import { NextRequest, NextResponse } from "next/server";
import { withOperator } from "@/lib/operator-auth";
import { query } from "@/lib/db";

export const GET = withOperator(
  async (_req: NextRequest, { params }: { userId: string; params?: Record<string, string> }) => {
    const id = params?.id;
    if (!id) {
      return NextResponse.json({ error: "Missing user id" }, { status: 400 });
    }

    // User profile
    const userResult = await query<{
      id: string;
      nostr_npub: string;
      debt_sats: number;
      onboarded_at: string | null;
      created_at: string;
      updated_at: string;
    }>("SELECT id, nostr_npub, debt_sats, onboarded_at, created_at, updated_at FROM users WHERE id = $1", [id]);

    if (userResult.rows.length === 0) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const user = userResult.rows[0];

    // Queue items with plan names
    const queueResult = await query<{
      id: string;
      service_id: string;
      position: number;
      plan_id: string | null;
      plan_name: string | null;
      created_at: string;
    }>(
      `SELECT
         rq.id,
         rq.service_id,
         rq.position,
         rq.plan_id,
         sp.display_name AS plan_name,
         rq.created_at
       FROM rotation_queue rq
       LEFT JOIN service_plans sp ON sp.id = rq.plan_id
       WHERE rq.user_id = $1
       ORDER BY rq.position ASC`,
      [id]
    );

    // Recent jobs (last 20)
    const jobsResult = await query<{
      id: string;
      service_id: string;
      action: string;
      trigger: string;
      status: string;
      status_updated_at: string;
      billing_date: string | null;
      amount_sats: number | null;
      created_at: string;
    }>(
      `SELECT id, service_id, action, trigger, status, status_updated_at, billing_date, amount_sats, created_at
       FROM jobs
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 20`,
      [id]
    );

    // Credentials (service names only, no encrypted values)
    const credentialsResult = await query<{
      id: string;
      service_id: string;
      created_at: string;
      updated_at: string;
    }>(
      `SELECT id, service_id, created_at, updated_at
       FROM streaming_credentials
       WHERE user_id = $1
       ORDER BY service_id ASC`,
      [id]
    );

    // Consents
    const consentsResult = await query<{
      id: string;
      consent_type: string;
      created_at: string;
    }>(
      `SELECT id, consent_type, created_at
       FROM user_consents
       WHERE user_id = $1
       ORDER BY created_at DESC`,
      [id]
    );

    // Total transactions
    const txResult = await query<{
      total_count: string;
      total_sats: string;
    }>(
      `SELECT COUNT(*)::int AS total_count, COALESCE(SUM(amount_sats), 0)::bigint AS total_sats
       FROM transactions
       WHERE user_id = $1`,
      [id]
    );

    const tx = txResult.rows[0] ?? { total_count: "0", total_sats: "0" };

    return NextResponse.json({
      user,
      queue: queueResult.rows,
      jobs: jobsResult.rows,
      credentials: credentialsResult.rows,
      consents: consentsResult.rows,
      transactions: {
        total_count: Number(tx.total_count),
        total_sats: Number(tx.total_sats),
      },
    });
  }
);
