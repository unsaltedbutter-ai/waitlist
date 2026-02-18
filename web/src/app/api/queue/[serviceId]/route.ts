import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/auth";
import { query, transaction } from "@/lib/db";
import { TERMINAL_STATUSES } from "@/lib/constants";

export const DELETE = withAuth(async (_req: NextRequest, { userId, params }) => {
  const serviceId = params?.serviceId;
  if (!serviceId) {
    return NextResponse.json({ error: "Missing serviceId" }, { status: 400 });
  }

  try {
    // Check that the service is in the user's queue
    const inQueue = await query(
      "SELECT service_id FROM rotation_queue WHERE user_id = $1 AND service_id = $2",
      [userId, serviceId]
    );
    if (inQueue.rows.length === 0) {
      return NextResponse.json(
        { error: "Service not in your queue" },
        { status: 404 }
      );
    }

    // Check for active (non-terminal) jobs on this service
    const activeJobs = await query(
      `SELECT id FROM jobs
       WHERE user_id = $1 AND service_id = $2
         AND status NOT IN (${TERMINAL_STATUSES.map((_, i) => `$${i + 3}`).join(", ")})
       LIMIT 1`,
      [userId, serviceId, ...TERMINAL_STATUSES]
    );
    if (activeJobs.rows.length > 0) {
      return NextResponse.json(
        { error: "Cannot remove a service with an active job. Wait for the job to complete." },
        { status: 409 }
      );
    }

    // In a transaction: delete queue entry, delete credentials, re-number positions
    const remaining = await transaction(async (txQuery) => {
      await txQuery(
        "DELETE FROM rotation_queue WHERE user_id = $1 AND service_id = $2",
        [userId, serviceId]
      );
      await txQuery(
        "DELETE FROM streaming_credentials WHERE user_id = $1 AND service_id = $2",
        [userId, serviceId]
      );

      // Re-number remaining positions
      const rows = await txQuery<{ service_id: string }>(
        "SELECT service_id FROM rotation_queue WHERE user_id = $1 ORDER BY position",
        [userId]
      );
      for (let i = 0; i < rows.rows.length; i++) {
        await txQuery(
          "UPDATE rotation_queue SET position = $1 WHERE user_id = $2 AND service_id = $3",
          [i + 1, userId, rows.rows[i].service_id]
        );
      }

      return rows.rows.length;
    });

    return NextResponse.json({ success: true, remaining });
  } catch (err) {
    console.error("Queue DELETE error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
});
