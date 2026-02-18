import { NextRequest, NextResponse } from "next/server";
import { withAgentAuth } from "@/lib/agent-auth";
import { UUID_REGEX } from "@/lib/constants";
import { parseJsonBody } from "@/lib/parse-json-body";
import { confirmJobPayment } from "@/lib/confirm-payment";

export const POST = withAgentAuth(async (_req: NextRequest, { body, params }) => {
  const jobId = params?.id;
  if (!jobId) {
    return NextResponse.json({ error: "Missing job ID" }, { status: 400 });
  }

  if (!UUID_REGEX.test(jobId)) {
    return NextResponse.json({ error: "Invalid job ID format" }, { status: 400 });
  }

  const { data: parsed, error } = parseJsonBody<{ zap_event_id?: string }>(body);
  if (error) return error;

  try {
    const result = await confirmJobPayment(jobId, {
      zapEventId: parsed?.zap_event_id,
    });

    if (!result.success) {
      return NextResponse.json(
        { error: result.error },
        { status: result.status ?? 500 }
      );
    }

    return NextResponse.json({ success: true, job: result.job });
  } catch (err) {
    console.error("Agent job paid error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
});
