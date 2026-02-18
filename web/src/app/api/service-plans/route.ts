import { NextResponse } from "next/server";
import { query } from "@/lib/db";

const SERVICE_LABELS: Record<string, string> = {
  netflix: "Netflix",
  hulu: "Hulu",
  disney_plus: "Disney+",
  max: "Max",
  paramount: "Paramount+",
  peacock: "Peacock",
  apple_tv: "Apple TV+",
};

export async function GET() {
  const result = await query(
    `SELECT id, service_id, display_name, monthly_price_cents, has_ads, is_bundle
     FROM service_plans
     WHERE active = TRUE
     ORDER BY display_order`
  );

  // Group by service_id
  const groups: Record<string, { label: string; serviceId: string; plans: typeof result.rows }> = {};
  for (const row of result.rows) {
    const sid = row.service_id;
    if (!groups[sid]) {
      groups[sid] = {
        label: SERVICE_LABELS[sid] ?? sid,
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
