"""All Postgres operations for the Nostr bot.

Note: asyncpg returns uuid.UUID objects for UUID columns and expects them
as parameters. We keep UUIDs native throughout — only convert to str for display.
"""

import logging
import os
import secrets
from uuid import UUID

import asyncpg

log = logging.getLogger(__name__)

_pool: asyncpg.Pool | None = None


async def init_pool() -> asyncpg.Pool:
    global _pool
    _pool = await asyncpg.create_pool(
        os.environ["DATABASE_URL"],
        min_size=1,
        max_size=5,
    )
    log.info("Database pool initialized")
    return _pool


async def close_pool() -> None:
    global _pool
    if _pool:
        await _pool.close()
        _pool = None
        log.info("Database pool closed")


def _get_pool() -> asyncpg.Pool:
    if _pool is None:
        raise RuntimeError("Database pool not initialized — call init_pool() first")
    return _pool


# ── User lookup ──────────────────────────────────────────────


async def get_user_by_npub(npub_hex: str) -> dict | None:
    """Look up a user by their Nostr hex pubkey. Returns {id: UUID, status: str} or None."""
    row = await _get_pool().fetchrow(
        "SELECT id, status FROM users WHERE nostr_npub = $1",
        npub_hex,
    )
    if row is None:
        return None
    return {"id": row["id"], "status": row["status"]}


# ── Status ───────────────────────────────────────────────────


async def get_user_status(user_id: UUID) -> dict:
    """Active sub + credit balance + next service."""
    pool = _get_pool()

    # Active subscription
    sub_row = await pool.fetchrow(
        """
        SELECT ss.display_name, s.status, s.estimated_lapse_at
        FROM subscriptions s
        JOIN streaming_services ss ON ss.id = s.service_id
        WHERE s.user_id = $1 AND s.status IN ('active', 'lapsing', 'signup_scheduled')
        LIMIT 1
        """,
        user_id,
    )

    # Credit balance
    credit_row = await pool.fetchrow(
        "SELECT COALESCE(credit_sats, 0) AS credit_sats FROM service_credits WHERE user_id = $1",
        user_id,
    )

    # Next service: find the service at position after the current active one.
    # If there's an active sub, get its queue position, then find position + 1.
    # If no active sub, next is position 1.
    next_row = None
    if sub_row:
        next_row = await pool.fetchrow(
            """
            SELECT ss.display_name
            FROM rotation_queue rq
            JOIN streaming_services ss ON ss.id = rq.service_id
            WHERE rq.user_id = $1
              AND rq.position = (
                SELECT rq2.position + 1
                FROM rotation_queue rq2
                JOIN subscriptions s ON s.service_id = rq2.service_id AND s.user_id = rq2.user_id
                WHERE rq2.user_id = $1
                  AND s.status IN ('active', 'lapsing', 'signup_scheduled')
                LIMIT 1
              )
            """,
            user_id,
        )
    else:
        next_row = await pool.fetchrow(
            """
            SELECT ss.display_name
            FROM rotation_queue rq
            JOIN streaming_services ss ON ss.id = rq.service_id
            WHERE rq.user_id = $1 AND rq.position = 1
            """,
            user_id,
        )

    return {
        "subscription": (
            {
                "display_name": sub_row["display_name"],
                "status": sub_row["status"],
                "estimated_lapse_at": sub_row["estimated_lapse_at"],
            }
            if sub_row
            else None
        ),
        "credit_sats": credit_row["credit_sats"] if credit_row else 0,
        "next_service": next_row["display_name"] if next_row else None,
    }


# ── Queue listing ────────────────────────────────────────────


async def get_user_queue(user_id: UUID) -> list[dict]:
    """Full rotation queue with subscription status. Matches web/api/queue GET."""
    rows = await _get_pool().fetch(
        """
        SELECT rq.service_id, ss.display_name, rq.position,
               s.status AS sub_status, s.estimated_lapse_at
        FROM rotation_queue rq
        JOIN streaming_services ss ON ss.id = rq.service_id
        LEFT JOIN subscriptions s ON s.user_id = rq.user_id AND s.service_id = rq.service_id
          AND s.status IN ('active', 'signup_scheduled', 'lapsing')
        WHERE rq.user_id = $1
        ORDER BY rq.position
        """,
        user_id,
    )
    return [dict(r) for r in rows]


# ── Active service lookup ────────────────────────────────────


async def get_active_service_id(user_id: UUID) -> UUID | None:
    """Returns the service_id of the currently active/lapsing subscription."""
    row = await _get_pool().fetchrow(
        """
        SELECT service_id FROM subscriptions
        WHERE user_id = $1 AND status IN ('active', 'lapsing')
        LIMIT 1
        """,
        user_id,
    )
    return row["service_id"] if row else None


# ── Skip ─────────────────────────────────────────────────────


async def skip_service(user_id: UUID, service_id: UUID) -> bool:
    """Move a service to the end of the queue. Matches web/api/queue/[serviceId]/skip."""
    pool = _get_pool()

    # Get current position
    current = await pool.fetchrow(
        "SELECT position FROM rotation_queue WHERE user_id = $1 AND service_id = $2",
        user_id, service_id,
    )
    if current is None:
        return False

    skipped_pos = current["position"]

    # Get max position
    max_row = await pool.fetchrow(
        "SELECT MAX(position) AS max_pos FROM rotation_queue WHERE user_id = $1",
        user_id,
    )
    max_pos = max_row["max_pos"]

    async with pool.acquire() as conn:
        async with conn.transaction():
            # Temp move skipped service past the end
            await conn.execute(
                "UPDATE rotation_queue SET position = $3 WHERE user_id = $1 AND service_id = $2",
                user_id, service_id, max_pos + 1,
            )
            # Shift everything above skipped position down by 1
            await conn.execute(
                """
                UPDATE rotation_queue
                SET position = position - 1
                WHERE user_id = $1 AND position > $2 AND service_id != $3
                """,
                user_id, skipped_pos, service_id,
            )
            # Set skipped service to the actual last position
            await conn.execute(
                "UPDATE rotation_queue SET position = $3 WHERE user_id = $1 AND service_id = $2",
                user_id, service_id, max_pos,
            )

    return True


# ── Stay ─────────────────────────────────────────────────────


async def stay_service(user_id: UUID, service_id: UUID) -> bool:
    """Set extend_current on the active service. Matches web/api/queue/[serviceId]/stay."""
    pool = _get_pool()

    # Verify active/lapsing subscription exists
    sub = await pool.fetchrow(
        """
        SELECT id FROM subscriptions
        WHERE user_id = $1 AND service_id = $2 AND status IN ('active', 'lapsing')
        """,
        user_id, service_id,
    )
    if sub is None:
        return False

    result = await pool.execute(
        """
        UPDATE rotation_queue SET extend_current = TRUE
        WHERE user_id = $1 AND service_id = $2
        """,
        user_id, service_id,
    )
    # asyncpg execute returns "UPDATE N" — check N > 0
    return result.split()[-1] != "0"


# ── Zap credit ───────────────────────────────────────────────


async def credit_zap(
    event_id: str, user_id: UUID, sender_npub: str, amount_sats: int
) -> int | None:
    """Idempotent zap credit. Returns new balance, or None if already processed."""
    pool = _get_pool()

    async with pool.acquire() as conn:
        async with conn.transaction():
            # Check idempotency
            existing = await conn.fetchrow(
                "SELECT 1 FROM zap_receipts WHERE event_id = $1",
                event_id,
            )
            if existing is not None:
                return None

            # Record receipt
            await conn.execute(
                "INSERT INTO zap_receipts (event_id, user_id, sender_npub, amount_sats) VALUES ($1, $2, $3, $4)",
                event_id, user_id, sender_npub, amount_sats,
            )

            # Ensure credit record exists
            await conn.execute(
                "INSERT INTO service_credits (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING",
                user_id,
            )

            # Add credits
            credit_row = await conn.fetchrow(
                """
                UPDATE service_credits SET credit_sats = credit_sats + $2, updated_at = NOW()
                WHERE user_id = $1 RETURNING credit_sats
                """,
                user_id, amount_sats,
            )
            new_balance = credit_row["credit_sats"]

            # Record transaction
            await conn.execute(
                """
                INSERT INTO credit_transactions (user_id, type, amount_sats, balance_after_sats, description)
                VALUES ($1, 'zap_topup', $2, $3, 'Nostr zap topup')
                """,
                user_id, amount_sats, new_balance,
            )

            return new_balance


# ── OTP ─────────────────────────────────────────────────────


async def create_otp(npub_hex: str) -> str:
    """Generate a 12-digit OTP for the given npub. Upserts (one active per npub).

    Returns the raw 12-digit string (caller formats as XXXXXX-XXXXXX).
    """
    pool = _get_pool()

    for _ in range(5):
        code = f"{secrets.randbelow(10**12):012d}"
        try:
            await pool.execute(
                """
                INSERT INTO nostr_otp (npub_hex, code, expires_at)
                VALUES ($1, $2, NOW() + INTERVAL '5 minutes')
                ON CONFLICT (npub_hex) DO UPDATE
                    SET code = EXCLUDED.code,
                        expires_at = EXCLUDED.expires_at,
                        created_at = NOW()
                """,
                npub_hex, code,
            )
            return code
        except asyncpg.UniqueViolationError:
            # Rare collision on the code column, retry with a new code
            continue

    raise RuntimeError("Failed to generate unique OTP after 5 attempts")


async def verify_otp(code: str) -> str | None:
    """Consume an OTP. Returns npub_hex if valid, None otherwise.

    Cleans up expired rows first, then atomically deletes the matching row.
    """
    pool = _get_pool()

    # Cleanup expired
    await pool.execute("DELETE FROM nostr_otp WHERE expires_at < NOW()")

    # Atomic lookup + delete
    row = await pool.fetchrow(
        "DELETE FROM nostr_otp WHERE code = $1 AND expires_at > NOW() RETURNING npub_hex",
        code,
    )
    return row["npub_hex"] if row else None


# ── Waitlist ────────────────────────────────────────────────


async def add_to_waitlist(npub_hex: str) -> tuple[str, str | None]:
    """Add npub to waitlist. Returns (result, invite_code).

    result is one of: "added", "already_invited", "already_waitlisted"
    """
    pool = _get_pool()

    existing = await pool.fetchrow(
        "SELECT invited, invite_code FROM waitlist WHERE nostr_npub = $1",
        npub_hex,
    )

    if existing is None:
        await pool.execute(
            "INSERT INTO waitlist (nostr_npub) VALUES ($1)",
            npub_hex,
        )
        return ("added", None)

    if existing["invited"]:
        return ("already_invited", existing["invite_code"])

    return ("already_waitlisted", None)


# ── Invite DMs ──────────────────────────────────────────────


async def get_pending_invite_dms() -> list[dict]:
    """Get waitlist entries that have pending invite DMs to send."""
    rows = await _get_pool().fetch(
        """
        SELECT id, nostr_npub, invite_code
        FROM waitlist
        WHERE invite_dm_pending = TRUE
          AND nostr_npub IS NOT NULL
          AND invite_code IS NOT NULL
        """
    )
    return [dict(r) for r in rows]


async def mark_invite_dm_sent(waitlist_id) -> None:
    """Clear the invite_dm_pending flag after successful DM delivery."""
    await _get_pool().execute(
        "UPDATE waitlist SET invite_dm_pending = FALSE WHERE id = $1",
        waitlist_id,
    )
