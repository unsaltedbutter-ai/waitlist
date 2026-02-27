"""DM command routing for the orchestrator.

Routes inbound user DM text through the session state machine and
job manager. All replies are sent via the send_dm callback (not returned).
"""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable

import messages
from api_client import ApiClient
from config import Config
from job_manager import JobManager
from session import (
    Session, IDLE, OTP_CONFIRM, AWAITING_OTP, AWAITING_CREDENTIAL,
    EXECUTING, INVOICE_SENT,
)

log = logging.getLogger(__name__)

# Valid service aliases (lowercase) -> service_id
SERVICE_ALIASES: dict[str, str] = {
    "netflix": "netflix",
    "hulu": "hulu",
    "disney": "disney_plus",
    "disney +": "disney_plus",
    "disney+": "disney_plus",
    "disney plus": "disney_plus",
    "disneyplus": "disney_plus",
    "paramount": "paramount",
    "paramount +": "paramount",
    "paramount+": "paramount",
    "paramount plus": "paramount",
    "paramountplus": "paramount",
    "paramount": "paramount",
    "peacock": "peacock",
    "max": "max",
    "hbo": "max",
    "hbo max": "max",
}


def parse_service(service_input: str) -> str | None:
    """Parse a service name from user input. Returns service_id or None."""
    return SERVICE_ALIASES.get(service_input.strip().lower())


class CommandRouter:
    """Routes user DM text to the appropriate handler."""

    def __init__(
        self,
        api: ApiClient,
        session: Session,
        job_manager: JobManager,
        config: Config,
        send_dm: Callable[[str, str], Awaitable[None]],
    ) -> None:
        self._api = api
        self._session = session
        self._job_manager = job_manager
        self._config = config
        self._send_dm = send_dm
        self._operator_pubkey = config.operator_pubkey

    async def handle_dm(self, sender_npub: str, text: str) -> None:
        """Process an inbound DM from a user.

        Checks session state first to route stateful interactions,
        then falls through to IDLE command parsing.
        """
        normalized = text.strip()
        lower = normalized.lower()

        state = await self._session.get_state(sender_npub)

        # AWAITING_OTP: relay digits or tell user we're busy
        if state == AWAITING_OTP:
            if self._is_otp_like(normalized):
                stripped = normalized.replace(" ", "").replace("-", "")
                await self._session.handle_otp_input(sender_npub, stripped)
            else:
                await self._send_dm(sender_npub, messages.busy())
            return

        # AWAITING_CREDENTIAL: forward user's reply as credential value
        if state == AWAITING_CREDENTIAL:
            if normalized:
                await self._session.handle_credential_input(
                    sender_npub, normalized,
                )
            else:
                await self._send_dm(sender_npub, messages.busy())
            return

        # OTP_CONFIRM: user confirming or declining OTP availability
        if state == OTP_CONFIRM:
            if lower in ("yes", "y"):
                job = await self._job_manager.get_active_job_for_user(sender_npub)
                if job:
                    await self._job_manager.request_dispatch(
                        sender_npub, job["id"]
                    )
                else:
                    # Fallback: check session directly for the job_id
                    await self._session.handle_otp_confirm_yes(sender_npub)
            elif lower in ("no", "cancel", "n"):
                await self._session.handle_otp_confirm_no(sender_npub)
            else:
                await self._send_dm(sender_npub, messages.busy())
            return

        # EXECUTING or INVOICE_SENT: user is in a non-interactive wait state
        if state in (EXECUTING, INVOICE_SENT):
            await self._send_dm(sender_npub, messages.busy())
            return

        # IDLE: parse command
        await self._handle_idle_command(sender_npub, normalized)

    async def _handle_idle_command(self, sender_npub: str, text: str) -> None:
        """Handle a command when user is in IDLE state."""
        lower = text.lower()

        if lower in ("yes", "y"):
            await self._cmd_yes(sender_npub)
        elif lower == "skip":
            await self._cmd_skip(sender_npub)
        elif lower == "snooze":
            await self._cmd_snooze(sender_npub)
        elif lower.startswith("cancel "):
            await self._cmd_action(sender_npub, text[7:], "cancel")
        elif lower.startswith("resume "):
            await self._cmd_action(sender_npub, text[7:], "resume")
        elif lower == "status":
            await self._cmd_status(sender_npub)
        elif lower == "queue":
            await self._cmd_queue(sender_npub)
        elif lower == "help":
            await self._send_dm(sender_npub, messages.help_text())
        elif lower == "login":
            await self._cmd_login(sender_npub)
        elif lower == "waitlist":
            await self._cmd_waitlist(sender_npub)
        elif lower == "invites":
            await self._cmd_invites(sender_npub)
        else:
            await self._send_dm(sender_npub, messages.help_text())

    # ------------------------------------------------------------------
    # Command handlers
    # ------------------------------------------------------------------

    async def _cmd_yes(self, sender_npub: str) -> None:
        """User says 'yes' to outreach. Find active job and start session."""
        job = await self._job_manager.get_active_job_for_user(sender_npub)
        if job is None:
            await self._send_dm(sender_npub, messages.help_text())
            return
        await self._session.handle_yes(sender_npub, job["id"])

    async def _cmd_skip(self, sender_npub: str) -> None:
        """User says 'skip' to outreach."""
        job = await self._job_manager.get_active_job_for_user(sender_npub)
        if job is None:
            await self._send_dm(sender_npub, messages.help_text())
            return
        await self._job_manager.handle_skip(sender_npub, job["id"])

    async def _cmd_snooze(self, sender_npub: str) -> None:
        """User says 'snooze' to outreach."""
        job = await self._job_manager.get_active_job_for_user(sender_npub)
        if job is None:
            await self._send_dm(sender_npub, messages.help_text())
            return
        await self._job_manager.handle_snooze(sender_npub, job["id"])

    async def _cmd_action(
        self, sender_npub: str, service_input: str, action: str
    ) -> None:
        """Handle cancel/resume commands by creating an on-demand job."""
        service_id = parse_service(service_input)
        if service_id is None:
            await self._send_dm(
                sender_npub, messages.unknown_service(service_input.strip())
            )
            return

        # Check if user exists and has debt
        user_data = await self._api.get_user(sender_npub)
        if user_data is None:
            # Unregistered user: auto-waitlist
            await self._auto_waitlist(sender_npub)
            return

        debt_sats = user_data.get("debt_sats", 0)
        if debt_sats > 0:
            await self._send_dm(sender_npub, messages.debt_block(debt_sats))
            return

        try:
            result = await self._api.create_on_demand_job(
                sender_npub, service_id, action
            )
        except Exception:
            log.exception(
                "API call failed for %s %s (user %s)",
                action, service_id, sender_npub,
            )
            await self._send_dm(sender_npub, messages.error_generic())
            return

        status_code = result["status_code"]
        data = result["data"]

        if status_code == 200:
            queue_pos = data.get("queue_position", 1)
            if queue_pos <= 1:
                await self._send_dm(
                    sender_npub,
                    messages.action_starting(service_id, action),
                )
            else:
                await self._send_dm(
                    sender_npub,
                    messages.queued(service_id, action, queue_pos),
                )
            # Immediately try to claim so the user doesn't wait for the
            # next VPS push or heartbeat cycle.
            await self._job_manager.poll_and_claim()
        elif status_code == 403:
            debt = data.get("debt_sats", 0)
            await self._send_dm(sender_npub, messages.debt_block(debt))
        elif status_code == 409:
            display = messages.display_name(service_id)
            await self._send_dm(
                sender_npub,
                f"There's already a pending job for {display}. Check your status.",
            )
        elif status_code == 400:
            error_msg = data.get("error", "")
            if "credentials" in error_msg.lower():
                await self._send_dm(
                    sender_npub,
                    messages.no_credentials(service_id, self._config.base_url),
                )
            else:
                log.warning(
                    "API 400 for %s %s (user %s): %s",
                    action, service_id, sender_npub, error_msg,
                )
                await self._send_dm(sender_npub, messages.error_generic())
        elif status_code == 404:
            await self._send_dm(
                sender_npub,
                messages.not_registered(self._config.base_url),
            )
        else:
            log.warning(
                "Unexpected API response %d for %s %s: %s",
                status_code, action, service_id, data,
            )
            await self._send_dm(sender_npub, messages.error_generic())

    async def _cmd_status(self, sender_npub: str) -> None:
        """Show user's active jobs, queue, and debt."""
        try:
            user_data = await self._api.get_user(sender_npub)
        except Exception:
            log.exception("API call failed for status (user %s)", sender_npub)
            await self._send_dm(sender_npub, messages.error_generic())
            return

        if user_data is None:
            await self._auto_waitlist(sender_npub)
            return

        user = user_data.get("user", user_data)
        active_jobs = user_data.get("active_jobs", [])
        queue = user_data.get("queue", [])

        lines = []

        debt = user.get("debt_sats", 0)
        if debt > 0:
            lines.append(f"Outstanding balance: {debt:,} sats")

        if active_jobs:
            for job in active_jobs:
                svc = messages.display_name(job["service_id"])
                lines.append(f"{svc} {job['action']}: {job['status']}")
        else:
            lines.append("No active jobs")

        if queue:
            q_str = ", ".join(
                messages.display_name(q["service_id"]) for q in queue
            )
            lines.append(f"Queue: {q_str}")

        await self._send_dm(sender_npub, "\n".join(lines))

    async def _cmd_queue(self, sender_npub: str) -> None:
        """Show user's rotation queue order."""
        try:
            user_data = await self._api.get_user(sender_npub)
        except Exception:
            log.exception("API call failed for queue (user %s)", sender_npub)
            await self._send_dm(sender_npub, messages.error_generic())
            return

        if user_data is None:
            await self._auto_waitlist(sender_npub)
            return

        queue = user_data.get("queue", [])
        if not queue:
            await self._send_dm(sender_npub, "Your queue is empty.")
            return

        lines = []
        for item in queue:
            display = messages.display_name(item["service_id"])
            lines.append(f"{item['position']}. {display}")
        await self._send_dm(sender_npub, "\n".join(lines))

    async def _cmd_login(self, sender_npub: str) -> None:
        """Generate OTP login code and send as two DMs."""
        user_data = await self._api.get_user(sender_npub)

        if user_data is None:
            # Auto-invite and send login code
            await self._auto_waitlist(sender_npub)
            return

        try:
            code = await self._api.create_otp(sender_npub)
        except Exception:
            log.exception("OTP creation failed for user %s", sender_npub)
            await self._send_dm(sender_npub, messages.error_generic())
            return

        parts = messages.login_code(code, self._config.base_url)
        for part in parts:
            await self._send_dm(sender_npub, part)

    async def _cmd_waitlist(self, sender_npub: str) -> None:
        """Add to waitlist or return appropriate status."""
        # Check if already registered
        user_data = await self._api.get_user(sender_npub)
        if user_data is not None:
            await self._send_dm(sender_npub, messages.already_has_account())
            return

        try:
            result = await self._api.add_to_waitlist(sender_npub)
        except Exception:
            log.exception("Waitlist API failed for user %s", sender_npub)
            await self._send_dm(sender_npub, messages.error_generic())
            return

        status = result.get("status", "")
        if status == "added":
            await self._send_dm(sender_npub, messages.waitlist_added())
        elif status == "already_waitlisted":
            await self._send_dm(sender_npub, messages.waitlist_already())
        elif status == "already_invited":
            await self._send_dm(
                sender_npub,
                messages.waitlist_invited(self._config.base_url),
            )
        else:
            await self._send_dm(sender_npub, messages.error_generic())

    async def _cmd_invites(self, sender_npub: str) -> None:
        """Operator only: send pending invite DMs."""
        if not self._is_operator(sender_npub):
            await self._send_dm(sender_npub, messages.help_text())
            return

        try:
            pending = await self._api.get_pending_invite_dms()
        except Exception:
            log.exception("Failed to get pending invite DMs")
            await self._send_dm(sender_npub, messages.error_generic())
            return

        if not pending:
            await self._send_dm(sender_npub, "No pending invites.")
            return

        sent_count = 0
        for invite in pending:
            invitee_npub = invite["npub_hex"]
            try:
                await self._send_dm(
                    invitee_npub,
                    messages.invite_dm(self._config.base_url),
                )
                await self._api.mark_invite_dm_sent(invite["id"])
                sent_count += 1
            except Exception:
                log.exception(
                    "Failed to send invite DM to %s", invitee_npub
                )

        await self._send_dm(sender_npub, f"Sent {sent_count} invite(s).")

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    async def _auto_waitlist(self, sender_npub: str) -> None:
        """Auto-invite unregistered user and send login code."""
        try:
            result = await self._api.auto_invite(sender_npub)
        except Exception:
            log.exception(
                "Auto-invite failed for user %s", sender_npub
            )
            await self._send_dm(
                sender_npub,
                messages.not_registered(self._config.base_url),
            )
            return

        status = result.get("status", "")
        if status in ("invited", "already_invited"):
            # Send login code
            try:
                code = await self._api.create_otp(sender_npub)
                parts = messages.login_code(code, self._config.base_url)
                for part in parts:
                    await self._send_dm(sender_npub, part)
            except Exception:
                log.exception("OTP creation failed for auto-invited user %s", sender_npub)
                await self._send_dm(
                    sender_npub,
                    messages.invite_dm(self._config.base_url),
                )
        elif status == "at_capacity":
            await self._send_dm(sender_npub, messages.waitlist_added())
        else:
            await self._send_dm(
                sender_npub,
                messages.not_registered(self._config.base_url),
            )

    def _is_otp_like(self, text: str) -> bool:
        """Check if text looks like an OTP or CVV code (3-8 digits, with optional spaces/dashes)."""
        stripped = text.replace(" ", "").replace("-", "")
        return stripped.isdigit() and 3 <= len(stripped) <= 8

    def _is_operator(self, sender_hex: str) -> bool:
        """Check if the user is the operator. Both sides are hex."""
        return sender_hex == self._operator_pubkey
