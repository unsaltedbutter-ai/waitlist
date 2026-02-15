import { query } from "@/lib/db";
import { selectDenomination } from "@/lib/lapse";
import { usdCentsToSats, satsToUsdCents } from "@/lib/btc-price";

type AlertLevel = "warning" | "email" | "critical" | "paused";

interface MarginCallUser {
  userId: string;
  email: string | null;
  currentServiceName: string;
  nextServiceName: string;
  subscriptionEndDate: Date;
  giftCardCostCents: number;
  giftCardCostSats: number;
  creditSats: number;
  daysUntilEnd: number;
  alertLevel: AlertLevel;
}

/**
 * Daily margin call check. For each user with a rotation slot approaching
 * lock-in, compare service credit balance against the cost of the next
 * gift card in their queue.
 *
 * Returns users who need alerts, grouped by severity.
 */
export async function checkMarginCalls(): Promise<MarginCallUser[]> {
  // Find users with active/cancel_scheduled subscriptions ending in the next 10 days
  // where the next service in their rotation slot needs a gift card
  const result = await query(
    `SELECT
       rs.user_id,
       u.email,
       ss_current.display_name AS current_service_name,
       s.subscription_end_date,
       rs.next_service_id,
       ss_next.display_name AS next_service_name,
       COALESCE(w.credit_sats, 0) AS credit_sats
     FROM rotation_slots rs
     JOIN users u ON u.id = rs.user_id
     JOIN subscriptions s ON s.id = rs.current_subscription_id
     JOIN streaming_services ss_current ON ss_current.id = rs.current_service_id
     LEFT JOIN service_credits w ON w.user_id = rs.user_id
     LEFT JOIN streaming_services ss_next ON ss_next.id = rs.next_service_id
     WHERE s.status IN ('active', 'cancel_scheduled')
       AND s.subscription_end_date IS NOT NULL
       AND s.subscription_end_date <= NOW() + INTERVAL '10 days'
       AND rs.next_service_id IS NOT NULL
       AND rs.locked_at IS NULL
     ORDER BY s.subscription_end_date`,
    []
  );

  const alerts: MarginCallUser[] = [];

  for (const row of result.rows) {
    const nextServiceId: string = row.next_service_id;
    const creditSats = Number(row.credit_sats);
    const endDate = new Date(row.subscription_end_date);
    const now = new Date();
    const daysUntilEnd = Math.ceil(
      (endDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)
    );

    let giftCardCostCents: number;
    try {
      giftCardCostCents = await selectDenomination(nextServiceId);
    } catch {
      continue; // No denominations configured — skip
    }

    const giftCardCostSats = await usdCentsToSats(giftCardCostCents);

    if (creditSats >= giftCardCostSats) {
      continue; // User can cover it — no alert needed
    }

    let alertLevel: AlertLevel;
    if (daysUntilEnd <= 0) {
      alertLevel = "paused";
    } else if (daysUntilEnd <= 3) {
      alertLevel = "critical";
    } else if (daysUntilEnd <= 5) {
      alertLevel = "email";
    } else {
      alertLevel = "warning";
    }

    alerts.push({
      userId: row.user_id,
      email: row.email,
      currentServiceName: row.current_service_name,
      nextServiceName: row.next_service_name,
      subscriptionEndDate: endDate,
      giftCardCostCents,
      giftCardCostSats,
      creditSats,
      daysUntilEnd,
      alertLevel,
    });
  }

  return alerts;
}

/**
 * Get margin call status for a single user (for dashboard display).
 */
export async function getUserMarginStatus(
  userId: string
): Promise<{ needsTopUp: boolean; shortfallSats: number; shortfallUsdCents: number } | null> {
  // Find the user's rotation slots that need gift cards
  const slot = await query(
    `SELECT rs.next_service_id, s.subscription_end_date
     FROM rotation_slots rs
     JOIN subscriptions s ON s.id = rs.current_subscription_id
     WHERE rs.user_id = $1
       AND s.status IN ('active', 'cancel_scheduled')
       AND rs.next_service_id IS NOT NULL
       AND rs.locked_at IS NULL
     ORDER BY s.subscription_end_date
     LIMIT 1`,
    [userId]
  );

  if (slot.rows.length === 0) return null;

  const nextServiceId: string = slot.rows[0].next_service_id;

  let costCents: number;
  try {
    costCents = await selectDenomination(nextServiceId);
  } catch {
    return null;
  }

  const costSats = await usdCentsToSats(costCents);

  const credits = await query(
    "SELECT COALESCE(credit_sats, 0) AS credit_sats FROM service_credits WHERE user_id = $1",
    [userId]
  );
  const creditSats = credits.rows.length > 0 ? Number(credits.rows[0].credit_sats) : 0;

  if (creditSats >= costSats) {
    return { needsTopUp: false, shortfallSats: 0, shortfallUsdCents: 0 };
  }

  const shortfallSats = costSats - creditSats;
  const shortfallUsdCents = await satsToUsdCents(shortfallSats);

  return { needsTopUp: true, shortfallSats, shortfallUsdCents };
}
