"""Inbound push notification handler for the orchestrator.

The VPS sends NIP-17 DMs containing JSON payloads for events like
jobs_ready, payment_received, payment_expired, and new_user.
This module parses those payloads and dispatches to Session,
JobManager, and ApiClient as appropriate.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Awaitable, Callable

import messages
from api_client import ApiClient
from config import Config
from job_manager import JobManager
from session import Session

log = logging.getLogger(__name__)


def parse_push(message: str) -> dict | None:
    """Try to parse a push notification JSON from the VPS bot.

    Expected format: {"type": "...", "data": {...}, "timestamp": ...}
    Returns the parsed dict or None if not valid JSON or missing required fields.
    """
    try:
        payload = json.loads(message)
    except (json.JSONDecodeError, TypeError):
        return None
    if not isinstance(payload, dict):
        return None
    if "type" not in payload or "data" not in payload:
        return None
    return payload


class NotificationHandler:
    """Processes inbound push notifications from the VPS bot."""

    def __init__(
        self,
        session: Session,
        job_manager: JobManager,
        api: ApiClient,
        config: Config,
        send_dm: Callable[[str, str], Awaitable[None]],
        send_operator_dm: Callable[[str], Awaitable[None]],
    ) -> None:
        self._session = session
        self._job_manager = job_manager
        self._api = api
        self._config = config
        self._send_dm = send_dm
        self._send_operator_dm = send_operator_dm

    async def handle_push(self, message: str) -> None:
        """Parse and dispatch a push notification from the VPS bot.

        Routes by type:
        - jobs_ready: trigger poll_and_claim
        - payment_received: call session.handle_payment_received
        - payment_expired: call session.handle_payment_expired
        - new_user: DM operator, send invite DMs
        """
        payload = parse_push(message)
        if payload is None:
            log.warning("Ignoring non-JSON message from VPS bot: %s", message[:120])
            return

        notif_type = payload.get("type")
        data = payload.get("data", {})
        log.info("[push] Received type=%s data=%s", notif_type, data)

        if notif_type == "jobs_ready":
            await self._handle_jobs_ready(data)
        elif notif_type == "payment_received":
            await self._handle_payment_received(data)
        elif notif_type == "payment_expired":
            await self._handle_payment_expired(data)
        elif notif_type == "new_user":
            await self._handle_new_user(data)
        else:
            log.warning("[push] Unknown push notification type: %s", notif_type)

    async def _handle_jobs_ready(self, data: dict) -> None:
        """VPS signals new pending jobs. Trigger poll_and_claim."""
        job_ids = data.get("job_ids", [])
        log.info("[push] jobs_ready: %d job ID(s) signaled, polling VPS...", len(job_ids))
        claimed = await self._job_manager.poll_and_claim()
        log.info("[push] jobs_ready: claimed %d job(s) from VPS", len(claimed))

    async def _handle_payment_received(self, data: dict) -> None:
        """Payment received for a job. Forward to session.

        data: { npub_hex, service_name, amount_sats, job_id? }

        The VPS push payload may or may not include job_id.
        If job_id is present, use it directly.
        If not, log a warning (the BTCPay webhook handles payment tracking
        on the VPS side, so this is a notification, not the source of truth).
        """
        job_id = data.get("job_id")
        amount_sats = data.get("amount_sats", 3000)

        if job_id:
            await self._session.handle_payment_received(job_id, amount_sats)
        else:
            npub_hex = data.get("npub_hex")
            log.warning(
                "payment_received push without job_id for %s",
                npub_hex[:16] if npub_hex else "unknown",
            )

    async def _handle_payment_expired(self, data: dict) -> None:
        """Invoice expired, debt recorded. Forward to session.

        data: { npub_hex, service_name, debt_sats, job_id? }
        """
        job_id = data.get("job_id")

        if job_id:
            await self._session.handle_payment_expired(job_id)
        else:
            npub_hex = data.get("npub_hex")
            log.warning(
                "payment_expired push without job_id for %s",
                npub_hex[:16] if npub_hex else "unknown",
            )

    async def _handle_new_user(self, data: dict) -> None:
        """New user registered. DM operator, send pending invite DMs."""
        npub = data.get("npub", "unknown")
        await self._send_operator_dm(f"New user registered: {npub[:16]}...")

        # Send any pending invite DMs
        await self.send_pending_invite_dms()

    async def send_pending_invite_dms(self) -> int:
        """Send invite DMs to waitlist entries marked as pending.

        Returns count of DMs sent.
        Called on new_user push and periodically.
        """
        pending = await self._api.get_pending_invite_dms()
        count = 0
        for entry in pending:
            npub = entry.get("nostr_npub")
            if not npub:
                continue
            text = messages.invite_dm(self._config.base_url)
            try:
                await self._send_dm(npub, text)
                await self._api.mark_invite_dm_sent(entry["id"])
                count += 1
            except Exception:
                log.exception("Failed to send invite DM to %s", npub[:16])
        return count
