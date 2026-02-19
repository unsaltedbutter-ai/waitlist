"""Tests for the orchestrator SQLite database module."""

from __future__ import annotations

import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
import pytest_asyncio

from db import Database


@pytest_asyncio.fixture
async def db():
    """In-memory database, connected and ready."""
    database = Database(":memory:")
    await database.connect()
    yield database
    await database.close()


def _make_job(
    job_id: str = "job-1",
    user_npub: str = "npub1alice",
    service_id: str = "netflix",
    action: str = "cancel",
    trigger: str = "outreach",
    status: str = "dispatched",
    created_at: str = "2026-02-18T10:00:00",
    **overrides,
) -> dict:
    base = {
        "id": job_id,
        "user_npub": user_npub,
        "service_id": service_id,
        "action": action,
        "trigger": trigger,
        "status": status,
        "billing_date": None,
        "access_end_date": None,
        "outreach_count": 0,
        "next_outreach_at": None,
        "amount_sats": None,
        "invoice_id": None,
        "created_at": created_at,
        "updated_at": created_at,
    }
    base.update(overrides)
    return base


# ------------------------------------------------------------------
# Connection / schema
# ------------------------------------------------------------------


@pytest.mark.asyncio
async def test_connect_creates_tables(db: Database):
    expected = {"jobs", "sessions", "timers", "user_cache", "message_log"}
    cursor = await db._db.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
    )
    tables = {row[0] for row in await cursor.fetchall()}
    assert expected.issubset(tables)


@pytest.mark.asyncio
async def test_wal_mode_enabled():
    # WAL mode only applies to file-backed databases, not :memory:
    with tempfile.TemporaryDirectory() as tmpdir:
        path = str(Path(tmpdir) / "test.db")
        file_db = Database(path)
        await file_db.connect()
        try:
            cursor = await file_db._db.execute("PRAGMA journal_mode")
            row = await cursor.fetchone()
            assert row[0] == "wal"
        finally:
            await file_db.close()


# ------------------------------------------------------------------
# Jobs
# ------------------------------------------------------------------


@pytest.mark.asyncio
async def test_upsert_and_get_job(db: Database):
    job = _make_job()
    await db.upsert_job(job)
    result = await db.get_job("job-1")
    assert result is not None
    assert result["id"] == "job-1"
    assert result["user_npub"] == "npub1alice"
    assert result["service_id"] == "netflix"
    assert result["status"] == "dispatched"


@pytest.mark.asyncio
async def test_get_jobs_by_status(db: Database):
    await db.upsert_job(_make_job("j1", status="dispatched"))
    await db.upsert_job(_make_job("j2", status="active"))
    await db.upsert_job(_make_job("j3", status="dispatched"))

    dispatched = await db.get_jobs_by_status("dispatched")
    assert len(dispatched) == 2
    assert {j["id"] for j in dispatched} == {"j1", "j3"}

    active = await db.get_jobs_by_status("active")
    assert len(active) == 1
    assert active[0]["id"] == "j2"


@pytest.mark.asyncio
async def test_update_job_status(db: Database):
    await db.upsert_job(_make_job())
    await db.update_job_status("job-1", "active", outreach_count=2, amount_sats=3000)
    result = await db.get_job("job-1")
    assert result["status"] == "active"
    assert result["outreach_count"] == 2
    assert result["amount_sats"] == 3000


@pytest.mark.asyncio
async def test_delete_terminal_jobs(db: Database):
    await db.upsert_job(_make_job("j-active", status="active"))
    await db.upsert_job(_make_job("j-dispatched", status="dispatched"))
    await db.upsert_job(_make_job("j-paid", status="completed_paid"))
    await db.upsert_job(_make_job("j-reneged", status="completed_reneged"))
    await db.upsert_job(_make_job("j-failed", status="failed"))
    await db.upsert_job(_make_job("j-skip", status="user_skip"))

    deleted = await db.delete_terminal_jobs()
    assert deleted == 4

    remaining = await db.get_jobs_by_status("active")
    assert len(remaining) == 1
    remaining2 = await db.get_jobs_by_status("dispatched")
    assert len(remaining2) == 1

    # Terminal ones are gone
    for status in ("completed_paid", "completed_reneged", "failed", "user_skip"):
        assert await db.get_jobs_by_status(status) == []


# ------------------------------------------------------------------
# Sessions
# ------------------------------------------------------------------


@pytest.mark.asyncio
async def test_session_crud(db: Database):
    # Initially no session
    assert await db.get_session("npub1alice") is None

    # Create
    await db.upsert_session("npub1alice", "AWAITING_CONFIRM", job_id="job-1")
    session = await db.get_session("npub1alice")
    assert session is not None
    assert session["state"] == "AWAITING_CONFIRM"
    assert session["job_id"] == "job-1"
    assert session["otp_attempts"] == 0

    # Delete
    await db.delete_session("npub1alice")
    assert await db.get_session("npub1alice") is None


@pytest.mark.asyncio
async def test_session_upsert_overwrites(db: Database):
    await db.upsert_session("npub1bob", "IDLE")
    await db.upsert_session("npub1bob", "AWAITING_OTP", job_id="job-9", otp_attempts=2)
    session = await db.get_session("npub1bob")
    assert session["state"] == "AWAITING_OTP"
    assert session["job_id"] == "job-9"
    assert session["otp_attempts"] == 2


# ------------------------------------------------------------------
# Timers
# ------------------------------------------------------------------


@pytest.mark.asyncio
async def test_timer_add_and_get_due(db: Database):
    past = "2026-02-17T00:00:00"
    future = "2099-12-31T23:59:59"
    now = "2026-02-18T12:00:00"

    id1 = await db.add_timer("outreach", "job-1", past, '{"attempt": 1}')
    id2 = await db.add_timer("payment_expiry", "job-2", future)

    assert isinstance(id1, int)
    assert isinstance(id2, int)

    due = await db.get_due_timers(now)
    assert len(due) == 1
    assert due[0]["id"] == id1
    assert due[0]["timer_type"] == "outreach"
    assert due[0]["payload"] == '{"attempt": 1}'


@pytest.mark.asyncio
async def test_timer_mark_fired(db: Database):
    timer_id = await db.add_timer("outreach", "job-1", "2026-02-17T00:00:00")
    await db.mark_timer_fired(timer_id)

    due = await db.get_due_timers("2026-02-18T12:00:00")
    assert len(due) == 0


@pytest.mark.asyncio
async def test_cancel_timers(db: Database):
    await db.add_timer("outreach", "job-1", "2026-02-17T00:00:00")
    await db.add_timer("outreach", "job-1", "2026-02-19T00:00:00")
    await db.add_timer("payment_expiry", "job-1", "2026-02-20T00:00:00")
    await db.add_timer("outreach", "job-2", "2026-02-17T00:00:00")

    # Cancel outreach timers for job-1
    cancelled = await db.cancel_timers("outreach", "job-1")
    assert cancelled == 2

    # payment_expiry for job-1 still exists
    due = await db.get_due_timers("2099-01-01T00:00:00")
    assert len(due) == 2
    types = {t["timer_type"] for t in due}
    assert types == {"payment_expiry", "outreach"}
    targets = {t["target_id"] for t in due}
    assert targets == {"job-1", "job-2"}


# ------------------------------------------------------------------
# User cache
# ------------------------------------------------------------------


@pytest.mark.asyncio
async def test_cache_user(db: Database):
    await db.cache_user(
        "npub1alice",
        {
            "debt_sats": 0,
            "onboarded_at": "2026-01-15T08:00:00",
            "services_json": '["netflix","hulu"]',
            "queue_json": '["netflix","hulu"]',
        },
    )
    user = await db.get_cached_user("npub1alice")
    assert user is not None
    assert user["npub"] == "npub1alice"
    assert user["debt_sats"] == 0
    assert user["services_json"] == '["netflix","hulu"]'

    # Not cached
    assert await db.get_cached_user("npub1nobody") is None


# ------------------------------------------------------------------
# Message log
# ------------------------------------------------------------------


@pytest.mark.asyncio
async def test_log_message(db: Database):
    await db.log_message("inbound", "npub1alice", "cancel netflix")
    await db.log_message("outbound", "npub1alice", "Got it. Starting cancel...")
    await db.log_message("inbound", "npub1bob", "hi")

    alice_msgs = await db.get_messages("npub1alice")
    assert len(alice_msgs) == 2
    # Newest first
    assert alice_msgs[0]["direction"] == "outbound"
    assert alice_msgs[1]["direction"] == "inbound"

    bob_msgs = await db.get_messages("npub1bob")
    assert len(bob_msgs) == 1


@pytest.mark.asyncio
async def test_purge_old_messages(db: Database):
    old_date = (datetime.now(timezone.utc) - timedelta(days=100)).isoformat()
    recent_date = (datetime.now(timezone.utc) - timedelta(days=10)).isoformat()

    # Insert old message with explicit created_at
    await db._db.execute(
        "INSERT INTO message_log (direction, user_npub, content, created_at) VALUES (?, ?, ?, ?)",
        ("inbound", "npub1alice", "old message", old_date),
    )
    # Insert recent message with explicit created_at
    await db._db.execute(
        "INSERT INTO message_log (direction, user_npub, content, created_at) VALUES (?, ?, ?, ?)",
        ("inbound", "npub1alice", "recent message", recent_date),
    )
    await db._db.commit()

    purged = await db.purge_old_messages(days=90)
    assert purged == 1

    remaining = await db.get_messages("npub1alice")
    assert len(remaining) == 1
    assert remaining[0]["content"] == "recent message"
