"""Per-user conversation state machine.

One session per user max. Manages transitions through the states:
IDLE, OTP_CONFIRM, EXECUTING, AWAITING_OTP, AWAITING_CREDENTIAL, INVOICE_SENT.
"""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable

import messages
from agent_client import AgentClient
from api_client import ApiClient
from config import Config
from credential_crypto import CredentialDecryptor
from db import Database
from timers import TimerQueue, OTP_TIMEOUT, PAYMENT_EXPIRY

log = logging.getLogger(__name__)

# Valid session states
IDLE = "IDLE"
OTP_CONFIRM = "OTP_CONFIRM"
EXECUTING = "EXECUTING"
AWAITING_OTP = "AWAITING_OTP"
AWAITING_CREDENTIAL = "AWAITING_CREDENTIAL"
INVOICE_SENT = "INVOICE_SENT"


class Session:
    """Per-user conversation state machine."""

    def __init__(
        self,
        db: Database,
        api: ApiClient,
        agent: AgentClient,
        timers: TimerQueue,
        config: Config,
        send_dm: Callable[[str, str], Awaitable[None]],
        send_operator_dm: Callable[[str], Awaitable[None]],
        credential_decryptor: CredentialDecryptor | None = None,
    ) -> None:
        self._db = db
        self._api = api
        self._agent = agent
        self._timers = timers
        self._config = config
        self._send_dm = send_dm
        self._send_operator_dm = send_operator_dm
        self._credential_decryptor = credential_decryptor
        # In-memory tracking for pending credential requests (keyed by user_npub)
        self._pending_credentials: dict[str, str] = {}

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    async def _get_session_by_job_id(self, job_id: str) -> dict | None:
        """Find a session row by its job_id. Queries SQLite directly."""
        cursor = await self._db._db.execute(
            "SELECT * FROM sessions WHERE job_id = ?", (job_id,)
        )
        row = await cursor.fetchone()
        return dict(row) if row else None

    async def _fail_job(
        self,
        user_npub: str,
        job: dict,
        error: str | None,
        error_code: str | None = None,
    ) -> None:
        """Common failure handling: update statuses, DM user/operator, delete session.

        The user gets a failure message (differentiated by error_code).
        The operator gets the full error via DM. The error is also logged.
        """
        job_id = job["id"]
        service_id = job["service_id"]
        action = job["action"]

        if error:
            log.error("Job %s (%s %s) failed: %s", job_id, action, service_id, error)

        # Update VPS and local job status to failed
        # CLI-dispatched jobs don't exist on the VPS, skip remote update
        if not job_id.startswith("cli-"):
            log.info("_fail_job: updating VPS status -> failed for %s", job_id[:8])
            try:
                await self._api.update_job_status(job_id, "failed")
            except Exception:
                log.exception("Failed to update VPS job status for %s", job_id)
        await self._db.update_job_status(job_id, "failed")

        # DM the user (differentiated by error_code)
        if error_code == "credential_invalid":
            dm = messages.action_failed_credentials(service_id, action)
        else:
            dm = messages.action_failed(service_id, action)
        await self._send_dm(user_npub, dm)

        # Notify operator (skip for CLI jobs, operator sees the error directly)
        if not job_id.startswith("cli-"):
            await self._send_operator_dm(
                messages.operator_job_failed(job_id, service_id, error)
            )
            # Send npub in a separate bubble for easy copy
            await self._send_operator_dm(user_npub)

        # Clean up session
        await self._db.delete_session(user_npub)

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    async def get_state(self, user_npub: str) -> str:
        """Return current session state for user, or 'IDLE' if no session."""
        session = await self._db.get_session(user_npub)
        if session is None:
            return IDLE
        return session["state"]

    async def get_current_job(self, user_npub: str) -> dict | None:
        """Return the job associated with the user's active session, or None."""
        session = await self._db.get_session(user_npub)
        if session is None or not session.get("job_id"):
            return None
        return await self._db.get_job(session["job_id"])

    async def is_busy(self, user_npub: str) -> bool:
        """Check if user has an active (non-IDLE) session."""
        state = await self.get_state(user_npub)
        return state != IDLE

    async def handle_yes(self, user_npub: str, job_id: str) -> None:
        """User says yes to outreach. Go straight to EXECUTING (OTP warning is in outreach)."""
        log.info("handle_yes: user=%s job=%s", user_npub[:16], job_id[:8])
        job = await self._db.get_job(job_id)
        if job is None:
            log.error("handle_yes: job %s not found in local DB", job_id)
            await self._send_dm(user_npub, messages.error_generic())
            return

        service_id = job["service_id"]
        action = job["action"]
        log.info("handle_yes: %s %s, local status=%s", action, service_id, job.get("status"))

        # Fetch sealed credentials from VPS API
        sealed = await self._api.get_credentials(user_npub, service_id)
        if sealed is None:
            await self._send_dm(
                user_npub,
                messages.no_credentials(service_id, self._config.base_url),
            )
            return

        # Decrypt sealed blobs locally
        if self._credential_decryptor is None:
            log.error("handle_yes: credential_decryptor not configured")
            await self._send_dm(user_npub, messages.error_generic())
            return
        creds = self._credential_decryptor.decrypt_credentials(sealed)

        # Create session in EXECUTING state
        await self._db.upsert_session(
            user_npub, EXECUTING, job_id=job_id, otp_attempts=0
        )

        # DM user
        await self._send_dm(
            user_npub, messages.executing(service_id, action)
        )

        # Update VPS job status to active (abort if VPS rejects the transition,
        # e.g. job was already skipped/failed on the website)
        try:
            await self._api.update_job_status(job_id, "active")
            log.info("handle_yes: VPS status -> active for %s", job_id[:8])
        except Exception:
            log.exception("VPS rejected status -> active for %s, aborting", job_id)
            await self._send_dm(user_npub, messages.error_generic())
            await self._db.delete_session(user_npub)
            return

        # Update local job status to active
        await self._db.update_job_status(job_id, "active")

        # Map to agent convention
        agent_creds = {
            'email': creds['email'],
            'pass': creds['password'],
        }

        # Dispatch to agent
        plan_id = job.get("plan_id")
        plan_display_name = job.get("plan_display_name")
        log.info("handle_yes: dispatching to agent, job=%s plan=%s display=%s", job_id[:8], plan_id, plan_display_name)
        accepted = await self._agent.execute(
            job_id, service_id, action, agent_creds,
            plan_id=plan_id, plan_display_name=plan_display_name,
            user_npub=user_npub,
        )
        if not accepted:
            await self._fail_job(user_npub, job, "Agent rejected the job")
            return

        log.info("handle_yes: agent accepted job %s", job_id[:8])
        # Schedule OTP timeout timer
        await self._timers.schedule_delay(
            OTP_TIMEOUT, job_id, self._config.otp_timeout_seconds
        )

    async def handle_otp_confirm_yes(self, user_npub: str) -> None:
        """User confirms OTP availability. Transition OTP_CONFIRM -> EXECUTING."""
        session = await self._db.get_session(user_npub)
        if session is None or session["state"] != OTP_CONFIRM:
            log.warning(
                "handle_otp_confirm_yes: unexpected state for %s", user_npub
            )
            return

        job_id = session["job_id"]
        job = await self._db.get_job(job_id)
        if job is None:
            log.error("handle_otp_confirm_yes: job %s not found", job_id)
            await self._send_dm(user_npub, messages.error_generic())
            await self._db.delete_session(user_npub)
            return

        service_id = job["service_id"]
        action = job["action"]

        # Fetch sealed credentials from VPS API
        sealed = await self._api.get_credentials(user_npub, service_id)
        if sealed is None:
            await self._send_dm(
                user_npub,
                messages.no_credentials(service_id, self._config.base_url),
            )
            await self._db.delete_session(user_npub)
            return

        # Decrypt sealed blobs locally
        if self._credential_decryptor is None:
            log.error("handle_otp_confirm_yes: credential_decryptor not configured")
            await self._send_dm(user_npub, messages.error_generic())
            await self._db.delete_session(user_npub)
            return
        creds = self._credential_decryptor.decrypt_credentials(sealed)

        # Update session state to EXECUTING
        await self._db.upsert_session(
            user_npub, EXECUTING, job_id=job_id, otp_attempts=0
        )

        # DM user
        await self._send_dm(
            user_npub, messages.executing(service_id, action)
        )

        # Update VPS job status to active (abort if VPS rejects)
        try:
            await self._api.update_job_status(job_id, "active")
        except Exception:
            log.exception("VPS rejected status -> active for %s, aborting", job_id)
            await self._send_dm(user_npub, messages.error_generic())
            await self._db.delete_session(user_npub)
            return

        # Update local job status to active
        await self._db.update_job_status(job_id, "active")

        # Map to agent convention
        agent_creds = {
            'email': creds['email'],
            'pass': creds['password'],
        }

        # Dispatch to agent
        plan_id = job.get("plan_id")
        plan_display_name = job.get("plan_display_name")
        accepted = await self._agent.execute(
            job_id, service_id, action, agent_creds,
            plan_id=plan_id, plan_display_name=plan_display_name,
            user_npub=user_npub,
        )
        if not accepted:
            await self._fail_job(user_npub, job, "Agent rejected the job")
            return

        # Schedule OTP timeout timer
        await self._timers.schedule_delay(
            OTP_TIMEOUT, job_id, self._config.otp_timeout_seconds
        )

    async def handle_otp_confirm_no(self, user_npub: str) -> None:
        """User declines OTP confirm. Cancel session."""
        await self._db.delete_session(user_npub)
        await self._send_dm(user_npub, messages.session_cancelled())

    async def handle_otp_needed(
        self, job_id: str, service: str, prompt: str | None
    ) -> None:
        """Agent callback: needs OTP code. EXECUTING -> AWAITING_OTP."""
        session = await self._get_session_by_job_id(job_id)
        if session is None:
            log.warning("handle_otp_needed: no session for job %s", job_id)
            return

        user_npub = session["user_npub"]
        otp_attempts = session["otp_attempts"]

        # Update state to AWAITING_OTP
        await self._db.upsert_session(
            user_npub, AWAITING_OTP, job_id=job_id, otp_attempts=otp_attempts
        )

        # DM user for OTP code
        await self._send_dm(
            user_npub, messages.otp_needed(service, prompt)
        )

        # Cancel any existing OTP timeout, schedule fresh one
        await self._timers.cancel(OTP_TIMEOUT, job_id)
        await self._timers.schedule_delay(
            OTP_TIMEOUT, job_id, self._config.otp_timeout_seconds
        )

    async def handle_otp_input(self, user_npub: str, code: str) -> None:
        """User sends OTP digits. AWAITING_OTP -> EXECUTING."""
        session = await self._db.get_session(user_npub)
        if session is None or session["state"] != AWAITING_OTP:
            log.warning(
                "handle_otp_input: unexpected state for %s", user_npub
            )
            return

        job_id = session["job_id"]
        otp_attempts = session["otp_attempts"] + 1

        # Relay code to agent (in memory only, never persisted)
        await self._agent.relay_otp(job_id, code)

        # Update state to EXECUTING
        await self._db.upsert_session(
            user_npub, EXECUTING, job_id=job_id, otp_attempts=otp_attempts
        )

        # Cancel OTP timeout timer
        await self._timers.cancel(OTP_TIMEOUT, job_id)

        # DM acknowledgement
        await self._send_dm(user_npub, messages.otp_received())

        # NOTE: No explicit log_message here. The inbound message was already
        # logged by nostr_handler with automatic OTP redaction (see db.py).

    async def handle_credential_needed(
        self, job_id: str, service: str, credential_name: str,
    ) -> None:
        """Agent callback: needs a credential. EXECUTING -> AWAITING_CREDENTIAL."""
        session = await self._get_session_by_job_id(job_id)
        if session is None:
            log.warning("handle_credential_needed: no session for job %s", job_id)
            return

        user_npub = session["user_npub"]

        # Track which credential we're waiting for
        self._pending_credentials[user_npub] = credential_name

        # Update state to AWAITING_CREDENTIAL
        await self._db.upsert_session(
            user_npub, AWAITING_CREDENTIAL, job_id=job_id,
            otp_attempts=session["otp_attempts"],
        )

        # DM user for credential
        await self._send_dm(
            user_npub, messages.credential_needed(service, credential_name)
        )

        # Reset timeout timer (reuse OTP timeout)
        await self._timers.cancel(OTP_TIMEOUT, job_id)
        await self._timers.schedule_delay(
            OTP_TIMEOUT, job_id, self._config.otp_timeout_seconds
        )

    async def handle_credential_input(
        self, user_npub: str, value: str,
    ) -> None:
        """User sends a credential value. AWAITING_CREDENTIAL -> EXECUTING."""
        session = await self._db.get_session(user_npub)
        if session is None or session["state"] != AWAITING_CREDENTIAL:
            log.warning(
                "handle_credential_input: unexpected state for %s", user_npub
            )
            return

        job_id = session["job_id"]
        credential_name = self._pending_credentials.pop(user_npub, "unknown")

        # Relay value to agent
        await self._agent.relay_credential(job_id, credential_name, value)

        # Update state to EXECUTING
        await self._db.upsert_session(
            user_npub, EXECUTING, job_id=job_id,
            otp_attempts=session["otp_attempts"],
        )

        # Cancel timeout timer
        await self._timers.cancel(OTP_TIMEOUT, job_id)

        # DM acknowledgement
        await self._send_dm(user_npub, messages.credential_received())

    async def handle_result(
        self,
        job_id: str,
        success: bool,
        access_end_date: str | None,
        error: str | None,
        duration_seconds: int,
        error_code: str | None = None,
        stats: dict | None = None,
    ) -> None:
        """Agent callback: job finished. EXECUTING/AWAITING_OTP/AWAITING_CREDENTIAL -> INVOICE_SENT or IDLE."""
        log.info(
            "handle_result: job=%s success=%s duration=%ds error=%s",
            job_id[:8], success, duration_seconds, error,
        )
        session = await self._get_session_by_job_id(job_id)
        if session is None:
            log.warning("handle_result: no session for job %s", job_id)
            return

        user_npub = session["user_npub"]
        log.info("handle_result: user=%s state=%s", user_npub[:16], session["state"])

        # Cancel OTP timeout timer (may or may not exist)
        await self._timers.cancel(OTP_TIMEOUT, job_id)

        job = await self._db.get_job(job_id)
        if job is None:
            log.error("handle_result: job %s not found in local DB", job_id)
            await self._db.delete_session(user_npub)
            return

        service_id = job["service_id"]
        action = job["action"]

        if success:
            # Send success DM (different per action type)
            if action == "cancel":
                await self._send_dm(
                    user_npub,
                    messages.action_success_cancel(service_id, access_end_date),
                )
            else:
                await self._send_dm(
                    user_npub,
                    messages.action_success_resume(service_id),
                )

            # CLI jobs: no VPS job exists, skip invoice and clean up
            if job_id.startswith("cli-"):
                log.info("CLI job %s succeeded", job_id)
                await self._db.update_job_status(job_id, "completed")
                await self._db.delete_session(user_npub)
            else:
                # Update local job with access_end_date if present
                update_kwargs = {}
                if access_end_date:
                    update_kwargs["access_end_date"] = access_end_date

                # Create invoice via VPS API (also sets access_end_date)
                invoice_data = await self._api.create_invoice(
                    job_id, self._config.action_price_sats, user_npub,
                    access_end_date=access_end_date,
                )

                # Update local job with invoice_id and amount
                await self._db.update_job_status(
                    job_id,
                    "active",
                    invoice_id=invoice_data["invoice_id"],
                    amount_sats=self._config.action_price_sats,
                    **update_kwargs,
                )

                # Send invoice DMs (two separate messages for easy copy)
                for part in messages.invoice(
                    invoice_data["amount_sats"], invoice_data["bolt11"]
                ):
                    await self._send_dm(user_npub, part)

                # Transition session to INVOICE_SENT
                await self._db.upsert_session(
                    user_npub, INVOICE_SENT, job_id=job_id
                )

                # Schedule payment expiry timer (24h)
                await self._timers.schedule_delay(
                    PAYMENT_EXPIRY, job_id, self._config.payment_expiry_seconds
                )
        else:
            await self._fail_job(user_npub, job, error, error_code=error_code)

        # Write action log to VPS (fire-and-forget, must not block user flow)
        if not job_id.startswith("cli-"):
            try:
                log_payload = {
                    "success": success,
                    "duration_seconds": duration_seconds,
                    "error_code": error_code,
                    "error_message": error,
                }
                if stats:
                    log_payload.update(stats)
                await self._api.write_action_log(job_id, log_payload)
            except Exception:
                log.warning("Failed to write action log for job %s", job_id[:8])

    async def handle_payment_received(
        self, job_id: str, amount_sats: int
    ) -> None:
        """VPS push: payment received. INVOICE_SENT -> IDLE."""
        session = await self._get_session_by_job_id(job_id)
        if session is None:
            log.warning(
                "handle_payment_received: no session for job %s", job_id
            )
            return

        user_npub = session["user_npub"]

        # Cancel payment expiry timer
        await self._timers.cancel(PAYMENT_EXPIRY, job_id)

        # VPS already set completed_paid via BTCPay webhook, but update local
        await self._db.update_job_status(job_id, "completed_paid")

        # DM user
        await self._send_dm(
            user_npub, messages.payment_received(amount_sats)
        )

        # Delete session (back to IDLE)
        await self._db.delete_session(user_npub)

    async def handle_payment_expired(self, job_id: str) -> None:
        """Timer or VPS push: payment expired. INVOICE_SENT -> IDLE."""
        session = await self._get_session_by_job_id(job_id)
        if session is None:
            log.warning(
                "handle_payment_expired: no session for job %s", job_id
            )
            return

        user_npub = session["user_npub"]

        # Update VPS job status to completed_reneged
        try:
            await self._api.update_job_status(job_id, "completed_reneged")
        except Exception:
            log.exception(
                "Failed to update VPS job status for %s", job_id
            )

        # Update local job status
        await self._db.update_job_status(job_id, "completed_reneged")

        # Look up debt_sats from VPS user
        job = await self._db.get_job(job_id)
        service_id = job["service_id"] if job else "unknown"

        user_data = await self._api.get_user(user_npub)
        debt_sats = user_data.get("debt_sats", 0) if user_data else 0

        # DM user
        await self._send_dm(
            user_npub,
            messages.payment_expired(service_id, debt_sats),
        )

        # Delete session
        await self._db.delete_session(user_npub)

    async def handle_otp_timeout(self, job_id: str) -> None:
        """Timer: OTP not received in 15min. AWAITING_OTP -> IDLE."""
        session = await self._get_session_by_job_id(job_id)
        if session is None:
            log.warning(
                "handle_otp_timeout: no session for job %s", job_id
            )
            return

        user_npub = session["user_npub"]

        if session["state"] not in (AWAITING_OTP, AWAITING_CREDENTIAL):
            log.warning(
                "handle_otp_timeout: session for %s is %s, not AWAITING_OTP/AWAITING_CREDENTIAL",
                user_npub, session["state"],
            )
            return

        # Abort the agent job
        await self._agent.abort(job_id)

        # Update VPS job status to user_abandon
        try:
            await self._api.update_job_status(job_id, "user_abandon")
        except Exception:
            log.exception(
                "Failed to update VPS job status for %s", job_id
            )

        # Update local job status
        await self._db.update_job_status(job_id, "user_abandon")

        # DM user
        await self._send_dm(user_npub, messages.otp_timeout())

        # Delete session
        await self._db.delete_session(user_npub)

    async def handle_cli_dispatch(
        self,
        user_npub: str,
        service: str,
        action: str,
        credentials: dict,
        plan_id: str,
        job_id: str,
        plan_display_name: str = "",
    ) -> None:
        """CLI dispatch: create session and send job to agent.

        Skips the OTP confirm flow (CLI user is already at the terminal).
        """
        # Create session in EXECUTING state
        await self._db.upsert_session(
            user_npub, EXECUTING, job_id=job_id, otp_attempts=0
        )

        # Insert a local job record so callbacks can find it
        from datetime import datetime, timezone

        await self._db.upsert_job({
            "id": job_id,
            "user_npub": user_npub,
            "service_id": service,
            "action": action,
            "trigger": "cli",
            "status": "active",
            "created_at": datetime.now(timezone.utc).isoformat(),
        })

        # Dispatch to agent
        accepted = await self._agent.execute(
            job_id, service, action, credentials,
            plan_id=plan_id, plan_display_name=plan_display_name or None,
            user_npub=user_npub,
        )
        if not accepted:
            log.error("Agent rejected CLI job %s", job_id)
            await self._db.delete_session(user_npub)
            return

        # Schedule OTP timeout (covers credential waits too)
        await self._timers.schedule_delay(
            OTP_TIMEOUT, job_id, self._config.otp_timeout_seconds
        )

    async def cancel_session(self, user_npub: str) -> None:
        """Force-cancel a session (e.g., user sends 'cancel' mid-flow)."""
        session = await self._db.get_session(user_npub)
        if session is None:
            return

        job_id = session["job_id"]
        state = session["state"]

        # If EXECUTING, AWAITING_OTP, or AWAITING_CREDENTIAL, abort the agent job
        if state in (EXECUTING, AWAITING_OTP, AWAITING_CREDENTIAL) and job_id:
            await self._agent.abort(job_id)

        # Cancel all timers for the job
        if job_id:
            await self._timers.cancel(OTP_TIMEOUT, job_id)
            await self._timers.cancel(PAYMENT_EXPIRY, job_id)

        # Delete session
        await self._db.delete_session(user_npub)
