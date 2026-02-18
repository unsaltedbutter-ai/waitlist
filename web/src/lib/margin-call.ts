import { query } from "@/lib/db";
import { selectDenomination } from "@/lib/lapse";
import { usdCentsToSats, satsToUsdCents } from "@/lib/btc-price";

type AlertLevel = "warning" | "email" | "critical" | "paused";

interface RequiredBalance {
  platformFeeSats: number;
  giftCardCostSats: number;
  totalSats: number;
}

interface MarginCallUser {
  userId: string;
  email: string | null;
  currentServiceName: string;
  nextServiceName: string;
  subscriptionEndDate: Date;
  giftCardCostCents: number;
  giftCardCostSats: number;
  platformFeeSats: number;
  totalRequiredSats: number;
  creditSats: number;
  shortfallSats: number;
  daysUntilEnd: number;
  alertLevel: AlertLevel;
}

interface UserMarginStatus {
  needsTopUp: boolean;
  shortfallSats: number;
  shortfallUsdCents: number;
  platformFeeSats: number;
  giftCardCostSats: number;
  totalRequiredSats: number;
}

/**
 * Read the platform fee from platform_config and compute the total required
 * balance for the next service (gift card cost + platform fee).
 */
export async function getRequiredBalance(
  nextServiceId: string
): Promise<RequiredBalance> {
  const feeResult = await query(
    `SELECT value FROM platform_config WHERE key = 'platform_fee_sats'`,
    []
  );
  const platformFeeSats =
    feeResult.rows.length > 0 ? Number(feeResult.rows[0].value) : 0;

  const giftCardCostCents = await selectDenomination(nextServiceId);
  const giftCardCostSats = await usdCentsToSats(giftCardCostCents);

  return {
    platformFeeSats,
    giftCardCostSats,
    totalSats: giftCardCostSats + platformFeeSats,
  };
}

/**
 * Read platform_fee_sats once from platform_config.
 */
async function getPlatformFeeSats(): Promise<number> {
  const result = await query(
    `SELECT value FROM platform_config WHERE key = 'platform_fee_sats'`,
    []
  );
  return result.rows.length > 0 ? Number(result.rows[0].value) : 0;
}

/**
 * Daily margin call check. For each user with a rotation slot approaching
 * lock-in, compare service credit balance against the cost of the next
 * gift card in their queue plus the platform fee.
 *
 * Returns users who need alerts, grouped by severity.
 */
export async function checkMarginCalls(): Promise<MarginCallUser[]> {
  const platformFeeSats = await getPlatformFeeSats();

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
      continue; // No denominations configured, skip
    }

    const giftCardCostSats = await usdCentsToSats(giftCardCostCents);
    const totalRequiredSats = giftCardCostSats + platformFeeSats;

    if (creditSats >= totalRequiredSats) {
      continue; // User can cover it, no alert needed
    }

    const shortfallSats = totalRequiredSats - creditSats;

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
      platformFeeSats,
      totalRequiredSats,
      creditSats,
      shortfallSats,
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
): Promise<UserMarginStatus | null> {
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

  const giftCardCostSats = await usdCentsToSats(costCents);
  const platformFeeSats = await getPlatformFeeSats();
  const totalRequiredSats = giftCardCostSats + platformFeeSats;

  const credits = await query(
    "SELECT COALESCE(credit_sats, 0) AS credit_sats FROM service_credits WHERE user_id = $1",
    [userId]
  );
  const creditSats = credits.rows.length > 0 ? Number(credits.rows[0].credit_sats) : 0;

  if (creditSats >= totalRequiredSats) {
    return {
      needsTopUp: false,
      shortfallSats: 0,
      shortfallUsdCents: 0,
      platformFeeSats,
      giftCardCostSats,
      totalRequiredSats,
    };
  }

  const shortfallSats = totalRequiredSats - creditSats;
  const shortfallUsdCents = await satsToUsdCents(shortfallSats);

  return {
    needsTopUp: true,
    shortfallSats,
    shortfallUsdCents,
    platformFeeSats,
    giftCardCostSats,
    totalRequiredSats,
  };
}
