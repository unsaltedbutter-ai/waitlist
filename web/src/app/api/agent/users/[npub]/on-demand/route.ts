import { NextRequest, NextResponse } from "next/server";
import { withAgentAuth } from "@/lib/agent-auth";
import { getUserByNpub } from "@/lib/queries";
import { parseJsonBody } from "@/lib/parse-json-body";
import { createOnDemandJob } from "@/lib/create-on-demand-job";

export const POST = withAgentAuth(async (_req: NextRequest, { body: rawBody, params }) => {
  const npub = params?.npub;
  if (!npub) {
    return NextResponse.json({ error: "Missing npub" }, { status: 400 });
  }

  const { data: parsed, error } = parseJsonBody<{ service?: string; action?: string }>(rawBody);
  if (error) return error;

  try {
    const user = await getUserByNpub(npub);
    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const result = await createOnDemandJob(
      user.id,
      parsed.service ?? "",
      parsed.action ?? ""
    );

    if (!result.ok) {
      const response: Record<string, unknown> = { error: result.error };
      if (result.debt_sats !== undefined) response.debt_sats = result.debt_sats;
      return NextResponse.json(response, { status: result.status });
    }

    return NextResponse.json({ job_id: result.job_id, status: "pending" });
  } catch (err) {
    console.error("Agent on-demand job create error:", err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
});
