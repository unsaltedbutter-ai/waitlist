import { NextResponse } from "next/server";
import { query } from "@/lib/db";

const GROUP_LABELS: Record<string, string> = {
  netflix: "Netflix",
  hulu: "Hulu",
  disney: "Disney+",
  max: "Max",
  paramount: "Paramount+",
  peacock: "Peacock",
  apple: "Apple TV+",
  prime: "Prime Video",
};

// Maps service_group → streaming_services.id (for credential storage)
const GROUP_SERVICE_IDS: Record<string, string> = {
  netflix: "netflix",
  hulu: "hulu",
  disney: "disney_plus",
  max: "max",
  paramount: "paramount",
  peacock: "peacock",
  apple: "apple_tv",
  prime: "prime_video",
};

export async function GET() {
  const result = await query(
    `SELECT id, service_group, display_name, monthly_price_cents, has_ads, is_bundle
     FROM service_plans
     WHERE active = TRUE
     ORDER BY display_order`
  );

  // Group by service_group
  const groups: Record<string, { label: string; serviceId: string; plans: typeof result.rows }> = {};
  for (const row of result.rows) {
    const group = row.service_group;
    if (!groups[group]) {
      groups[group] = {
        label: GROUP_LABELS[group] ?? group,
        serviceId: GROUP_SERVICE_IDS[group] ?? group,
        plans: [],
      };
    }
    groups[group].plans.push(row);
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
