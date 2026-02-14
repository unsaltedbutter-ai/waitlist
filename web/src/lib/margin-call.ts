import { query } from "@/lib/db";
import { selectDenomination } from "@/lib/lapse";
import { usdCentsToSats, satsToUsdCents } from "@/lib/btc-price";

type AlertLevel = "warning" | "email" | "critical" | "paused";

interface MarginCallUser {
  userId: string;
  email: string | null;
  currentServiceName: string;
  nextServiceName: string;
  estimatedLapseAt: Date;
  giftCardCostCents: number;
  giftCardCostSats: number;
  creditSats: number;
  daysUntilLapse: number;
  alertLevel: AlertLevel;
}

/**
 * Daily margin call check. For each user with an active/lapsing subscription
 * approaching estimated_lapse_at, compare service credit balance against the
 * cost of the next gift card in their queue.
 *
 * Returns users who need alerts, grouped by severity.
 */
export async function checkMarginCalls(): Promise<MarginCallUser[]> {
  // Find users with subscriptions lapsing in the next 10 days
  const result = await query(
    `SELECT
       s.user_id,
       u.email,
       ss_current.display_name AS current_service_name,
       s.estimated_lapse_at,
       s.service_id AS current_service_id,
       rq_next.service_id AS next_service_id,
       ss_next.display_name AS next_service_name,
       COALESCE(w.credit_sats, 0) AS credit_sats
     FROM subscriptions s
     JOIN users u ON u.id = s.user_id
     JOIN streaming_services ss_current ON ss_current.id = s.service_id
     LEFT JOIN service_credits w ON w.user_id = s.user_id
     -- Find the next service in the queue (position after current)
     LEFT JOIN rotation_queue rq_current
       ON rq_current.user_id = s.user_id AND rq_current.service_id = s.service_id
     LEFT JOIN rotation_queue rq_next
       ON rq_next.user_id = s.user_id
       AND rq_next.position = (
         SELECT MIN(rq2.position) FROM rotation_queue rq2
         WHERE rq2.user_id = s.user_id
           AND rq2.position > COALESCE(rq_current.position, 0)
       )
     LEFT JOIN streaming_services ss_next ON ss_next.id = rq_next.service_id
     WHERE s.status IN ('active', 'lapsing')
       AND s.estimated_lapse_at IS NOT NULL
       AND s.estimated_lapse_at <= NOW() + INTERVAL '10 days'
       AND rq_next.service_id IS NOT NULL
       AND (rq_current.extend_current IS NOT TRUE)
     ORDER BY s.estimated_lapse_at`,
    []
  );

  const alerts: MarginCallUser[] = [];

  for (const row of result.rows) {
    const nextServiceId: string = row.next_service_id;
    const creditSats = Number(row.credit_sats);
    const lapseAt = new Date(row.estimated_lapse_at);
    const now = new Date();
    const daysUntilLapse = Math.ceil(
      (lapseAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)
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
    if (daysUntilLapse <= 0) {
      alertLevel = "paused";
    } else if (daysUntilLapse <= 3) {
      alertLevel = "critical";
    } else if (daysUntilLapse <= 5) {
      alertLevel = "email";
    } else {
      alertLevel = "warning";
    }

    alerts.push({
      userId: row.user_id,
      email: row.email,
      currentServiceName: row.current_service_name,
      nextServiceName: row.next_service_name,
      estimatedLapseAt: lapseAt,
      giftCardCostCents,
      giftCardCostSats,
      creditSats,
      daysUntilLapse,
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
  const sub = await query(
    `SELECT s.service_id, s.estimated_lapse_at,
            rq_current.position AS current_pos,
            rq_current.extend_current
     FROM subscriptions s
     JOIN rotation_queue rq_current
       ON rq_current.user_id = s.user_id AND rq_current.service_id = s.service_id
     WHERE s.user_id = $1 AND s.status IN ('active', 'lapsing')
       AND s.estimated_lapse_at IS NOT NULL
     ORDER BY s.estimated_lapse_at
     LIMIT 1`,
    [userId]
  );

  if (sub.rows.length === 0) return null;

  const { current_pos, extend_current } = sub.rows[0];

  // If extending current, the cost is for the same service
  let nextServiceId: string;
  if (extend_current) {
    nextServiceId = sub.rows[0].service_id;
  } else {
    const next = await query(
      `SELECT service_id FROM rotation_queue
       WHERE user_id = $1 AND position > $2
       ORDER BY position LIMIT 1`,
      [userId, current_pos]
    );
    if (next.rows.length === 0) return null;
    nextServiceId = next.rows[0].service_id;
  }

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
