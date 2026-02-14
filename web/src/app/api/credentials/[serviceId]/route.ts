import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/auth";
import { query } from "@/lib/db";

export const DELETE = withAuth(async (_req: NextRequest, { userId, params }) => {
  const serviceId = params?.serviceId;
  if (!serviceId) {
    return NextResponse.json({ error: "Missing serviceId" }, { status: 400 });
  }

  const result = await query(
    "DELETE FROM streaming_credentials WHERE user_id = $1 AND service_id = $2 RETURNING id",
    [userId, serviceId]
  );

  if (result.rows.length === 0) {
    return NextResponse.json(
      { error: "Credentials not found" },
      { status: 404 }
    );
  }

  return NextResponse.json({ success: true });
});
