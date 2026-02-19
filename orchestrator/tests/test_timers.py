"""Tests for the persistent timer queue module."""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone, timedelta

import pytest
import pytest_asyncio

from db import Database
from timers import TimerQueue, OUTREACH, OTP_TIMEOUT


@pytest_asyncio.fixture
async def db():
    """In-memory database, connected and ready."""
    database = Database(":memory:")
    await database.connect()
    yield database
    await database.close()


@pytest_asyncio.fixture
async def tq(db: Database):
    """TimerQueue wired to the in-memory DB with a 1-second tick."""
    queue = TimerQueue(db, tick_seconds=1)
    yield queue
    # Ensure the loop is stopped if a test started it.
    await queue.stop()


class _Recorder:
    """Collects callback invocations for assertions."""

    def __init__(self):
        self.calls: list[tuple[str, str, dict | None]] = []

    async def __call__(self, timer_type: str, target_id: str, payload: dict | None):
        self.calls.append((timer_type, target_id, payload))


# ------------------------------------------------------------------
# Core behaviour
# ------------------------------------------------------------------


@pytest.mark.asyncio
async def test_schedule_and_tick(tq: TimerQueue):
    """Schedule a timer due now, tick, verify callback receives correct args."""
    rec = _Recorder()
    tq.set_callback(rec)

    fire_at = datetime.now(timezone.utc) - timedelta(seconds=1)
    await tq.schedule(OUTREACH, "job-1", fire_at)

    fired = await tq.tick()
    assert fired == 1
    assert len(rec.calls) == 1
    assert rec.calls[0] == (OUTREACH, "job-1", None)


@pytest.mark.asyncio
async def test_schedule_delay(tq: TimerQueue):
    """schedule_delay with 0s should fire immediately on next tick."""
    rec = _Recorder()
    tq.set_callback(rec)

    await tq.schedule_delay(OTP_TIMEOUT, "job-2", delay_seconds=0)

    fired = await tq.tick()
    assert fired == 1
    assert rec.calls[0][0] == OTP_TIMEOUT
    assert rec.calls[0][1] == "job-2"


@pytest.mark.asyncio
async def test_tick_does_not_fire_future(tq: TimerQueue):
    """A timer far in the future should not fire on tick."""
    rec = _Recorder()
    tq.set_callback(rec)

    fire_at = datetime.now(timezone.utc) + timedelta(hours=24)
    await tq.schedule(OUTREACH, "job-3", fire_at)

    fired = await tq.tick()
    assert fired == 0
    assert len(rec.calls) == 0


@pytest.mark.asyncio
async def test_cancel_timer(tq: TimerQueue):
    """Cancelled timers should not fire."""
    rec = _Recorder()
    tq.set_callback(rec)

    fire_at = datetime.now(timezone.utc) - timedelta(seconds=1)
    await tq.schedule(OUTREACH, "job-4", fire_at)

    cancelled = await tq.cancel(OUTREACH, "job-4")
    assert cancelled == 1

    fired = await tq.tick()
    assert fired == 0
    assert len(rec.calls) == 0


@pytest.mark.asyncio
async def test_callback_exception_does_not_stop_tick(tq: TimerQueue):
    """If a callback raises, remaining due timers still get processed."""
    call_log: list[str] = []

    async def flaky_callback(timer_type: str, target_id: str, payload: dict | None):
        call_log.append(target_id)
        if target_id == "job-bad":
            raise RuntimeError("boom")

    tq.set_callback(flaky_callback)

    fire_at = datetime.now(timezone.utc) - timedelta(seconds=1)
    await tq.schedule(OUTREACH, "job-bad", fire_at)
    await tq.schedule(OUTREACH, "job-good", fire_at)

    fired = await tq.tick()
    assert fired == 2
    assert "job-bad" in call_log
    assert "job-good" in call_log


@pytest.mark.asyncio
async def test_tick_returns_count(tq: TimerQueue):
    """tick() should return the exact number of timers fired."""
    fire_at = datetime.now(timezone.utc) - timedelta(seconds=1)
    await tq.schedule(OUTREACH, "j1", fire_at)
    await tq.schedule(OTP_TIMEOUT, "j2", fire_at)
    await tq.schedule(OUTREACH, "j3", fire_at)

    fired = await tq.tick()
    assert fired == 3


@pytest.mark.asyncio
async def test_fired_timer_not_refired(tq: TimerQueue):
    """A timer that already fired should not fire again on a second tick."""
    rec = _Recorder()
    tq.set_callback(rec)

    fire_at = datetime.now(timezone.utc) - timedelta(seconds=1)
    await tq.schedule(OUTREACH, "job-once", fire_at)

    await tq.tick()
    assert len(rec.calls) == 1

    await tq.tick()
    assert len(rec.calls) == 1  # still 1, not 2


@pytest.mark.asyncio
async def test_payload_roundtrip(tq: TimerQueue):
    """Payload dict should survive the schedule -> tick -> callback cycle."""
    rec = _Recorder()
    tq.set_callback(rec)

    payload = {"attempt": 3, "service": "netflix"}
    fire_at = datetime.now(timezone.utc) - timedelta(seconds=1)
    await tq.schedule(OUTREACH, "job-pl", fire_at, payload=payload)

    await tq.tick()
    assert rec.calls[0][2] == payload


@pytest.mark.asyncio
async def test_payload_none(tq: TimerQueue):
    """Scheduling without a payload should deliver None to the callback."""
    rec = _Recorder()
    tq.set_callback(rec)

    fire_at = datetime.now(timezone.utc) - timedelta(seconds=1)
    await tq.schedule(OUTREACH, "job-np", fire_at)

    await tq.tick()
    assert rec.calls[0][2] is None


@pytest.mark.asyncio
async def test_start_stop(tq: TimerQueue):
    """The background loop should fire due timers, then stop cleanly."""
    rec = _Recorder()
    tq.set_callback(rec)

    fire_at = datetime.now(timezone.utc) - timedelta(seconds=1)
    await tq.schedule(OUTREACH, "job-bg", fire_at)

    await tq.start()
    # Give the loop time to run at least one tick.
    await asyncio.sleep(0.3)
    await tq.stop()

    assert len(rec.calls) == 1
    assert rec.calls[0] == (OUTREACH, "job-bg", None)
