"""Proactive outbound notifications — periodic DB checks + DM sending.

Checks for three scenarios:
  1. Lock-in approaching: user's next service is about to be locked in
  2. Membership due: user's membership expires soon
  3. Credit top-up: user doesn't have enough service credits for next rotation
"""

import logging
from datetime import datetime, timezone
from uuid import UUID

import db

log = logging.getLogger(__name__)

# Minimum sats threshold — if a user has fewer credits than this,
# they likely can't cover their cheapest queued service.
CREDIT_LOW_THRESHOLD_SATS = 15_000


# ── Query functions ───────────────────────────────────────────


async def get_users_lock_in_approaching() -> list[dict]:
    """Find users whose next service lock-in is within 4 days.

    Conditions:
      - rotation_slot has next_service_id set and locked_at IS NULL
      - The slot's current subscription has cancel_scheduled_at within 4 days
      - No notification_log entry for this user + 'lock_in_approaching' + next_service_id
        in the last 7 days
      - User has a nostr_npub (can't DM without it)
    """
    pool = db._get_pool()
    rows = await pool.fetch(
        """
        SELECT
            u.id AS user_id,
            u.nostr_npub,
            ss.display_name AS next_service_name,
            s.subscription_end_date AS estimated_start_date,
            rs.next_service_id
        FROM rotation_slots rs
        JOIN users u ON u.id = rs.user_id
        JOIN streaming_services ss ON ss.id = rs.next_service_id
        LEFT JOIN subscriptions s
            ON s.id = rs.current_subscription_id
        WHERE rs.next_service_id IS NOT NULL
          AND rs.locked_at IS NULL
          AND u.nostr_npub IS NOT NULL
          AND s.cancel_scheduled_at IS NOT NULL
          AND s.cancel_scheduled_at <= NOW() + INTERVAL '4 days'
          AND NOT EXISTS (
              SELECT 1 FROM notification_log nl
              WHERE nl.user_id = u.id
                AND nl.notification_type = 'lock_in_approaching'
                AND nl.reference_id = rs.next_service_id
                AND nl.sent_at > NOW() - INTERVAL '7 days'
          )
        """
    )
    return [dict(r) for r in rows]


async def get_users_membership_due() -> list[dict]:
    """Find users whose membership expires within 7 days.

    Conditions:
      - membership_expires_at within 7 days
      - status = 'active'
      - No pending/paid membership_payment with period_start after now
      - No notification_log for this user + 'membership_due' + current month in 7 days
      - User has nostr_npub
    """
    pool = db._get_pool()
    rows = await pool.fetch(
        """
        SELECT
            u.id AS user_id,
            u.nostr_npub,
            u.membership_plan,
            u.billing_period,
            u.membership_expires_at,
            mp.price_sats
        FROM users u
        JOIN membership_pricing mp
            ON mp.plan = u.membership_plan AND mp.period = u.billing_period
        WHERE u.status = 'active'
          AND u.nostr_npub IS NOT NULL
          AND u.membership_expires_at IS NOT NULL
          AND u.membership_expires_at <= NOW() + INTERVAL '7 days'
          AND NOT EXISTS (
              SELECT 1 FROM membership_payments pay
              WHERE pay.user_id = u.id
                AND pay.status IN ('pending', 'paid')
                AND pay.period_start > NOW()
          )
          AND NOT EXISTS (
              SELECT 1 FROM notification_log nl
              WHERE nl.user_id = u.id
                AND nl.notification_type = 'membership_due'
                AND nl.reference_id = TO_CHAR(NOW(), 'YYYY-MM')
                AND nl.sent_at > NOW() - INTERVAL '7 days'
          )
        """
    )
    return [dict(r) for r in rows]


async def get_users_credit_topup() -> list[dict]:
    """Find users with insufficient credits for their cheapest queued service.

    Conditions:
      - status = 'active', has nostr_npub
      - credit_sats < 15,000 (rough threshold)
      - Has at least one service in rotation_queue
      - No notification_log for this user + 'credit_topup' in 14 days
    """
    pool = db._get_pool()
    rows = await pool.fetch(
        """
        SELECT
            u.id AS user_id,
            u.nostr_npub,
            COALESCE(sc.credit_sats, 0) AS credit_sats,
            cheapest.display_name AS cheapest_service_name,
            cheapest.monthly_price_cents AS cheapest_service_price_cents
        FROM users u
        LEFT JOIN service_credits sc ON sc.user_id = u.id
        JOIN LATERAL (
            SELECT ss.display_name, ss.monthly_price_cents
            FROM rotation_queue rq
            JOIN streaming_services ss ON ss.id = rq.service_id
            WHERE rq.user_id = u.id
            ORDER BY ss.monthly_price_cents ASC
            LIMIT 1
        ) cheapest ON TRUE
        WHERE u.status = 'active'
          AND u.nostr_npub IS NOT NULL
          AND COALESCE(sc.credit_sats, 0) < $1
          AND NOT EXISTS (
              SELECT 1 FROM notification_log nl
              WHERE nl.user_id = u.id
                AND nl.notification_type = 'credit_topup'
                AND nl.sent_at > NOW() - INTERVAL '14 days'
          )
        """,
        CREDIT_LOW_THRESHOLD_SATS,
    )
    return [dict(r) for r in rows]


# ── Record sent notification ──────────────────────────────────


async def record_notification(user_id: UUID, notification_type: str, reference_id: str | None) -> None:
    """Insert a row into notification_log for dedup tracking."""
    pool = db._get_pool()
    await pool.execute(
        "INSERT INTO notification_log (user_id, notification_type, reference_id) VALUES ($1, $2, $3)",
        user_id, notification_type, reference_id,
    )


# ── Message formatting ────────────────────────────────────────


def format_lock_in_message(service_name: str, estimated_start_date: datetime | None) -> str:
    date_str = estimated_start_date.strftime("%b %d") if estimated_start_date else "soon"
    return (
        f"Heads up \u2014 if you do nothing, your {service_name} subscription starts on {date_str}.\n"
        "\n"
        "That means we buy the gift card and lock it in. Reply SKIP if you want to change your queue first."
    )


def format_membership_due_message(
    billing_period: str, price_sats: int, expires_at: datetime | None
) -> str:
    date_str = expires_at.strftime("%b %d") if expires_at else "soon"
    return (
        f"Your {billing_period} UnsaltedButter membership is {price_sats:,} sats. Due by {date_str}.\n"
        "\n"
        "Zap this account or pay from your dashboard. "
        "If we don't get it, we destroy your account and credentials. Nothing personal."
    )


def format_credit_topup_message(
    service_name: str, price_cents: int, credit_sats: int
) -> str:
    price_dollars = price_cents / 100
    # Rough conversion: $1 ~ 1000 sats
    needed_sats = max(0, (price_cents * 10) - credit_sats)
    return (
        f"You're low on service credits. Your next rotation ({service_name}) "
        f"costs ~${price_dollars:.0f}/mo and you don't have enough.\n"
        "\n"
        f"Zap me {needed_sats:,} sats and we're good. Or top up from your dashboard."
    )


# ── Main orchestrator ─────────────────────────────────────────


async def check_and_send_notifications(client, signer) -> None:
    """Check all three notification scenarios and send DMs."""
    from nostr_sdk import PublicKey

    # 1. Lock-in approaching
    try:
        lock_in_users = await get_users_lock_in_approaching()
    except Exception as e:
        log.error("[notifications] Error querying lock_in_approaching: %s", e)
        lock_in_users = []

    for user in lock_in_users:
        msg = format_lock_in_message(user["next_service_name"], user["estimated_start_date"])
        try:
            pk = PublicKey.parse(user["nostr_npub"])
            await client.send_private_msg(pk, msg, [])
            await record_notification(user["user_id"], "lock_in_approaching", user["next_service_id"])
            npub_short = user["nostr_npub"][:16]
            print(f"[notifications] Sent lock_in_approaching to {npub_short}")
        except Exception as e:
            log.error("[notifications] Failed to send lock_in_approaching to %s: %s", user["nostr_npub"][:16], e)

    # 2. Membership due
    try:
        membership_users = await get_users_membership_due()
    except Exception as e:
        log.error("[notifications] Error querying membership_due: %s", e)
        membership_users = []

    for user in membership_users:
        msg = format_membership_due_message(
            user["billing_period"], user["price_sats"], user["membership_expires_at"]
        )
        try:
            pk = PublicKey.parse(user["nostr_npub"])
            await client.send_private_msg(pk, msg, [])
            reference = datetime.now(timezone.utc).strftime("%Y-%m")
            await record_notification(user["user_id"], "membership_due", reference)
            npub_short = user["nostr_npub"][:16]
            print(f"[notifications] Sent membership_due to {npub_short}")
        except Exception as e:
            log.error("[notifications] Failed to send membership_due to %s: %s", user["nostr_npub"][:16], e)

    # 3. Credit top-up
    try:
        topup_users = await get_users_credit_topup()
    except Exception as e:
        log.error("[notifications] Error querying credit_topup: %s", e)
        topup_users = []

    for user in topup_users:
        msg = format_credit_topup_message(
            user["cheapest_service_name"],
            user["cheapest_service_price_cents"],
            user["credit_sats"],
        )
        try:
            pk = PublicKey.parse(user["nostr_npub"])
            await client.send_private_msg(pk, msg, [])
            await record_notification(user["user_id"], "credit_topup", None)
            npub_short = user["nostr_npub"][:16]
            print(f"[notifications] Sent credit_topup to {npub_short}")
        except Exception as e:
            log.error("[notifications] Failed to send credit_topup to %s: %s", user["nostr_npub"][:16], e)

    total = len(lock_in_users) + len(membership_users) + len(topup_users)
    if total > 0:
        log.info("[notifications] Sent %d notifications (%d lock_in, %d membership, %d topup)",
                 total, len(lock_in_users), len(membership_users), len(topup_users))
    else:
        log.debug("[notifications] No notifications to send this cycle")
