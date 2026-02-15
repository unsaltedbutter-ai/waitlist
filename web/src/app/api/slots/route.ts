import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/auth";
import { query } from "@/lib/db";

export const GET = withAuth(async (_req: NextRequest, { userId }) => {
  const result = await query(
    `SELECT rs.slot_number,
            rs.current_service_id,
            cs.display_name AS current_service_name,
            rs.next_service_id,
            ns.display_name AS next_service_name,
            rs.locked_at,
            s.status AS subscription_status,
            s.subscription_end_date
     FROM rotation_slots rs
     LEFT JOIN streaming_services cs ON cs.id = rs.current_service_id
     LEFT JOIN streaming_services ns ON ns.id = rs.next_service_id
     LEFT JOIN subscriptions s ON s.user_id = rs.user_id
       AND s.service_id = rs.current_service_id
       AND s.status IN ('active', 'signup_scheduled', 'cancel_scheduled')
     WHERE rs.user_id = $1
     ORDER BY rs.slot_number`,
    [userId]
  );

  return NextResponse.json({ slots: result.rows });
});
