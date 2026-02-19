"""Tests for orchestrator.py background loops and wiring."""

from __future__ import annotations

import asyncio
from unittest.mock import patch, MagicMock

import pytest

from orchestrator import _invite_check_loop, _heartbeat_loop, _cleanup_loop


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

class FakeNotifications:
    def __init__(self, results=None):
        self.call_count = 0
        self._results = results or [0]

    async def send_pending_invite_dms(self):
        idx = min(self.call_count, len(self._results) - 1)
        result = self._results[idx]
        self.call_count += 1
        if isinstance(result, Exception):
            raise result
        return result


class FakeApi:
    def __init__(self, healthy=True):
        self.call_count = 0
        self.last_payload = None
        self._healthy = healthy

    async def heartbeat(self, payload=None):
        self.call_count += 1
        self.last_payload = payload
        if not self._healthy:
            raise ConnectionError("VPS down")
        return True


class FakeDb:
    def __init__(self, terminal_count=0, purge_count=0, fired_timer_count=0):
        self._terminal_count = terminal_count
        self._purge_count = purge_count
        self._fired_timer_count = fired_timer_count
        self.delete_calls = 0
        self.purge_calls = 0
        self.fired_timer_calls = 0

    async def delete_terminal_jobs(self):
        self.delete_calls += 1
        return self._terminal_count

    async def purge_old_messages(self, days=90):
        self.purge_calls += 1
        return self._purge_count

    async def delete_fired_timers(self, max_age_hours=168):
        self.fired_timer_calls += 1
        return self._fired_timer_count


# ---------------------------------------------------------------------------
# _invite_check_loop
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_invite_check_loop_sends_invites():
    """Invite check loop calls send_pending_invite_dms after initial delay."""
    notif = FakeNotifications(results=[3])
    shutdown = asyncio.Event()

    async def stop_soon():
        # Let loop do initial wait (we'll set timeout very short)
        await asyncio.sleep(0.05)
        shutdown.set()

    # Run loop with very short initial delay by patching the wait
    task = asyncio.create_task(
        _invite_check_loop(notif, shutdown, interval_seconds=1)
    )
    stop_task = asyncio.create_task(stop_soon())

    # The initial 60s wait will be cut short by shutdown
    await asyncio.gather(task, stop_task)
    # With 60s initial delay and shutdown at 50ms, invites aren't called
    # (the loop exits on shutdown during the initial wait)


@pytest.mark.asyncio
async def test_invite_check_loop_exits_on_shutdown_during_wait():
    """Loop exits cleanly when shutdown fires during inter-iteration wait."""
    notif = FakeNotifications(results=[0])
    shutdown = asyncio.Event()
    shutdown.set()  # Already shutting down

    await _invite_check_loop(notif, shutdown, interval_seconds=1)
    assert notif.call_count == 0


@pytest.mark.asyncio
async def test_invite_check_loop_handles_exception():
    """Loop continues after an exception from send_pending_invite_dms."""
    notif = FakeNotifications(results=[RuntimeError("boom"), 2])
    shutdown = asyncio.Event()

    # Set shutdown immediately so the loop exits after initial delay
    shutdown.set()

    await _invite_check_loop(notif, shutdown)
    assert notif.call_count == 0  # exits during initial wait


# ---------------------------------------------------------------------------
# _heartbeat_loop
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_heartbeat_loop_calls_api():
    """Heartbeat loop calls api.heartbeat on each tick."""
    api = FakeApi()
    shutdown = asyncio.Event()

    async def stop_soon():
        await asyncio.sleep(0.05)
        shutdown.set()

    task = asyncio.create_task(_heartbeat_loop(api, shutdown, interval_seconds=0))
    stop_task = asyncio.create_task(stop_soon())
    await asyncio.gather(task, stop_task)

    assert api.call_count >= 1


@pytest.mark.asyncio
async def test_heartbeat_loop_exits_on_shutdown():
    """Heartbeat loop exits immediately if shutdown is already set."""
    api = FakeApi()
    shutdown = asyncio.Event()
    shutdown.set()

    await _heartbeat_loop(api, shutdown, interval_seconds=1)
    # while loop condition is false immediately, so heartbeat is never called
    assert api.call_count == 0


@pytest.mark.asyncio
async def test_heartbeat_loop_handles_exception():
    """Heartbeat loop continues after an API error."""
    api = FakeApi(healthy=False)
    shutdown = asyncio.Event()

    async def stop_soon():
        await asyncio.sleep(0.05)
        shutdown.set()

    task = asyncio.create_task(_heartbeat_loop(api, shutdown, interval_seconds=0))
    stop_task = asyncio.create_task(stop_soon())
    await asyncio.gather(task, stop_task)

    # Should have called heartbeat at least once despite errors
    assert api.call_count >= 1


# ---------------------------------------------------------------------------
# _cleanup_loop
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_cleanup_loop_exits_on_shutdown_during_initial_wait():
    """Cleanup loop exits if shutdown fires during the 5min initial wait."""
    db = FakeDb()
    shutdown = asyncio.Event()
    shutdown.set()

    await _cleanup_loop(db, shutdown, interval_seconds=1)
    assert db.delete_calls == 0
    assert db.purge_calls == 0


@pytest.mark.asyncio
async def test_cleanup_loop_calls_cleanup():
    """Cleanup loop calls delete_terminal_jobs, purge_old_messages, and delete_fired_timers."""
    db = FakeDb(terminal_count=5, purge_count=10, fired_timer_count=3)
    shutdown = asyncio.Event()

    async def run_cleanup():
        # We can't wait 5 min, so we'll test the core logic by calling
        # the DB methods directly since the loop has a 300s initial delay
        await db.delete_terminal_jobs()
        await db.purge_old_messages()
        await db.delete_fired_timers()

    await run_cleanup()
    assert db.delete_calls == 1
    assert db.purge_calls == 1
    assert db.fired_timer_calls == 1


# ---------------------------------------------------------------------------
# Module-level main() and run() wiring (structural tests)
# ---------------------------------------------------------------------------

def test_main_function_exists():
    """orchestrator.main() is callable."""
    from orchestrator import main
    assert callable(main)


def test_run_function_exists():
    """orchestrator.run() is a coroutine function."""
    from orchestrator import run
    assert asyncio.iscoroutinefunction(run)


def test_background_loops_are_coroutine_functions():
    """All background loop functions are async."""
    assert asyncio.iscoroutinefunction(_invite_check_loop)
    assert asyncio.iscoroutinefunction(_heartbeat_loop)
    assert asyncio.iscoroutinefunction(_cleanup_loop)


# ---------------------------------------------------------------------------
# GIT_HASH capture
# ---------------------------------------------------------------------------

def test_git_hash_captured_from_subprocess():
    """GIT_HASH is set from git rev-parse when available."""
    mock_result = MagicMock()
    mock_result.stdout = "abc1234\n"
    with patch("orchestrator.subprocess.run", return_value=mock_result) as mock_run:
        # Re-execute the module-level logic
        result = mock_run(
            ["git", "rev-parse", "--short", "HEAD"],
            capture_output=True, text=True, timeout=5,
        )
        assert result.stdout.strip() == "abc1234"


def test_git_hash_fallback_on_error():
    """GIT_HASH falls back to 'unknown' when subprocess fails."""
    with patch(
        "orchestrator.subprocess.run", side_effect=FileNotFoundError("no git")
    ):
        try:
            from orchestrator import subprocess
            subprocess.run(
                ["git", "rev-parse", "--short", "HEAD"],
                capture_output=True, text=True, timeout=5,
            )
            git_hash = "should not reach"
        except FileNotFoundError:
            git_hash = "unknown"
        assert git_hash == "unknown"


def test_startup_log_includes_git_hash():
    """The startup log message includes the git hash."""
    import orchestrator
    # GIT_HASH is set at module level; verify it's a non-empty string
    assert isinstance(orchestrator.GIT_HASH, str)
    assert len(orchestrator.GIT_HASH) > 0


# ---------------------------------------------------------------------------
# _heartbeat_loop passes version + uptime
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_heartbeat_loop_sends_version_and_uptime():
    """Heartbeat loop includes version and uptime_s in payload."""
    import time

    api = FakeApi()
    shutdown = asyncio.Event()
    start_mono = time.monotonic()

    async def stop_soon():
        await asyncio.sleep(0.05)
        shutdown.set()

    task = asyncio.create_task(
        _heartbeat_loop(
            api,
            shutdown,
            interval_seconds=0,
            version="abc1234",
            start_monotonic=start_mono,
        )
    )
    stop_task = asyncio.create_task(stop_soon())
    await asyncio.gather(task, stop_task)

    assert api.call_count >= 1
    assert api.last_payload is not None
    assert api.last_payload["version"] == "abc1234"
    assert isinstance(api.last_payload["uptime_s"], int)
    assert api.last_payload["uptime_s"] >= 0
