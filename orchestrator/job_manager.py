"""Job lifecycle management for the orchestrator.

Polls the VPS for pending jobs, claims them, manages outreach cadence
(DMs to users asking them to confirm cancel/resume), handles snooze/skip
responses, manages a parallel dispatch queue for agent slots, and
processes timer callbacks.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone, timedelta

import messages
from api_client import ApiClient
from config import Config
from db import Database
from session import Session
from timers import (
    TimerQueue,
    OUTREACH,
    LAST_CHANCE,
    OTP_TIMEOUT,
    IMPLIED_SKIP,
    PAYMENT_EXPIRY,
)

log = logging.getLogger(__name__)

# Statuses considered terminal (job is done, no further action).
_TERMINAL_STATUSES = frozenset({
    "completed_paid",
    "completed_eventual",
    "completed_reneged",
    "user_skip",
    "user_abandon",
    "implied_skip",
    "failed",
})

# Statuses that represent an active outreach (user hasn't committed yet).
_OUTREACH_STATUSES = frozenset({
    "dispatched",
    "outreach_sent",
    "snoozed",
})


class JobManager:
    """Job lifecycle: poll, claim, outreach, dispatch, timer callbacks."""

    def __init__(
        self,
        db: Database,
        api: ApiClient,
        session: Session,
        timers: TimerQueue,
        config: Config,
        send_dm,  # Callable[[str, str], Awaitable[None]]
    ) -> None:
        self._db = db
        self._api = api
        self._session = session
        self._timers = timers
        self._config = config
        self._send_dm = send_dm
        self._dispatch_queue: list[str] = []  # job IDs waiting for an agent slot
        self._active_agent_jobs: set[str] = set()  # job IDs currently on the agent
        self._immediate_jobs: set[str] = set()  # on-demand jobs that skip outreach
        # Lock protecting _dispatch_queue and _active_agent_jobs. Without this,
        # two concurrent request_dispatch calls could both see a slot available,
        # both add to _active_agent_jobs, and exceed max_concurrent_agent_jobs.
        self._dispatch_lock = asyncio.Lock()

    # ------------------------------------------------------------------
    # Polling + claiming
    # ------------------------------------------------------------------

    async def poll_and_claim(self) -> list[dict]:
        """Fetch pending jobs from VPS, claim them, cache locally.

        Returns list of claimed job dicts.
        Steps:
        1. GET /api/agent/jobs/pending
        2. POST /api/agent/jobs/claim with all job IDs
        3. Claimed jobs: upsert into local DB with status 'dispatched'
        4. Send outreach DM for each claimed job
        5. Return claimed jobs
        """
        pending = await self._api.get_pending_jobs()
        if not pending:
            return []

        job_ids = [j["id"] for j in pending]
        result = await self._api.claim_jobs(job_ids)
        claimed_ids = {j["id"] for j in result.get("claimed", [])}

        if not claimed_ids:
            return []

        # Build a lookup from pending list
        jobs_by_id = {j["id"]: j for j in pending}
        claimed_jobs = []

        for job_id in claimed_ids:
            job = jobs_by_id.get(job_id)
            if job is None:
                continue

            # Upsert with dispatched status
            job["status"] = "dispatched"
            await self._db.upsert_job(job)
            claimed_jobs.append(job)

        # Send outreach for each claimed job
        for job in claimed_jobs:
            await self.send_outreach(job["id"])

        return claimed_jobs

    def mark_immediate(self, job_id: str) -> None:
        """Flag an on-demand job to skip outreach and dispatch immediately."""
        self._immediate_jobs.add(job_id)

    # ------------------------------------------------------------------
    # Outreach
    # ------------------------------------------------------------------

    async def send_outreach(self, job_id: str) -> None:
        """Send outreach DM for a job.

        Checks user busy state and debt before sending. Selects the
        appropriate message template based on action and outreach count.
        """
        # On-demand immediate: skip outreach, dispatch directly
        if job_id in self._immediate_jobs:
            self._immediate_jobs.discard(job_id)
            job = await self._db.get_job(job_id)
            if job:
                log.info(
                    "send_outreach: immediate dispatch for job %s, "
                    "skipping outreach",
                    job_id,
                )
                await self._session.handle_yes(job["user_npub"], job_id)
            return

        job = await self._db.get_job(job_id)
        if job is None:
            log.warning("send_outreach: job %s not found locally", job_id)
            return

        user_npub = job["user_npub"]
        service_id = job["service_id"]
        action = job["action"]
        outreach_count = job.get("outreach_count", 0)

        # Check if user is busy (has an active session)
        if await self._session.is_busy(user_npub):
            log.info(
                "send_outreach: user %s is busy, skipping job %s",
                user_npub, job_id,
            )
            return

        # Check if user has debt
        user_data = await self._api.get_user(user_npub)
        debt_sats = user_data.get("debt_sats", 0) if user_data else 0
        if debt_sats > 0:
            await self._send_dm(user_npub, messages.debt_block(debt_sats))
            return

        # Build the outreach message
        if outreach_count == 0:
            if action == "cancel":
                billing_date = job.get("billing_date")
                if billing_date:
                    msg = messages.outreach_cancel(service_id, billing_date)
                else:
                    msg = messages.outreach_cancel_no_date(service_id)
            else:
                msg = messages.outreach_resume(service_id)
        else:
            msg = messages.outreach_followup(service_id)

        await self._send_dm(user_npub, msg)

        # Update outreach count and next_outreach_at
        new_count = outreach_count + 1
        next_outreach_at = (
            datetime.now(timezone.utc)
            + timedelta(seconds=self._config.outreach_interval_seconds)
        ).isoformat()

        # Update VPS
        try:
            await self._api.update_job_status(
                job_id,
                "outreach_sent",
                outreach_count=new_count,
                next_outreach_at=next_outreach_at,
            )
        except Exception:
            log.exception("Failed to update VPS for job %s", job_id)

        # Update local DB
        await self._db.update_job_status(
            job_id,
            "outreach_sent",
            outreach_count=new_count,
            next_outreach_at=next_outreach_at,
        )

        # Schedule outreach followup timer (48h)
        await self._timers.schedule_delay(
            OUTREACH,
            job_id,
            self._config.outreach_interval_seconds,
        )

        # Schedule implied_skip timer at billing_date (if known)
        billing_date = job.get("billing_date")
        if billing_date:
            try:
                bd = datetime.fromisoformat(billing_date)
                if bd.tzinfo is None:
                    bd = bd.replace(tzinfo=timezone.utc)
                if bd > datetime.now(timezone.utc):
                    await self._timers.schedule(IMPLIED_SKIP, job_id, bd)
            except (ValueError, TypeError):
                log.warning(
                    "Could not parse billing_date %s for job %s",
                    billing_date, job_id,
                )

    async def handle_skip(self, user_npub: str, job_id: str) -> None:
        """User says 'skip' to outreach. Mark user_skip, stay IDLE."""
        job = await self._db.get_job(job_id)
        if job is None:
            return

        # Cancel outreach and implied_skip timers
        await self._timers.cancel(OUTREACH, job_id)
        await self._timers.cancel(IMPLIED_SKIP, job_id)
        await self._timers.cancel(LAST_CHANCE, job_id)

        # Update VPS
        try:
            await self._api.update_job_status(job_id, "user_skip")
        except Exception:
            log.exception("Failed to update VPS for skip on job %s", job_id)

        # Update local DB
        await self._db.update_job_status(job_id, "user_skip")

        # DM acknowledgement
        await self._send_dm(
            user_npub, messages.user_skip_ack(job["service_id"])
        )

    async def handle_snooze(self, user_npub: str, job_id: str) -> None:
        """User says 'snooze' to outreach. Schedule re-ping in 48h."""
        job = await self._db.get_job(job_id)
        if job is None:
            return

        # Cancel current outreach timer
        await self._timers.cancel(OUTREACH, job_id)

        next_outreach_at = (
            datetime.now(timezone.utc)
            + timedelta(seconds=self._config.outreach_interval_seconds)
        ).isoformat()

        # Update VPS
        try:
            await self._api.update_job_status(
                job_id, "snoozed", next_outreach_at=next_outreach_at
            )
        except Exception:
            log.exception("Failed to update VPS for snooze on job %s", job_id)

        # Update local DB
        await self._db.update_job_status(
            job_id, "snoozed", next_outreach_at=next_outreach_at
        )

        # DM acknowledgement
        await self._send_dm(user_npub, messages.user_snooze_ack())

        # Schedule outreach timer for 48h
        await self._timers.schedule_delay(
            OUTREACH,
            job_id,
            self._config.outreach_interval_seconds,
        )

    # ------------------------------------------------------------------
    # Dispatch queue
    # ------------------------------------------------------------------

    def agent_slot_available(self) -> bool:
        """Check if there's an open agent slot."""
        return len(self._active_agent_jobs) < self._config.max_concurrent_agent_jobs

    async def request_dispatch(self, user_npub: str, job_id: str) -> None:
        """User confirmed OTP availability. Try to dispatch or queue.

        Called instead of session.handle_otp_confirm_yes directly.
        If an agent slot is available, dispatch immediately.
        If not, add to the dispatch queue and DM the user.

        Thread-safe: acquires _dispatch_lock to prevent two concurrent
        callers from both seeing a slot available and double-dispatching.
        """
        async with self._dispatch_lock:
            if self.agent_slot_available():
                self._active_agent_jobs.add(job_id)
                await self._session.handle_otp_confirm_yes(user_npub)
            else:
                self._dispatch_queue.append(job_id)
                job = await self._db.get_job(job_id)
                if job:
                    await self._send_dm(
                        user_npub,
                        messages.queued(job["service_id"], job["action"]),
                    )

    async def try_dispatch_next(self) -> bool:
        """If there's an open agent slot and queued jobs, dispatch the next one.

        Returns True if a job was dispatched, False otherwise.

        Thread-safe: acquires _dispatch_lock to prevent races between
        slot checks and active job set mutations.
        """
        async with self._dispatch_lock:
            return await self._try_dispatch_next_unlocked()

    async def _try_dispatch_next_unlocked(self) -> bool:
        """Internal dispatch logic. Caller must hold _dispatch_lock."""
        if not self.agent_slot_available():
            return False

        while self._dispatch_queue:
            job_id = self._dispatch_queue.pop(0)

            # Verify job still exists and find the user
            job = await self._db.get_job(job_id)
            if job is None:
                # Job disappeared, skip to next queued job
                continue

            user_npub = job["user_npub"]
            self._active_agent_jobs.add(job_id)
            await self._session.handle_otp_confirm_yes(user_npub)
            return True

        return False

    async def on_job_complete(self, job_id: str) -> None:
        """Called when a job finishes (success or failure). Free the agent slot.

        Removes the job from active_agent_jobs and tries to dispatch the
        next queued job.

        Thread-safe: acquires _dispatch_lock to prevent races.
        """
        async with self._dispatch_lock:
            self._active_agent_jobs.discard(job_id)
            await self._try_dispatch_next_unlocked()

    # ------------------------------------------------------------------
    # Timer callbacks
    # ------------------------------------------------------------------

    async def handle_timer(
        self, timer_type: str, target_id: str, payload: dict | None
    ) -> None:
        """Process a fired timer. Called by TimerQueue.

        Routes to the appropriate handler based on timer_type.
        """
        if timer_type == OUTREACH:
            await self.handle_outreach_timer(target_id)
        elif timer_type == LAST_CHANCE:
            await self.handle_last_chance(target_id)
        elif timer_type == OTP_TIMEOUT:
            await self._session.handle_otp_timeout(target_id)
        elif timer_type == IMPLIED_SKIP:
            await self.handle_implied_skip(target_id)
        elif timer_type == PAYMENT_EXPIRY:
            await self._session.handle_payment_expired(target_id)
        else:
            log.warning("Unknown timer type: %s", timer_type)

    async def handle_outreach_timer(self, job_id: str) -> None:
        """Outreach timer fired. Re-ping the user."""
        job = await self._db.get_job(job_id)
        if job is None:
            return

        # If job reached a terminal status, ignore
        if job["status"] in _TERMINAL_STATUSES:
            return

        user_npub = job["user_npub"]

        # If user is busy, reschedule
        if await self._session.is_busy(user_npub):
            await self._timers.schedule_delay(
                OUTREACH,
                job_id,
                self._config.outreach_interval_seconds,
            )
            return

        # Send followup outreach
        await self.send_outreach(job_id)

    async def handle_last_chance(self, job_id: str) -> None:
        """Last chance timer fired. Send last-chance DM."""
        job = await self._db.get_job(job_id)
        if job is None:
            return

        # If terminal, skip
        if job["status"] in _TERMINAL_STATUSES:
            return

        user_npub = job["user_npub"]

        # If user is busy, skip (no reschedule for last chance)
        if await self._session.is_busy(user_npub):
            return

        # Calculate days left from billing_date
        billing_date = job.get("billing_date")
        if not billing_date:
            return

        try:
            bd = datetime.fromisoformat(billing_date)
            if bd.tzinfo is None:
                bd = bd.replace(tzinfo=timezone.utc)
            days_left = (bd - datetime.now(timezone.utc)).days
        except (ValueError, TypeError):
            return

        if days_left < 0:
            return

        await self._send_dm(
            user_npub,
            messages.last_chance(job["service_id"], days_left),
        )

    async def handle_implied_skip(self, job_id: str) -> None:
        """Billing date reached without action. Mark implied_skip."""
        job = await self._db.get_job(job_id)
        if job is None:
            return

        # If already terminal, skip
        if job["status"] in _TERMINAL_STATUSES:
            return

        # Update VPS
        try:
            await self._api.update_job_status(job_id, "implied_skip")
        except Exception:
            log.exception(
                "Failed to update VPS for implied_skip on job %s", job_id
            )

        # Update local DB
        await self._db.update_job_status(job_id, "implied_skip")

        # Cancel outreach timers
        await self._timers.cancel(OUTREACH, job_id)
        await self._timers.cancel(LAST_CHANCE, job_id)

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    async def get_active_job_for_user(self, user_npub: str) -> dict | None:
        """Get the most relevant active (non-terminal) job for a user.

        Used when a user says "yes"/"skip"/"snooze" and we need to find
        which job they're responding to.
        Returns the first job with an outreach-eligible status, or None.
        """
        jobs = await self._db.get_jobs_for_user(user_npub)
        for job in jobs:
            if job["status"] in _OUTREACH_STATUSES:
                return job
        return None

    async def reconcile_cancelled_jobs(self, cancelled: list[dict]) -> int:
        """Clean up jobs the VPS reports as terminal. Returns count reconciled."""
        count = 0
        for entry in cancelled:
            job_id = entry.get("id")
            vps_status = entry.get("status")
            if not job_id or not vps_status:
                continue

            local_job = await self._db.get_job(job_id)
            if local_job is None:
                continue
            if local_job["status"] in _TERMINAL_STATUSES:
                continue

            # Cancel all timer types for this job
            for timer_type in (OUTREACH, LAST_CHANCE, IMPLIED_SKIP, OTP_TIMEOUT, PAYMENT_EXPIRY):
                await self._timers.cancel(timer_type, job_id)

            # Delete session if linked to this job
            user_npub = local_job["user_npub"]
            session = await self._db.get_session(user_npub)
            if session and session.get("job_id") == job_id:
                await self._db.delete_session(user_npub)

            # Remove from dispatch queue and active set
            if job_id in self._dispatch_queue:
                self._dispatch_queue.remove(job_id)
            self._active_agent_jobs.discard(job_id)

            # Update local DB to match VPS terminal status
            await self._db.update_job_status(job_id, vps_status)

            log.info(
                "Reconciled job %s: local '%s' -> VPS '%s'",
                job_id, local_job["status"], vps_status,
            )
            count += 1

        return count

    async def cleanup_terminal_jobs(self) -> int:
        """Delete locally cached terminal jobs. Called periodically."""
        return await self._db.delete_terminal_jobs()
