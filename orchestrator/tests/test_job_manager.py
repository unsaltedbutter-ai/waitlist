"""Tests for job lifecycle management (job_manager.py)."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from datetime import datetime, timezone, timedelta
from unittest.mock import AsyncMock, patch

import pytest
import pytest_asyncio

from db import Database
from job_manager import JobManager, _TERMINAL_STATUSES, _OUTREACH_STATUSES
from session import Session
from timers import TimerQueue, OUTREACH, LAST_CHANCE, IMPLIED_SKIP, OTP_TIMEOUT, PAYMENT_EXPIRY


# ------------------------------------------------------------------
# Helpers
# ------------------------------------------------------------------


def _make_job(
    job_id: str = "job-1",
    user_npub: str = "npub1alice",
    service_id: str = "netflix",
    action: str = "cancel",
    trigger: str = "outreach",
    status: str = "dispatched",
    billing_date: str | None = None,
    access_end_date: str | None = None,
    outreach_count: int = 0,
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
        "billing_date": billing_date,
        "access_end_date": access_end_date,
        "outreach_count": outreach_count,
        "next_outreach_at": None,
        "amount_sats": None,
        "invoice_id": None,
        "created_at": created_at,
        "updated_at": created_at,
    }
    base.update(overrides)
    return base


@dataclass(frozen=True)
class FakeConfig:
    max_concurrent_agent_jobs: int = 2
    action_price_sats: int = 3000
    otp_timeout_seconds: int = 900
    payment_expiry_seconds: int = 86400
    outreach_interval_seconds: int = 172800  # 48h
    base_url: str = "https://unsaltedbutter.ai"


# ------------------------------------------------------------------
# Fixtures
# ------------------------------------------------------------------


@pytest_asyncio.fixture
async def db():
    database = Database(":memory:")
    await database.connect()
    yield database
    await database.close()


@pytest_asyncio.fixture
async def timers(db: Database):
    queue = TimerQueue(db, tick_seconds=1)
    yield queue
    await queue.stop()


@pytest_asyncio.fixture
async def deps(db, timers):
    """Return a dict of all JobManager dependencies with mocks where needed."""
    api = AsyncMock()
    session = AsyncMock(spec=Session)
    session.is_busy = AsyncMock(return_value=False)
    session.handle_otp_confirm_yes = AsyncMock()
    session.handle_otp_timeout = AsyncMock()
    session.handle_payment_expired = AsyncMock()
    send_dm = AsyncMock()
    config = FakeConfig()

    jm = JobManager(
        db=db,
        api=api,
        session=session,
        timers=timers,
        config=config,
        send_dm=send_dm,
    )
    return {
        "jm": jm,
        "db": db,
        "api": api,
        "session": session,
        "timers": timers,
        "send_dm": send_dm,
        "config": config,
    }


# ------------------------------------------------------------------
# poll_and_claim
# ------------------------------------------------------------------


@pytest.mark.asyncio
async def test_poll_and_claim_happy_path(deps):
    """Pending jobs are fetched, claimed, cached locally, outreach sent."""
    jm = deps["jm"]
    api = deps["api"]
    db = deps["db"]
    send_dm = deps["send_dm"]

    pending_job = _make_job(status="pending")
    api.get_pending_jobs.return_value = [pending_job]
    api.claim_jobs.return_value = {"claimed": [{"id": "job-1"}], "blocked": []}
    api.get_user.return_value = {"debt_sats": 0}
    api.update_job_status.return_value = {"job": pending_job}

    claimed = await jm.poll_and_claim()

    assert len(claimed) == 1
    assert claimed[0]["id"] == "job-1"

    # Job cached locally
    local_job = await db.get_job("job-1")
    assert local_job is not None
    # After outreach, status should be outreach_sent
    assert local_job["status"] == "outreach_sent"

    # Outreach DM sent
    send_dm.assert_awaited()


@pytest.mark.asyncio
async def test_poll_and_claim_empty(deps):
    """No pending jobs returns empty list."""
    jm = deps["jm"]
    api = deps["api"]

    api.get_pending_jobs.return_value = []

    claimed = await jm.poll_and_claim()
    assert claimed == []
    api.claim_jobs.assert_not_awaited()


@pytest.mark.asyncio
async def test_poll_and_claim_some_blocked(deps):
    """Blocked jobs are not cached or outreached."""
    jm = deps["jm"]
    api = deps["api"]
    db = deps["db"]

    job_a = _make_job(job_id="job-a")
    job_b = _make_job(job_id="job-b")
    api.get_pending_jobs.return_value = [job_a, job_b]
    api.claim_jobs.return_value = {"claimed": [{"id": "job-a"}], "blocked": ["job-b"]}
    api.get_user.return_value = {"debt_sats": 0}
    api.update_job_status.return_value = {"job": job_a}

    claimed = await jm.poll_and_claim()

    assert len(claimed) == 1
    assert claimed[0]["id"] == "job-a"

    # job-b should not be in local DB
    assert await db.get_job("job-b") is None


# ------------------------------------------------------------------
# send_outreach
# ------------------------------------------------------------------


@pytest.mark.asyncio
async def test_send_outreach_first_cancel_with_billing_date(deps):
    """First cancel outreach with a known billing date uses outreach_cancel."""
    jm = deps["jm"]
    db = deps["db"]
    api = deps["api"]
    send_dm = deps["send_dm"]

    job = _make_job(billing_date="2026-03-15")
    await db.upsert_job(job)
    api.get_user.return_value = {"debt_sats": 0}
    api.update_job_status.return_value = {"job": job}

    await jm.send_outreach("job-1")

    send_dm.assert_awaited_once()
    msg = send_dm.call_args[0][1]
    assert "2026-03-15" in msg
    assert "cancel" in msg.lower() or "Netflix" in msg


@pytest.mark.asyncio
async def test_send_outreach_first_cancel_no_billing_date(deps):
    """First cancel outreach without billing date uses outreach_cancel_no_date."""
    jm = deps["jm"]
    db = deps["db"]
    api = deps["api"]
    send_dm = deps["send_dm"]

    job = _make_job(billing_date=None)
    await db.upsert_job(job)
    api.get_user.return_value = {"debt_sats": 0}
    api.update_job_status.return_value = {"job": job}

    await jm.send_outreach("job-1")

    send_dm.assert_awaited_once()
    msg = send_dm.call_args[0][1]
    assert "Ready to cancel" in msg


@pytest.mark.asyncio
async def test_send_outreach_first_resume(deps):
    """First resume outreach uses outreach_resume."""
    jm = deps["jm"]
    db = deps["db"]
    api = deps["api"]
    send_dm = deps["send_dm"]

    job = _make_job(action="resume")
    await db.upsert_job(job)
    api.get_user.return_value = {"debt_sats": 0}
    api.update_job_status.return_value = {"job": job}

    await jm.send_outreach("job-1")

    send_dm.assert_awaited_once()
    msg = send_dm.call_args[0][1]
    assert "resume" in msg.lower() or "Netflix" in msg


@pytest.mark.asyncio
async def test_send_outreach_followup(deps):
    """Followup outreach (count > 0) uses outreach_followup."""
    jm = deps["jm"]
    db = deps["db"]
    api = deps["api"]
    send_dm = deps["send_dm"]

    job = _make_job(outreach_count=1)
    await db.upsert_job(job)
    api.get_user.return_value = {"debt_sats": 0}
    api.update_job_status.return_value = {"job": job}

    await jm.send_outreach("job-1")

    send_dm.assert_awaited_once()
    msg = send_dm.call_args[0][1]
    assert "Still thinking" in msg


@pytest.mark.asyncio
async def test_send_outreach_user_busy(deps):
    """If user is busy, skip outreach (no DM sent)."""
    jm = deps["jm"]
    db = deps["db"]
    session = deps["session"]
    send_dm = deps["send_dm"]

    await db.upsert_job(_make_job())
    session.is_busy.return_value = True

    await jm.send_outreach("job-1")

    send_dm.assert_not_awaited()


@pytest.mark.asyncio
async def test_send_outreach_user_has_debt(deps):
    """If user has debt, send debt_block and skip outreach."""
    jm = deps["jm"]
    db = deps["db"]
    api = deps["api"]
    send_dm = deps["send_dm"]

    await db.upsert_job(_make_job())
    api.get_user.return_value = {"debt_sats": 6000}

    await jm.send_outreach("job-1")

    send_dm.assert_awaited_once()
    msg = send_dm.call_args[0][1]
    assert "6,000" in msg
    assert "outstanding" in msg.lower() or "balance" in msg.lower()


@pytest.mark.asyncio
async def test_send_outreach_schedules_timers(deps):
    """Outreach should schedule an outreach followup timer (and implied_skip if billing_date)."""
    jm = deps["jm"]
    db = deps["db"]
    api = deps["api"]

    future_date = (datetime.now(timezone.utc) + timedelta(days=10)).isoformat()
    job = _make_job(billing_date=future_date)
    await db.upsert_job(job)
    api.get_user.return_value = {"debt_sats": 0}
    api.update_job_status.return_value = {"job": job}

    await jm.send_outreach("job-1")

    # Outreach timer scheduled
    cursor = await db._db.execute(
        "SELECT * FROM timers WHERE timer_type = ? AND target_id = ? AND fired = 0",
        (OUTREACH, "job-1"),
    )
    outreach_rows = await cursor.fetchall()
    assert len(outreach_rows) == 1

    # Implied skip timer scheduled
    cursor = await db._db.execute(
        "SELECT * FROM timers WHERE timer_type = ? AND target_id = ? AND fired = 0",
        (IMPLIED_SKIP, "job-1"),
    )
    skip_rows = await cursor.fetchall()
    assert len(skip_rows) == 1


@pytest.mark.asyncio
async def test_send_outreach_updates_local_job(deps):
    """After outreach, local job should have outreach_sent status and incremented count."""
    jm = deps["jm"]
    db = deps["db"]
    api = deps["api"]

    await db.upsert_job(_make_job())
    api.get_user.return_value = {"debt_sats": 0}
    api.update_job_status.return_value = {"job": {}}

    await jm.send_outreach("job-1")

    local_job = await db.get_job("job-1")
    assert local_job["status"] == "outreach_sent"
    assert local_job["outreach_count"] == 1
    assert local_job["next_outreach_at"] is not None


# ------------------------------------------------------------------
# handle_skip
# ------------------------------------------------------------------


@pytest.mark.asyncio
async def test_handle_skip(deps):
    """Skip marks user_skip, cancels timers, DMs ack."""
    jm = deps["jm"]
    db = deps["db"]
    api = deps["api"]
    send_dm = deps["send_dm"]
    timers = deps["timers"]

    await db.upsert_job(_make_job(status="outreach_sent"))
    # Pre-schedule timers that should be cancelled
    await timers.schedule_delay(OUTREACH, "job-1", 172800)
    await timers.schedule_delay(IMPLIED_SKIP, "job-1", 172800)

    api.update_job_status.return_value = {"job": {}}

    await jm.handle_skip("npub1alice", "job-1")

    # Local job status
    local_job = await db.get_job("job-1")
    assert local_job["status"] == "user_skip"

    # VPS updated
    api.update_job_status.assert_awaited_once_with("job-1", "user_skip")

    # DM sent
    send_dm.assert_awaited_once()
    msg = send_dm.call_args[0][1]
    assert "Skipping" in msg

    # Timers cancelled
    cursor = await db._db.execute(
        "SELECT * FROM timers WHERE target_id = ? AND fired = 0",
        ("job-1",),
    )
    rows = await cursor.fetchall()
    assert len(rows) == 0


# ------------------------------------------------------------------
# handle_snooze
# ------------------------------------------------------------------


@pytest.mark.asyncio
async def test_handle_snooze(deps):
    """Snooze marks snoozed, DMs ack, schedules 48h timer."""
    jm = deps["jm"]
    db = deps["db"]
    api = deps["api"]
    send_dm = deps["send_dm"]
    timers = deps["timers"]

    await db.upsert_job(_make_job(status="outreach_sent"))
    # Pre-schedule outreach timer that should be replaced
    await timers.schedule_delay(OUTREACH, "job-1", 172800)

    api.update_job_status.return_value = {"job": {}}

    await jm.handle_snooze("npub1alice", "job-1")

    # Local job status
    local_job = await db.get_job("job-1")
    assert local_job["status"] == "snoozed"
    assert local_job["next_outreach_at"] is not None

    # VPS updated with snoozed status
    api.update_job_status.assert_awaited_once()
    call_kwargs = api.update_job_status.call_args
    assert call_kwargs[0][1] == "snoozed"

    # DM sent
    send_dm.assert_awaited_once()
    msg = send_dm.call_args[0][1]
    assert "Snoozed" in msg or "48 hours" in msg

    # New outreach timer scheduled
    cursor = await db._db.execute(
        "SELECT * FROM timers WHERE timer_type = ? AND target_id = ? AND fired = 0",
        (OUTREACH, "job-1"),
    )
    rows = await cursor.fetchall()
    assert len(rows) == 1


# ------------------------------------------------------------------
# Dispatch queue
# ------------------------------------------------------------------


@pytest.mark.asyncio
async def test_agent_slot_available_default(deps):
    """With no active jobs, slots should be available."""
    jm = deps["jm"]
    assert jm.agent_slot_available() is True


@pytest.mark.asyncio
async def test_agent_slot_available_full(deps):
    """When active jobs == max, no slots available."""
    jm = deps["jm"]
    jm._active_agent_jobs = {"job-a", "job-b"}  # max_concurrent = 2
    assert jm.agent_slot_available() is False


@pytest.mark.asyncio
async def test_request_dispatch_slot_available(deps):
    """With a free slot, request_dispatch dispatches immediately."""
    jm = deps["jm"]
    session = deps["session"]
    db = deps["db"]

    await db.upsert_job(_make_job())

    await jm.request_dispatch("npub1alice", "job-1")

    # Job added to active set
    assert "job-1" in jm._active_agent_jobs

    # Session.handle_otp_confirm_yes called
    session.handle_otp_confirm_yes.assert_awaited_once_with("npub1alice")


@pytest.mark.asyncio
async def test_request_dispatch_no_slot_queues(deps):
    """With no free slot, job goes to dispatch queue."""
    jm = deps["jm"]
    session = deps["session"]
    db = deps["db"]
    send_dm = deps["send_dm"]

    # Fill both slots
    jm._active_agent_jobs = {"job-x", "job-y"}
    await db.upsert_job(_make_job())

    await jm.request_dispatch("npub1alice", "job-1")

    # Not dispatched
    session.handle_otp_confirm_yes.assert_not_awaited()

    # Added to dispatch queue
    assert "job-1" in jm._dispatch_queue

    # User was told they're queued (ETA message)
    send_dm.assert_awaited_once()
    msg = send_dm.call_args[0][1]
    assert "minutes" in msg.lower()


@pytest.mark.asyncio
async def test_on_job_complete_dispatches_next(deps):
    """Completing a job frees a slot and dispatches the next queued job."""
    jm = deps["jm"]
    session = deps["session"]
    db = deps["db"]

    await db.upsert_job(_make_job(job_id="job-queued", user_npub="npub1bob"))

    # One slot occupied, one queued
    jm._active_agent_jobs = {"job-current"}
    jm._dispatch_queue = ["job-queued"]

    await jm.on_job_complete("job-current")

    # Old job removed from active
    assert "job-current" not in jm._active_agent_jobs

    # Queued job dispatched
    assert "job-queued" in jm._active_agent_jobs
    session.handle_otp_confirm_yes.assert_awaited_once_with("npub1bob")


@pytest.mark.asyncio
async def test_on_job_complete_empty_queue(deps):
    """Completing a job with an empty queue just frees the slot."""
    jm = deps["jm"]
    session = deps["session"]

    jm._active_agent_jobs = {"job-current"}

    await jm.on_job_complete("job-current")

    assert "job-current" not in jm._active_agent_jobs
    assert len(jm._active_agent_jobs) == 0
    session.handle_otp_confirm_yes.assert_not_awaited()


@pytest.mark.asyncio
async def test_try_dispatch_next_no_slot(deps):
    """try_dispatch_next returns False when no slots available."""
    jm = deps["jm"]
    jm._active_agent_jobs = {"job-a", "job-b"}
    jm._dispatch_queue = ["job-c"]

    result = await jm.try_dispatch_next()
    assert result is False


@pytest.mark.asyncio
async def test_try_dispatch_next_empty_queue(deps):
    """try_dispatch_next returns False when queue is empty."""
    jm = deps["jm"]
    result = await jm.try_dispatch_next()
    assert result is False


# ------------------------------------------------------------------
# Timer callbacks (handle_timer routing)
# ------------------------------------------------------------------


@pytest.mark.asyncio
async def test_handle_timer_outreach(deps):
    """OUTREACH timer routes to handle_outreach_timer."""
    jm = deps["jm"]
    db = deps["db"]
    api = deps["api"]

    await db.upsert_job(_make_job(status="outreach_sent", outreach_count=1))
    api.get_user.return_value = {"debt_sats": 0}
    api.update_job_status.return_value = {"job": {}}

    await jm.handle_timer(OUTREACH, "job-1", None)

    # Should have sent a followup outreach
    send_dm = deps["send_dm"]
    send_dm.assert_awaited()


@pytest.mark.asyncio
async def test_handle_timer_otp_timeout(deps):
    """OTP_TIMEOUT timer delegates to session.handle_otp_timeout."""
    jm = deps["jm"]
    session = deps["session"]

    await jm.handle_timer(OTP_TIMEOUT, "job-1", None)

    session.handle_otp_timeout.assert_awaited_once_with("job-1")


@pytest.mark.asyncio
async def test_handle_timer_payment_expiry(deps):
    """PAYMENT_EXPIRY timer delegates to session.handle_payment_expired."""
    jm = deps["jm"]
    session = deps["session"]

    await jm.handle_timer(PAYMENT_EXPIRY, "job-1", None)

    session.handle_payment_expired.assert_awaited_once_with("job-1")


@pytest.mark.asyncio
async def test_handle_timer_implied_skip(deps):
    """IMPLIED_SKIP timer routes to handle_implied_skip."""
    jm = deps["jm"]
    db = deps["db"]
    api = deps["api"]

    await db.upsert_job(_make_job(status="outreach_sent"))
    api.update_job_status.return_value = {"job": {}}

    await jm.handle_timer(IMPLIED_SKIP, "job-1", None)

    local_job = await db.get_job("job-1")
    assert local_job["status"] == "implied_skip"


@pytest.mark.asyncio
async def test_handle_timer_last_chance(deps):
    """LAST_CHANCE timer sends a last-chance DM."""
    jm = deps["jm"]
    db = deps["db"]
    send_dm = deps["send_dm"]

    billing = (datetime.now(timezone.utc) + timedelta(days=4)).isoformat()
    await db.upsert_job(_make_job(status="outreach_sent", billing_date=billing))

    await jm.handle_timer(LAST_CHANCE, "job-1", None)

    send_dm.assert_awaited_once()
    msg = send_dm.call_args[0][1]
    assert "Last chance" in msg or "days" in msg


# ------------------------------------------------------------------
# handle_outreach_timer
# ------------------------------------------------------------------


@pytest.mark.asyncio
async def test_outreach_timer_terminal_job_ignored(deps):
    """If job is terminal when outreach timer fires, do nothing."""
    jm = deps["jm"]
    db = deps["db"]
    send_dm = deps["send_dm"]

    await db.upsert_job(_make_job(status="completed_paid"))

    await jm.handle_outreach_timer("job-1")

    send_dm.assert_not_awaited()


@pytest.mark.asyncio
async def test_outreach_timer_user_busy_reschedules(deps):
    """If user is busy, reschedule the outreach timer."""
    jm = deps["jm"]
    db = deps["db"]
    session = deps["session"]
    send_dm = deps["send_dm"]

    await db.upsert_job(_make_job(status="outreach_sent"))
    session.is_busy.return_value = True

    await jm.handle_outreach_timer("job-1")

    # No DM sent (user is busy)
    send_dm.assert_not_awaited()

    # Timer rescheduled
    cursor = await db._db.execute(
        "SELECT * FROM timers WHERE timer_type = ? AND target_id = ? AND fired = 0",
        (OUTREACH, "job-1"),
    )
    rows = await cursor.fetchall()
    assert len(rows) == 1


# ------------------------------------------------------------------
# handle_last_chance
# ------------------------------------------------------------------


@pytest.mark.asyncio
async def test_last_chance_no_billing_date(deps):
    """If no billing date, skip (no DM)."""
    jm = deps["jm"]
    db = deps["db"]
    send_dm = deps["send_dm"]

    await db.upsert_job(_make_job(status="outreach_sent", billing_date=None))

    await jm.handle_last_chance("job-1")

    send_dm.assert_not_awaited()


@pytest.mark.asyncio
async def test_last_chance_terminal_job_ignored(deps):
    """If job is terminal, skip last chance."""
    jm = deps["jm"]
    db = deps["db"]
    send_dm = deps["send_dm"]

    billing = (datetime.now(timezone.utc) + timedelta(days=4)).isoformat()
    await db.upsert_job(_make_job(status="user_skip", billing_date=billing))

    await jm.handle_last_chance("job-1")

    send_dm.assert_not_awaited()


@pytest.mark.asyncio
async def test_last_chance_user_busy_skips(deps):
    """If user is busy, skip last chance (no reschedule)."""
    jm = deps["jm"]
    db = deps["db"]
    session = deps["session"]
    send_dm = deps["send_dm"]

    billing = (datetime.now(timezone.utc) + timedelta(days=4)).isoformat()
    await db.upsert_job(_make_job(status="outreach_sent", billing_date=billing))
    session.is_busy.return_value = True

    await jm.handle_last_chance("job-1")

    send_dm.assert_not_awaited()


@pytest.mark.asyncio
async def test_last_chance_past_billing_date(deps):
    """If billing date is in the past, skip (no DM)."""
    jm = deps["jm"]
    db = deps["db"]
    send_dm = deps["send_dm"]

    billing = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()
    await db.upsert_job(_make_job(status="outreach_sent", billing_date=billing))

    await jm.handle_last_chance("job-1")

    send_dm.assert_not_awaited()


# ------------------------------------------------------------------
# handle_implied_skip
# ------------------------------------------------------------------


@pytest.mark.asyncio
async def test_implied_skip_happy_path(deps):
    """Implied skip updates VPS and local, cancels timers."""
    jm = deps["jm"]
    db = deps["db"]
    api = deps["api"]
    timers = deps["timers"]

    await db.upsert_job(_make_job(status="outreach_sent"))
    await timers.schedule_delay(OUTREACH, "job-1", 172800)

    api.update_job_status.return_value = {"job": {}}

    await jm.handle_implied_skip("job-1")

    # Local status
    local_job = await db.get_job("job-1")
    assert local_job["status"] == "implied_skip"

    # VPS updated
    api.update_job_status.assert_awaited_once_with("job-1", "implied_skip")

    # Outreach timer cancelled
    cursor = await db._db.execute(
        "SELECT * FROM timers WHERE timer_type = ? AND target_id = ? AND fired = 0",
        (OUTREACH, "job-1"),
    )
    rows = await cursor.fetchall()
    assert len(rows) == 0


@pytest.mark.asyncio
async def test_implied_skip_terminal_ignored(deps):
    """If job is already terminal, implied_skip is a no-op."""
    jm = deps["jm"]
    db = deps["db"]
    api = deps["api"]

    await db.upsert_job(_make_job(status="completed_paid"))

    await jm.handle_implied_skip("job-1")

    api.update_job_status.assert_not_awaited()


# ------------------------------------------------------------------
# get_active_job_for_user
# ------------------------------------------------------------------


@pytest.mark.asyncio
async def test_get_active_job_for_user_finds_outreach(deps):
    """Returns the first job with an outreach-eligible status."""
    jm = deps["jm"]
    db = deps["db"]

    await db.upsert_job(_make_job(job_id="job-done", status="completed_paid"))
    await db.upsert_job(_make_job(job_id="job-active", status="outreach_sent"))

    result = await jm.get_active_job_for_user("npub1alice")

    assert result is not None
    assert result["id"] == "job-active"


@pytest.mark.asyncio
async def test_get_active_job_for_user_none_when_all_terminal(deps):
    """Returns None if all jobs are terminal."""
    jm = deps["jm"]
    db = deps["db"]

    await db.upsert_job(_make_job(job_id="job-done", status="completed_paid"))
    await db.upsert_job(_make_job(job_id="job-fail", status="failed"))

    result = await jm.get_active_job_for_user("npub1alice")
    assert result is None


@pytest.mark.asyncio
async def test_get_active_job_for_user_no_jobs(deps):
    """Returns None if user has no jobs."""
    jm = deps["jm"]

    result = await jm.get_active_job_for_user("npub1nobody")
    assert result is None


@pytest.mark.asyncio
async def test_get_active_job_for_user_snoozed(deps):
    """Snoozed jobs are found by get_active_job_for_user."""
    jm = deps["jm"]
    db = deps["db"]

    await db.upsert_job(_make_job(status="snoozed"))

    result = await jm.get_active_job_for_user("npub1alice")
    assert result is not None
    assert result["status"] == "snoozed"


# ------------------------------------------------------------------
# reconcile_cancelled_jobs
# ------------------------------------------------------------------


@pytest.mark.asyncio
async def test_reconcile_updates_local_status(deps):
    """Reconcile updates a non-terminal local job to the VPS terminal status."""
    jm = deps["jm"]
    db = deps["db"]

    await db.upsert_job(_make_job(status="outreach_sent"))

    count = await jm.reconcile_cancelled_jobs([
        {"id": "job-1", "status": "user_skip"},
    ])

    assert count == 1
    local_job = await db.get_job("job-1")
    assert local_job["status"] == "user_skip"


@pytest.mark.asyncio
async def test_reconcile_cancels_timers(deps):
    """Reconcile cancels all timer types for the job."""
    jm = deps["jm"]
    db = deps["db"]
    timers = deps["timers"]

    await db.upsert_job(_make_job(status="outreach_sent"))
    await timers.schedule_delay(OUTREACH, "job-1", 172800)
    await timers.schedule_delay(IMPLIED_SKIP, "job-1", 172800)

    await jm.reconcile_cancelled_jobs([
        {"id": "job-1", "status": "user_skip"},
    ])

    # All timers should be gone
    cursor = await db._db.execute(
        "SELECT * FROM timers WHERE target_id = ? AND fired = 0",
        ("job-1",),
    )
    rows = await cursor.fetchall()
    assert len(rows) == 0


@pytest.mark.asyncio
async def test_reconcile_deletes_linked_session(deps):
    """Reconcile deletes a session linked to the reconciled job."""
    jm = deps["jm"]
    db = deps["db"]

    await db.upsert_job(_make_job(status="active"))
    await db.upsert_session("npub1alice", "AWAITING_OTP", job_id="job-1")

    await jm.reconcile_cancelled_jobs([
        {"id": "job-1", "status": "failed"},
    ])

    session = await db.get_session("npub1alice")
    assert session is None


@pytest.mark.asyncio
async def test_reconcile_removes_from_dispatch_queue_and_active(deps):
    """Reconcile removes the job from dispatch queue and active agent jobs."""
    jm = deps["jm"]
    db = deps["db"]

    await db.upsert_job(_make_job(status="dispatched"))
    jm._dispatch_queue = ["job-1", "job-2"]
    jm._active_agent_jobs = {"job-1"}

    await jm.reconcile_cancelled_jobs([
        {"id": "job-1", "status": "user_skip"},
    ])

    assert "job-1" not in jm._dispatch_queue
    assert "job-1" not in jm._active_agent_jobs


@pytest.mark.asyncio
async def test_reconcile_skips_already_terminal(deps):
    """Reconcile skips jobs that are already terminal locally."""
    jm = deps["jm"]
    db = deps["db"]

    await db.upsert_job(_make_job(status="completed_paid"))

    count = await jm.reconcile_cancelled_jobs([
        {"id": "job-1", "status": "user_skip"},
    ])

    assert count == 0
    # Status unchanged
    local_job = await db.get_job("job-1")
    assert local_job["status"] == "completed_paid"


@pytest.mark.asyncio
async def test_reconcile_skips_unknown_jobs(deps):
    """Reconcile skips job IDs not in the local DB."""
    jm = deps["jm"]

    count = await jm.reconcile_cancelled_jobs([
        {"id": "nonexistent", "status": "user_skip"},
    ])

    assert count == 0


# ------------------------------------------------------------------
# cleanup_terminal_jobs
# ------------------------------------------------------------------


@pytest.mark.asyncio
async def test_cleanup_terminal_jobs(deps):
    """Terminal jobs are deleted from local DB."""
    jm = deps["jm"]
    db = deps["db"]

    await db.upsert_job(_make_job(job_id="job-done", status="completed_paid"))
    await db.upsert_job(_make_job(job_id="job-active", status="outreach_sent"))
    await db.upsert_job(_make_job(job_id="job-skip", status="user_skip"))

    deleted = await jm.cleanup_terminal_jobs()
    assert deleted == 2

    # Active job still exists
    assert await db.get_job("job-active") is not None
    # Terminal jobs gone
    assert await db.get_job("job-done") is None
    assert await db.get_job("job-skip") is None


# ------------------------------------------------------------------
# send_outreach: job not found
# ------------------------------------------------------------------


@pytest.mark.asyncio
async def test_send_outreach_job_not_found(deps):
    """If job doesn't exist locally, send_outreach is a no-op."""
    jm = deps["jm"]
    send_dm = deps["send_dm"]

    await jm.send_outreach("nonexistent")

    send_dm.assert_not_awaited()


@pytest.mark.asyncio
async def test_send_outreach_immediate_bypasses_outreach(deps):
    """Jobs marked immediate skip outreach and dispatch directly."""
    jm = deps["jm"]
    session = deps["session"]
    db = deps["db"]
    send_dm = deps["send_dm"]

    job = _make_job()
    await db.upsert_job(job)

    jm.mark_immediate("job-1")
    await jm.send_outreach("job-1")

    # No outreach DM sent
    send_dm.assert_not_awaited()
    # Dispatched directly via handle_yes
    session.handle_yes.assert_awaited_once_with("npub1alice", "job-1")


@pytest.mark.asyncio
async def test_send_outreach_non_immediate_sends_outreach(deps):
    """Jobs NOT marked immediate go through normal outreach."""
    jm = deps["jm"]
    session = deps["session"]
    db = deps["db"]
    api = deps["api"]
    send_dm = deps["send_dm"]

    job = _make_job(billing_date=None)
    await db.upsert_job(job)
    api.get_user.return_value = {"debt_sats": 0}
    api.update_job_status.return_value = {"job": job}

    await jm.send_outreach("job-1")

    # Normal outreach DM sent
    send_dm.assert_awaited_once()
    # handle_yes NOT called
    session.handle_yes.assert_not_awaited()


# ------------------------------------------------------------------
# Dispatch lock: concurrency protection
# ------------------------------------------------------------------


@pytest.mark.asyncio
async def test_dispatch_lock_exists(deps):
    """JobManager should have a _dispatch_lock attribute."""
    jm = deps["jm"]
    assert hasattr(jm, "_dispatch_lock")
    assert isinstance(jm._dispatch_lock, asyncio.Lock)


@pytest.mark.asyncio
async def test_concurrent_request_dispatch_respects_max_slots(deps):
    """Two concurrent request_dispatch calls with one slot should not both dispatch."""
    jm = deps["jm"]
    session = deps["session"]
    db = deps["db"]
    send_dm = deps["send_dm"]

    # Set max_concurrent_agent_jobs to 1 via a new config
    jm._config = FakeConfig(max_concurrent_agent_jobs=1)

    await db.upsert_job(_make_job(job_id="job-a", user_npub="npub1alice"))
    await db.upsert_job(_make_job(job_id="job-b", user_npub="npub1bob"))

    barrier = asyncio.Event()
    original_handle = session.handle_otp_confirm_yes

    async def slow_otp_confirm(user_npub):
        # Simulate slow dispatch so the race window is visible
        barrier.set()
        await asyncio.sleep(0.05)

    session.handle_otp_confirm_yes = AsyncMock(side_effect=slow_otp_confirm)

    # Launch two concurrent dispatch requests
    task_a = asyncio.create_task(jm.request_dispatch("npub1alice", "job-a"))
    await barrier.wait()
    task_b = asyncio.create_task(jm.request_dispatch("npub1bob", "job-b"))

    await asyncio.gather(task_a, task_b)

    # Only one should have been dispatched (1 slot available)
    assert len(jm._active_agent_jobs) == 1
    # The other should be in the queue
    assert len(jm._dispatch_queue) == 1


@pytest.mark.asyncio
async def test_on_job_complete_holds_lock_during_dispatch(deps):
    """on_job_complete should atomically free slot + dispatch next under lock."""
    jm = deps["jm"]
    session = deps["session"]
    db = deps["db"]

    jm._config = FakeConfig(max_concurrent_agent_jobs=1)

    await db.upsert_job(_make_job(job_id="job-queued", user_npub="npub1bob"))

    jm._active_agent_jobs = {"job-current"}
    jm._dispatch_queue = ["job-queued"]

    await jm.on_job_complete("job-current")

    # The queued job should be dispatched atomically
    assert "job-current" not in jm._active_agent_jobs
    assert "job-queued" in jm._active_agent_jobs
    session.handle_otp_confirm_yes.assert_awaited_once_with("npub1bob")


@pytest.mark.asyncio
async def test_try_dispatch_next_skips_vanished_jobs(deps):
    """try_dispatch_next should skip jobs that no longer exist and dispatch next valid one."""
    jm = deps["jm"]
    session = deps["session"]
    db = deps["db"]

    # Only job-c exists in DB
    await db.upsert_job(_make_job(job_id="job-c", user_npub="npub1carol"))

    jm._dispatch_queue = ["job-a", "job-b", "job-c"]

    result = await jm.try_dispatch_next()

    assert result is True
    assert "job-c" in jm._active_agent_jobs
    assert jm._dispatch_queue == []
    session.handle_otp_confirm_yes.assert_awaited_once_with("npub1carol")


@pytest.mark.asyncio
async def test_concurrent_on_job_complete_does_not_exceed_max(deps):
    """Two concurrent on_job_complete calls should not dispatch more than max_concurrent."""
    jm = deps["jm"]
    session = deps["session"]
    db = deps["db"]

    jm._config = FakeConfig(max_concurrent_agent_jobs=1)

    await db.upsert_job(_make_job(job_id="job-q1", user_npub="npub1alice"))
    await db.upsert_job(_make_job(job_id="job-q2", user_npub="npub1bob"))

    jm._active_agent_jobs = {"job-x", "job-y"}
    jm._dispatch_queue = ["job-q1", "job-q2"]

    # Both jobs complete simultaneously
    task_x = asyncio.create_task(jm.on_job_complete("job-x"))
    task_y = asyncio.create_task(jm.on_job_complete("job-y"))

    await asyncio.gather(task_x, task_y)

    # With max=1, at most 1 slot should be occupied
    assert len(jm._active_agent_jobs) <= 1
