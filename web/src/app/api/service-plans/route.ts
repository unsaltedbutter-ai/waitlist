import { NextResponse } from "next/server";
import { query } from "@/lib/db";

export async function GET() {
  const result = await query(
    `SELECT sp.id, sp.service_id, sp.display_name, sp.monthly_price_cents,
            sp.has_ads, sp.is_bundle,
            ss.display_name AS service_display_name
     FROM service_plans sp
     JOIN streaming_services ss ON ss.id = sp.service_id
     WHERE sp.active = TRUE AND ss.supported = TRUE
     ORDER BY sp.display_order`
  );

  // Group by service_id
  const groups: Record<string, { label: string; serviceId: string; plans: typeof result.rows }> = {};
  for (const row of result.rows) {
    const sid = row.service_id;
    if (!groups[sid]) {
      groups[sid] = {
        label: row.service_display_name,
        serviceId: sid,
        plans: [],
      };
    }
    groups[sid].plans.push(row);
  }

  return NextResponse.json({
    groups: Object.entries(groups).map(([key, val]) => ({
      id: key,
      label: val.label,
      serviceId: val.serviceId,
      plans: val.plans,
    })),
  });
}
