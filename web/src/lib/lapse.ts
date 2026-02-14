import { query } from "@/lib/db";

interface ServiceLapseConfig {
  monthlyPriceCents: number;
  lapseCalculation: "proportional" | "calendar_month";
}

/**
 * Estimate when a subscription will lapse based on gift card amount.
 *
 * proportional: signupDate + (giftCardCents / monthlyPriceCents) * 30 days
 * calendar_month: end of the billing month, extended proportionally for remaining balance
 */
export async function estimateLapseDate(
  serviceId: string,
  giftCardAmountCents: number,
  signupDate: Date
): Promise<Date> {
  const result = await query<ServiceLapseConfig>(
    `SELECT monthly_price_cents AS "monthlyPriceCents",
            lapse_calculation AS "lapseCalculation"
     FROM streaming_services WHERE id = $1`,
    [serviceId]
  );

  if (result.rows.length === 0) {
    throw new Error(`Service ${serviceId} not found`);
  }

  const { monthlyPriceCents, lapseCalculation } = result.rows[0];

  if (lapseCalculation === "calendar_month") {
    return estimateCalendarMonth(signupDate, giftCardAmountCents, monthlyPriceCents);
  }

  return estimateProportional(signupDate, giftCardAmountCents, monthlyPriceCents);
}

function estimateProportional(
  signupDate: Date,
  giftCardAmountCents: number,
  monthlyPriceCents: number
): Date {
  const coverageDays = (giftCardAmountCents / monthlyPriceCents) * 30;
  const lapse = new Date(signupDate);
  lapse.setDate(lapse.getDate() + Math.floor(coverageDays));
  return lapse;
}

function estimateCalendarMonth(
  signupDate: Date,
  giftCardAmountCents: number,
  monthlyPriceCents: number
): Date {
  let remaining = giftCardAmountCents;
  const current = new Date(signupDate);

  while (remaining >= monthlyPriceCents) {
    remaining -= monthlyPriceCents;
    // Advance to same day next month
    current.setMonth(current.getMonth() + 1);
  }

  // Partial month: proportional days
  if (remaining > 0) {
    const daysInMonth = new Date(
      current.getFullYear(),
      current.getMonth() + 1,
      0
    ).getDate();
    const partialDays = Math.floor((remaining / monthlyPriceCents) * daysInMonth);
    current.setDate(current.getDate() + partialDays);
  }

  return current;
}

/**
 * Pick the smallest gift card denomination that covers at least 28 days.
 */
export async function selectDenomination(
  serviceId: string
): Promise<number> {
  const result = await query(
    `SELECT monthly_price_cents, gift_card_denominations_cents
     FROM streaming_services WHERE id = $1`,
    [serviceId]
  );

  if (result.rows.length === 0) {
    throw new Error(`Service ${serviceId} not found`);
  }

  const { monthly_price_cents, gift_card_denominations_cents } = result.rows[0];

  if (!gift_card_denominations_cents || gift_card_denominations_cents.length === 0) {
    throw new Error(`No gift card denominations configured for service ${serviceId}`);
  }

  // Minimum amount to cover 28 days
  const minAmount = Math.ceil((monthly_price_cents / 30) * 28);

  const sorted = [...gift_card_denominations_cents].sort((a: number, b: number) => a - b);
  const pick = sorted.find((d: number) => d >= minAmount);

  return pick ?? sorted[sorted.length - 1];
}
