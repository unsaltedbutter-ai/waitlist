"""
Local SQLite cache for the orchestrator.

VPS PostgreSQL is the source of truth. All mutations go through the VPS API.
This SQLite stores conversation sessions, non-terminal job cache, timer queue,
user profile cache, and message log (90-day).
"""

from __future__ import annotations

import aiosqlite

_TERMINAL_STATUSES = (
    "completed_paid",
    "completed_eventual",
    "completed_reneged",
    "user_skip",
    "user_abandon",
    "implied_skip",
    "failed",
)

_SCHEMA = """
CREATE TABLE IF NOT EXISTS jobs (
    id              TEXT PRIMARY KEY,
    user_npub       TEXT NOT NULL,
    service_id      TEXT NOT NULL,
    action          TEXT NOT NULL,
    trigger         TEXT NOT NULL,
    status          TEXT NOT NULL,
    billing_date    TEXT,
    access_end_date TEXT,
    outreach_count  INTEGER NOT NULL DEFAULT 0,
    next_outreach_at TEXT,
    amount_sats     INTEGER,
    invoice_id      TEXT,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
    user_npub       TEXT PRIMARY KEY,
    state           TEXT NOT NULL DEFAULT 'IDLE',
    job_id          TEXT,
    otp_attempts    INTEGER NOT NULL DEFAULT 0,
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS timers (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    timer_type      TEXT NOT NULL,
    target_id       TEXT NOT NULL,
    fire_at         TEXT NOT NULL,
    payload         TEXT,
    fired           INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS user_cache (
    npub            TEXT PRIMARY KEY,
    debt_sats       INTEGER NOT NULL DEFAULT 0,
    onboarded_at    TEXT,
    services_json   TEXT,
    queue_json      TEXT,
    fetched_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS message_log (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    direction       TEXT NOT NULL,
    user_npub       TEXT NOT NULL,
    content         TEXT NOT NULL,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_user ON jobs(user_npub);
CREATE INDEX IF NOT EXISTS idx_timers_fire ON timers(fire_at) WHERE fired = 0;
CREATE INDEX IF NOT EXISTS idx_message_log_user ON message_log(user_npub);
CREATE INDEX IF NOT EXISTS idx_message_log_created ON message_log(created_at);
"""


class Database:
    """Async SQLite wrapper for the orchestrator's local cache."""

    def __init__(self, db_path: str = "orchestrator.db") -> None:
        self._db_path = db_path
        self._db: aiosqlite.Connection | None = None

    async def connect(self) -> None:
        """Open connection, enable WAL mode, create tables."""
        self._db = await aiosqlite.connect(self._db_path)
        self._db.row_factory = aiosqlite.Row
        await self._db.execute("PRAGMA journal_mode=WAL")
        await self._db.executescript(_SCHEMA)
        await self._db.commit()

    async def close(self) -> None:
        """Close the connection."""
        if self._db:
            await self._db.close()
            self._db = None

    # ------------------------------------------------------------------
    # Jobs
    # ------------------------------------------------------------------

    async def upsert_job(self, job: dict) -> None:
        """INSERT OR REPLACE a job row from a dict."""
        await self._db.execute(
            """INSERT OR REPLACE INTO jobs
               (id, user_npub, service_id, action, trigger, status,
                billing_date, access_end_date, outreach_count,
                next_outreach_at, amount_sats, invoice_id,
                created_at, updated_at)
               VALUES (:id, :user_npub, :service_id, :action, :trigger,
                       :status, :billing_date, :access_end_date,
                       :outreach_count, :next_outreach_at, :amount_sats,
                       :invoice_id, :created_at, :updated_at)""",
            {
                "id": job["id"],
                "user_npub": job["user_npub"],
                "service_id": job["service_id"],
                "action": job["action"],
                "trigger": job["trigger"],
                "status": job["status"],
                "billing_date": job.get("billing_date"),
                "access_end_date": job.get("access_end_date"),
                "outreach_count": job.get("outreach_count", 0),
                "next_outreach_at": job.get("next_outreach_at"),
                "amount_sats": job.get("amount_sats"),
                "invoice_id": job.get("invoice_id"),
                "created_at": job["created_at"],
                "updated_at": job.get("updated_at", ""),
            },
        )
        await self._db.commit()

    async def get_job(self, job_id: str) -> dict | None:
        """Fetch a single job by id."""
        cursor = await self._db.execute("SELECT * FROM jobs WHERE id = ?", (job_id,))
        row = await cursor.fetchone()
        return dict(row) if row else None

    async def get_jobs_by_status(self, status: str) -> list[dict]:
        """Return all jobs matching a given status."""
        cursor = await self._db.execute(
            "SELECT * FROM jobs WHERE status = ?", (status,)
        )
        return [dict(r) for r in await cursor.fetchall()]

    async def get_jobs_for_user(self, user_npub: str) -> list[dict]:
        """Return all jobs for a given user."""
        cursor = await self._db.execute(
            "SELECT * FROM jobs WHERE user_npub = ?", (user_npub,)
        )
        return [dict(r) for r in await cursor.fetchall()]

    async def update_job_status(self, job_id: str, status: str, **kwargs) -> None:
        """Update a job's status and any extra fields passed as kwargs."""
        sets = ["status = ?", "updated_at = datetime('now')"]
        params: list = [status]
        for key, value in kwargs.items():
            sets.append(f"{key} = ?")
            params.append(value)
        params.append(job_id)
        await self._db.execute(
            f"UPDATE jobs SET {', '.join(sets)} WHERE id = ?", params
        )
        await self._db.commit()

    async def delete_terminal_jobs(self) -> int:
        """Delete jobs with terminal statuses. Return count deleted."""
        placeholders = ", ".join("?" for _ in _TERMINAL_STATUSES)
        cursor = await self._db.execute(
            f"DELETE FROM jobs WHERE status IN ({placeholders})",
            _TERMINAL_STATUSES,
        )
        await self._db.commit()
        return cursor.rowcount

    # ------------------------------------------------------------------
    # Sessions
    # ------------------------------------------------------------------

    async def get_session(self, user_npub: str) -> dict | None:
        """Fetch a session by user npub."""
        cursor = await self._db.execute(
            "SELECT * FROM sessions WHERE user_npub = ?", (user_npub,)
        )
        row = await cursor.fetchone()
        return dict(row) if row else None

    async def upsert_session(
        self,
        user_npub: str,
        state: str,
        job_id: str | None = None,
        otp_attempts: int = 0,
    ) -> None:
        """INSERT OR REPLACE a session."""
        await self._db.execute(
            """INSERT OR REPLACE INTO sessions
               (user_npub, state, job_id, otp_attempts, updated_at)
               VALUES (?, ?, ?, ?, datetime('now'))""",
            (user_npub, state, job_id, otp_attempts),
        )
        await self._db.commit()

    async def delete_session(self, user_npub: str) -> None:
        """Remove a session."""
        await self._db.execute(
            "DELETE FROM sessions WHERE user_npub = ?", (user_npub,)
        )
        await self._db.commit()

    # ------------------------------------------------------------------
    # Timers
    # ------------------------------------------------------------------

    async def add_timer(
        self,
        timer_type: str,
        target_id: str,
        fire_at: str,
        payload: str | None = None,
    ) -> int:
        """Insert a timer. Returns the new timer id."""
        cursor = await self._db.execute(
            """INSERT INTO timers (timer_type, target_id, fire_at, payload)
               VALUES (?, ?, ?, ?)""",
            (timer_type, target_id, fire_at, payload),
        )
        await self._db.commit()
        return cursor.lastrowid

    async def get_due_timers(self, now: str) -> list[dict]:
        """Return unfired timers where fire_at <= now."""
        cursor = await self._db.execute(
            "SELECT * FROM timers WHERE fired = 0 AND fire_at <= ?", (now,)
        )
        return [dict(r) for r in await cursor.fetchall()]

    async def mark_timer_fired(self, timer_id: int) -> None:
        """Mark a timer as fired."""
        await self._db.execute(
            "UPDATE timers SET fired = 1 WHERE id = ?", (timer_id,)
        )
        await self._db.commit()

    async def cancel_timers(self, timer_type: str, target_id: str) -> int:
        """Delete unfired timers matching type + target. Return count."""
        cursor = await self._db.execute(
            "DELETE FROM timers WHERE timer_type = ? AND target_id = ? AND fired = 0",
            (timer_type, target_id),
        )
        await self._db.commit()
        return cursor.rowcount

    # ------------------------------------------------------------------
    # User cache
    # ------------------------------------------------------------------

    async def cache_user(self, npub: str, data: dict) -> None:
        """Upsert a user cache entry."""
        await self._db.execute(
            """INSERT OR REPLACE INTO user_cache
               (npub, debt_sats, onboarded_at, services_json, queue_json, fetched_at)
               VALUES (?, ?, ?, ?, ?, datetime('now'))""",
            (
                npub,
                data.get("debt_sats", 0),
                data.get("onboarded_at"),
                data.get("services_json"),
                data.get("queue_json"),
            ),
        )
        await self._db.commit()

    async def get_cached_user(self, npub: str) -> dict | None:
        """Fetch a cached user profile."""
        cursor = await self._db.execute(
            "SELECT * FROM user_cache WHERE npub = ?", (npub,)
        )
        row = await cursor.fetchone()
        return dict(row) if row else None

    # ------------------------------------------------------------------
    # Message log
    # ------------------------------------------------------------------

    async def log_message(self, direction: str, user_npub: str, content: str) -> None:
        """Append a message to the log."""
        await self._db.execute(
            """INSERT INTO message_log (direction, user_npub, content)
               VALUES (?, ?, ?)""",
            (direction, user_npub, content),
        )
        await self._db.commit()

    async def get_messages(self, user_npub: str, limit: int = 50) -> list[dict]:
        """Return recent messages for a user, newest first."""
        cursor = await self._db.execute(
            """SELECT * FROM message_log
               WHERE user_npub = ?
               ORDER BY id DESC
               LIMIT ?""",
            (user_npub, limit),
        )
        return [dict(r) for r in await cursor.fetchall()]

    async def purge_old_messages(self, days: int = 90) -> int:
        """Delete messages older than N days. Return count deleted."""
        cursor = await self._db.execute(
            "DELETE FROM message_log WHERE created_at < datetime('now', ?)",
            (f"-{days} days",),
        )
        await self._db.commit()
        return cursor.rowcount
