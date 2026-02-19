"""Persistent timer queue backed by SQLite.

Timers survive process restarts. The tick loop checks every
config.timer_tick_seconds for due timers and dispatches callbacks.
"""

from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timezone, timedelta

from db import Database

log = logging.getLogger(__name__)

# Timer type constants
OUTREACH = "outreach"
LAST_CHANCE = "last_chance"
OTP_TIMEOUT = "otp_timeout"
IMPLIED_SKIP = "implied_skip"
PAYMENT_EXPIRY = "payment_expiry"


class TimerQueue:
    def __init__(self, db: Database, tick_seconds: int = 60):
        self._db = db
        self._tick_seconds = tick_seconds
        self._callback = None  # async callable(timer_type, target_id, payload)
        self._task: asyncio.Task | None = None
        self._stop_event = asyncio.Event()

    def set_callback(self, callback) -> None:
        """Set the callback for fired timers.

        callback signature: async def handler(timer_type: str, target_id: str, payload: dict | None)
        """
        self._callback = callback

    async def schedule(
        self,
        timer_type: str,
        target_id: str,
        fire_at: datetime,
        payload: dict | None = None,
    ) -> int:
        """Schedule a timer. Returns the timer ID.

        fire_at must be timezone-aware (UTC).
        payload is optional JSON-serializable dict.
        """
        fire_at_str = fire_at.isoformat()
        payload_str = json.dumps(payload) if payload else None
        timer_id = await self._db.add_timer(timer_type, target_id, fire_at_str, payload_str)
        log.debug("Scheduled timer %d: %s for %s at %s", timer_id, timer_type, target_id, fire_at_str)
        return timer_id

    async def schedule_delay(
        self,
        timer_type: str,
        target_id: str,
        delay_seconds: int,
        payload: dict | None = None,
    ) -> int:
        """Schedule a timer relative to now. Convenience wrapper."""
        fire_at = datetime.now(timezone.utc) + timedelta(seconds=delay_seconds)
        return await self.schedule(timer_type, target_id, fire_at, payload)

    async def cancel(self, timer_type: str, target_id: str) -> int:
        """Cancel all unfired timers matching type+target. Returns count cancelled."""
        count = await self._db.cancel_timers(timer_type, target_id)
        if count > 0:
            log.debug("Cancelled %d %s timers for %s", count, timer_type, target_id)
        return count

    async def tick(self) -> int:
        """Process due timers once. Returns count of timers fired.

        Called automatically by the run loop, but can be called manually for testing.
        """
        now = datetime.now(timezone.utc).isoformat()
        due = await self._db.get_due_timers(now)

        fired = 0
        for timer in due:
            await self._db.mark_timer_fired(timer["id"])
            fired += 1

            if self._callback:
                payload = json.loads(timer["payload"]) if timer["payload"] else None
                try:
                    await self._callback(timer["timer_type"], timer["target_id"], payload)
                except Exception:
                    log.exception(
                        "Timer callback failed: %s for %s",
                        timer["timer_type"], timer["target_id"],
                    )

        return fired

    async def start(self) -> None:
        """Start the background tick loop."""
        self._stop_event.clear()
        self._task = asyncio.create_task(self._run_loop())

    async def stop(self) -> None:
        """Stop the background tick loop."""
        self._stop_event.set()
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None

    async def _run_loop(self) -> None:
        """Background loop: tick every N seconds."""
        while not self._stop_event.is_set():
            try:
                count = await self.tick()
                if count > 0:
                    log.info("Fired %d timer(s)", count)
            except Exception:
                log.exception("Timer tick error")

            try:
                await asyncio.wait_for(
                    self._stop_event.wait(),
                    timeout=self._tick_seconds,
                )
                break  # stop_event was set
            except asyncio.TimeoutError:
                pass  # normal: timeout means time to tick again
