/**
 * Pure computation helpers for onboarding payment step.
 */

export interface QueueEntry {
  serviceId: string;
  groupLabel: string;
  priceCents: number;
}

export type MembershipPlan = "solo" | "duo";

/**
 * Returns the queue items that should be covered by the initial payment.
 * Solo: first 1 service. Duo: first 2 services.
 */
export function getInitialServices(
  queue: QueueEntry[],
  plan: MembershipPlan,
): QueueEntry[] {
  const slotCount = plan === "duo" ? 2 : 1;
  return queue.slice(0, slotCount);
}

/**
 * Total USD cents for the initial service credits.
 */
export function computeServiceCreditCents(
  queue: QueueEntry[],
  plan: MembershipPlan,
): number {
  return getInitialServices(queue, plan).reduce(
    (sum, s) => sum + s.priceCents,
    0,
  );
}

/**
 * Human-readable label for the initial services.
 * Empty queue: "your first service"
 * Solo: "Netflix"
 * Duo: "Netflix and Hulu"
 */
export function formatInitialServicesLabel(
  queue: QueueEntry[],
  plan: MembershipPlan,
): string {
  const services = getInitialServices(queue, plan);
  if (services.length === 0) return "your first service";
  if (services.length === 1) return services[0].groupLabel;
  return `${services[0].groupLabel} and ${services[1].groupLabel}`;
}
