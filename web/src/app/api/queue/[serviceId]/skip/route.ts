import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/auth";
import { query, transaction } from "@/lib/db";

export const POST = withAuth(async (_req: NextRequest, { userId, params }) => {
  const serviceId = params?.serviceId;
  if (!serviceId) {
    return NextResponse.json({ error: "Missing serviceId" }, { status: 400 });
  }

  // Get current position of this service
  const current = await query(
    "SELECT position FROM rotation_queue WHERE user_id = $1 AND service_id = $2",
    [userId, serviceId]
  );

  if (current.rows.length === 0) {
    return NextResponse.json(
      { error: "Service not in your queue" },
      { status: 404 }
    );
  }

  const skippedPosition = current.rows[0].position;

  // Get max position
  const maxResult = await query(
    "SELECT MAX(position) AS max_pos FROM rotation_queue WHERE user_id = $1",
    [userId]
  );
  const maxPos = maxResult.rows[0].max_pos;

  await transaction(async (txQuery) => {
    // Move skipped service to the end
    await txQuery(
      "UPDATE rotation_queue SET position = $3 WHERE user_id = $1 AND service_id = $2",
      [userId, serviceId, maxPos + 1]
    );

    // Shift everything above the skipped position down by 1
    await txQuery(
      `UPDATE rotation_queue
       SET position = position - 1
       WHERE user_id = $1 AND position > $2 AND service_id != $3`,
      [userId, skippedPosition, serviceId]
    );

    // Now set the skipped service to the actual last position
    await txQuery(
      "UPDATE rotation_queue SET position = $3 WHERE user_id = $1 AND service_id = $2",
      [userId, serviceId, maxPos]
    );
  });

  return NextResponse.json({ success: true });
});
