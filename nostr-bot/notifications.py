"""Proactive outbound notifications: periodic DB checks + DM sending.

Checks for three scenarios:
  1. Lock-in approaching: user's next service is about to be locked in
  2. Credit top-up: user doesn't have enough service credits for next rotation
  3. Auto-paused: user was paused due to low balance
"""

import logging
from datetime import datetime, timezone
from uuid import UUID

import db

log = logging.getLogger(__name__)

# Minimum sats threshold: if a user has fewer credits than this,
# they likely can't cover their cheapest queued service + platform fee.
CREDIT_LOW_THRESHOLD_SATS = 20_000


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


async def get_users_auto_paused() -> list[dict]:
    """Find users who are auto_paused and haven't been notified in 7 days.

    Conditions:
      - status = 'auto_paused'
      - Has nostr_npub
      - No notification_log for this user + 'auto_paused' in 7 days
    """
    pool = db._get_pool()
    rows = await pool.fetch(
        """
        SELECT
            u.id AS user_id,
            u.nostr_npub
        FROM users u
        WHERE u.status = 'auto_paused'
          AND u.nostr_npub IS NOT NULL
          AND NOT EXISTS (
              SELECT 1 FROM notification_log nl
              WHERE nl.user_id = u.id
                AND nl.notification_type = 'auto_paused'
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
        f"Heads up: if you do nothing, your {service_name} subscription starts on {date_str}.\n"
        "\n"
        "That means we buy the gift card and lock it in. Reply SKIP if you want to change your queue first."
    )


def format_credit_topup_message(
    service_name: str, price_cents: int, credit_sats: int, platform_fee: int = 4400
) -> str:
    price_dollars = price_cents / 100
    # Rough conversion: $1 ~ 1000 sats
    svc_sats = price_cents * 10
    needed_sats = max(0, svc_sats + platform_fee - credit_sats)
    return (
        f"You're low on credits. Your next rotation ({service_name}) "
        f"costs ~${price_dollars:.0f}/mo (~{svc_sats:,} sats) plus {platform_fee:,} sats platform fee.\n"
        "\n"
        f"Zap me {needed_sats:,} sats and we're good. Or top up from your dashboard."
    )


def format_auto_paused_message() -> str:
    return (
        "Your account is paused due to low balance. "
        "Add sats to resume automatically, or DM UNPAUSE after topping up."
    )


# ── Main orchestrator ─────────────────────────────────────────


async def check_and_send_notifications(client, signer) -> None:
    """Check all notification scenarios and send DMs."""
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

    # 2. Credit top-up
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

    # 3. Auto-paused
    try:
        auto_paused_users = await get_users_auto_paused()
    except Exception as e:
        log.error("[notifications] Error querying auto_paused: %s", e)
        auto_paused_users = []

    for user in auto_paused_users:
        msg = format_auto_paused_message()
        try:
            pk = PublicKey.parse(user["nostr_npub"])
            await client.send_private_msg(pk, msg, [])
            await record_notification(user["user_id"], "auto_paused", None)
            npub_short = user["nostr_npub"][:16]
            print(f"[notifications] Sent auto_paused to {npub_short}")
        except Exception as e:
            log.error("[notifications] Failed to send auto_paused to %s: %s", user["nostr_npub"][:16], e)

    total = len(lock_in_users) + len(topup_users) + len(auto_paused_users)
    if total > 0:
        log.info("[notifications] Sent %d notifications (%d lock_in, %d topup, %d auto_paused)",
                 total, len(lock_in_users), len(topup_users), len(auto_paused_users))
    else:
        log.debug("[notifications] No notifications to send this cycle")
