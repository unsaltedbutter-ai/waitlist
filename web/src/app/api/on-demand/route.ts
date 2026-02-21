import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/auth";
import { createOnDemandJob } from "@/lib/create-on-demand-job";
import { pushJobsReady } from "@/lib/nostr-push";

export const POST = withAuth(async (req: NextRequest, { userId }) => {
  let body: { serviceId?: string; action?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  try {
    const result = await createOnDemandJob(
      userId,
      body.serviceId ?? "",
      body.action ?? ""
    );

    if (!result.ok) {
      const response: Record<string, unknown> = { error: result.error };
      if (result.debt_sats !== undefined) response.debt_sats = result.debt_sats;
      return NextResponse.json(response, { status: result.status });
    }

    // Fire-and-forget: push to orchestrator immediately.
    // Don't await in the response path; log errors but never fail the user request.
    pushJobsReady([result.job_id]).catch((err) =>
      console.error("[on-demand] Failed to push job to orchestrator:", err)
    );

    return NextResponse.json({ job_id: result.job_id, status: "pending" });
  } catch (err) {
    console.error("On-demand job create error:", err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
});
