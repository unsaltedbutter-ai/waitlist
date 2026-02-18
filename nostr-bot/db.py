"""All Postgres operations for the Nostr bot.

Note: asyncpg returns uuid.UUID objects for UUID columns and expects them
as parameters. We keep UUIDs native throughout, only convert to str for display.
"""

import logging
import os
import secrets

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
        raise RuntimeError("Database pool not initialized, call init_pool() first")
    return _pool


# -- User lookup ---------------------------------------------------------------


async def get_user_by_npub(npub_hex: str) -> dict | None:
    """Look up a user by their Nostr hex pubkey. Returns {id, debt_sats, onboarded_at} or None."""
    row = await _get_pool().fetchrow(
        "SELECT id, debt_sats, onboarded_at FROM users WHERE nostr_npub = $1",
        npub_hex,
    )
    if row is None:
        return None
    return {"id": row["id"], "debt_sats": row["debt_sats"], "onboarded_at": row["onboarded_at"]}


async def has_onboarded(user_id) -> bool:
    """True if the user has completed onboarding (onboarded_at is set)."""
    row = await _get_pool().fetchrow(
        "SELECT 1 FROM users WHERE id = $1 AND onboarded_at IS NOT NULL",
        user_id,
    )
    return row is not None


# -- OTP -----------------------------------------------------------------------


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


# -- Waitlist -------------------------------------------------------------------


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


# -- Invite DMs ----------------------------------------------------------------


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
