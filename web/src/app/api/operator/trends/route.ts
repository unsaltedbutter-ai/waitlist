import { NextRequest, NextResponse } from "next/server";
import { withOperator } from "@/lib/operator-auth";
import { query } from "@/lib/db";

export const GET = withOperator(async (req: NextRequest) => {
  const url = new URL(req.url);
  const days = Math.min(parseInt(url.searchParams.get("days") ?? "30", 10) || 30, 365);
  const bucket = url.searchParams.get("bucket") === "daily" ? "day" : "week";

  const [successRate, otpRate, avgInference, failureBreakdown] =
    await Promise.all([
      // 1. Success rate per service per bucket
      query(
        `SELECT
          DATE_TRUNC($1, al.created_at) AS bucket_date,
          al.service_id,
          ss.display_name AS service_name,
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE al.success)::int AS succeeded
        FROM action_logs al
        JOIN streaming_services ss ON ss.id = al.service_id
        WHERE al.created_at >= NOW() - ($2 || ' days')::interval
        GROUP BY 1, 2, 3
        ORDER BY 1, 3`,
        [bucket, String(days)]
      ),

      // 2. OTP rate per service per bucket
      query(
        `SELECT
          DATE_TRUNC($1, al.created_at) AS bucket_date,
          al.service_id,
          ss.display_name AS service_name,
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE al.otp_required)::int AS otp_count
        FROM action_logs al
        JOIN streaming_services ss ON ss.id = al.service_id
        WHERE al.created_at >= NOW() - ($2 || ' days')::interval
        GROUP BY 1, 2, 3
        ORDER BY 1, 3`,
        [bucket, String(days)]
      ),

      // 3. Avg inference count per service per bucket
      query(
        `SELECT
          DATE_TRUNC($1, al.created_at) AS bucket_date,
          al.service_id,
          ss.display_name AS service_name,
          ROUND(AVG(al.inference_count)::numeric, 1) AS avg_inference
        FROM action_logs al
        JOIN streaming_services ss ON ss.id = al.service_id
        WHERE al.created_at >= NOW() - ($2 || ' days')::interval
          AND al.inference_count IS NOT NULL
        GROUP BY 1, 2, 3
        ORDER BY 1, 3`,
        [bucket, String(days)]
      ),

      // 4. Failure breakdown per service by error_code
      query(
        `SELECT
          al.service_id,
          ss.display_name AS service_name,
          COALESCE(al.error_code, 'other') AS error_code,
          COUNT(*)::int AS count
        FROM action_logs al
        JOIN streaming_services ss ON ss.id = al.service_id
        WHERE al.created_at >= NOW() - ($1 || ' days')::interval
          AND al.success = FALSE
        GROUP BY 1, 2, 3
        ORDER BY 2, 4 DESC`,
        [String(days)]
      ),
    ]);

  return NextResponse.json({
    days,
    bucket: bucket === "day" ? "daily" : "weekly",
    success_rate: successRate.rows,
    otp_rate: otpRate.rows,
    avg_inference: avgInference.rows,
    failure_breakdown: failureBreakdown.rows,
  });
});
