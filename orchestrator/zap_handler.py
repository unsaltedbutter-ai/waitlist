"""Kind 9735 zap receipt processing for job invoice payments.

Validates zap receipts per NIP-57 (via shared.zap_verify), then matches
the payment to a payable concierge job.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Callable, Awaitable

from shared.zap_verify import validate_zap_receipt

if TYPE_CHECKING:
    from api_client import ApiClient
    from nostr_sdk import Event as NostrEvent

log = logging.getLogger(__name__)


async def handle_zap_receipt(
    event: "NostrEvent",
    send_dm: Callable[[str, str], Awaitable[None]],
    bot_pubkey_hex: str,
    zap_provider_pubkey_hex: str,
    api_client: "ApiClient",
) -> None:
    """Parse and validate a kind 9735 zap receipt, then confirm job payment.

    Args:
        event: nostr_sdk.Event (kind 9735)
        send_dm: async callable(pubkey_hex: str, text: str) to DM someone
        bot_pubkey_hex: hex pubkey of this bot (zap recipient)
        zap_provider_pubkey_hex: hex pubkey of the LNURL/Lightning provider
        api_client: ApiClient instance for VPS API calls
    """
    zap = validate_zap_receipt(event, bot_pubkey_hex, zap_provider_pubkey_hex)
    if zap is None:
        return

    event_id = zap.event_id
    sender_hex = zap.sender_hex
    amount_sats = zap.amount_sats

    data = await api_client.get_user(sender_hex)
    user = data["user"] if data else None
    if user is None:
        log.info("Zap from unregistered npub %s (%d sats), ignoring", sender_hex[:16], amount_sats)
        try:
            await send_dm(sender_hex, "No account found. Sign up at unsaltedbutter.ai")
        except Exception:
            log.debug("Could not DM unregistered zapper %s", sender_hex[:16])
        return

    # -- Match zap to a payable job --
    job_id = _find_payable_job(data, amount_sats)

    if job_id is None:
        log.info(
            "Zap %s from %s (%d sats), no matching payable job",
            event_id[:16], sender_hex[:16], amount_sats,
        )
        try:
            await send_dm(
                sender_hex,
                f"Received {amount_sats:,} sats but no open invoice was found to apply it to. Contact us if this was for a job.",
            )
        except Exception:
            log.debug("Could not DM zapper %s", sender_hex[:16])
        return

    try:
        result = await api_client.mark_job_paid(job_id, zap_event_id=event_id)
        status_code: int = result["status_code"]
        if status_code == 200:
            log.info("Job %s marked paid via zap %s from %s", job_id[:8], event_id[:16], sender_hex[:16])
            try:
                await send_dm(sender_hex, f"Payment received ({amount_sats:,} sats). Thanks.")
            except Exception:
                log.debug("Could not send payment confirmation DM to %s", sender_hex[:16])
        elif status_code == 409:
            log.info("Job %s already paid (zap %s)", job_id[:8], event_id[:16])
        else:
            log.warning("Failed to mark job %s paid: %d %s", job_id[:8], status_code, result["data"])
            try:
                await send_dm(sender_hex, f"Received {amount_sats:,} sats but couldn't apply it. We'll sort it out.")
            except Exception:
                pass
    except Exception as e:
        log.error("API error marking job %s paid: %s", job_id[:8], e)
        try:
            await send_dm(sender_hex, f"Received {amount_sats:,} sats but hit an error. We'll sort it out.")
        except Exception:
            pass


def _find_payable_job(user_data: dict, amount_sats: int) -> str | None:
    """Find a payable job where the zap covers the invoice.

    Returns the job_id if exactly one active job has an invoice_id and
    the zap amount >= the invoice amount. Returns None if zero or
    multiple match (ambiguous).
    """
    candidates: list[str] = []
    for job in user_data.get("active_jobs", []):
        invoice_amount = job.get("amount_sats")
        if job.get("invoice_id") and invoice_amount and amount_sats >= invoice_amount:
            candidates.append(job["id"])
    if len(candidates) == 1:
        return candidates[0]
    return None
