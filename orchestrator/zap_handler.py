"""Kind 9735 zap receipt processing for job invoice payments.

Validates zap receipts per NIP-57 before confirming payment:
  1. 9735 author must be the configured LNURL provider's nostr pubkey
  2. bolt11 description_hash must equal SHA-256 of the description tag
  3. Embedded 9734 zap request must have a valid signature
  4. 9734 must be kind 9734
  5. 9734 'p' tag must reference the bot's pubkey (zap was for us)
  6. If 9734 has 'amount' tag, it must match the bolt11 amount
"""

from __future__ import annotations

import hashlib
import json
import logging
from typing import TYPE_CHECKING, Callable, Awaitable

import bolt11 as bolt11_lib
from nostr_sdk import Event as NostrEvent

if TYPE_CHECKING:
    from api_client import ApiClient

log = logging.getLogger(__name__)


async def handle_zap_receipt(
    event: NostrEvent,
    send_dm: Callable[[str, str], Awaitable[None]],
    bot_pubkey_hex: str,
    zap_provider_pubkey_hex: str,
    api_client: ApiClient,
) -> None:
    """Parse and validate a kind 9735 zap receipt, then confirm job payment.

    Args:
        event: nostr_sdk.Event (kind 9735)
        send_dm: async callable(pubkey_hex: str, text: str) to DM someone
        bot_pubkey_hex: hex pubkey of this bot (zap recipient)
        zap_provider_pubkey_hex: hex pubkey of the LNURL/Lightning provider
        api_client: ApiClient instance for VPS API calls
    """
    event_id: str = event.id().to_hex()

    # -- CHECK 1: 9735 must be signed by our LNURL provider --
    receipt_author: str = event.author().to_hex()
    if receipt_author != zap_provider_pubkey_hex:
        log.warning(
            "Zap receipt %s: author %s does not match provider %s, rejected",
            event_id, receipt_author[:16], zap_provider_pubkey_hex[:16],
        )
        return

    # -- Extract tags --
    bolt11_str: str | None = None
    description_json: str | None = None
    for tag in event.tags().to_vec():
        tag_vec = tag.as_vec()
        if len(tag_vec) >= 2:
            if tag_vec[0] == "bolt11":
                bolt11_str = tag_vec[1]
            elif tag_vec[0] == "description":
                description_json = tag_vec[1]

    if not bolt11_str or not description_json:
        log.warning("Zap receipt %s missing bolt11 or description tag", event_id)
        return

    # -- Decode bolt11 invoice --
    try:
        invoice = bolt11_lib.decode(bolt11_str)
    except Exception:
        log.warning("Zap receipt %s: failed to decode bolt11", event_id)
        return

    amount_msats: int | None = invoice.amount_msat
    if not amount_msats or amount_msats <= 0:
        log.warning("Zap receipt %s: zero or missing amount", event_id)
        return
    amount_sats: int = amount_msats // 1000

    # -- CHECK 2: bolt11 description_hash must match SHA-256 of description tag --
    expected_hash: str = hashlib.sha256(description_json.encode("utf-8")).hexdigest()
    if not invoice.description_hash:
        log.warning("Zap receipt %s: bolt11 missing description_hash (not a valid zap invoice)", event_id)
        return
    if invoice.description_hash != expected_hash:
        log.warning("Zap receipt %s: bolt11 description_hash mismatch", event_id)
        return

    # -- CHECK 3: Parse 9734 and verify its signature --
    try:
        zap_request_event = NostrEvent.from_json(description_json)
    except Exception:
        log.warning("Zap receipt %s: embedded 9734 is not a valid nostr event", event_id)
        return

    if not zap_request_event.verify():
        log.warning("Zap receipt %s: embedded 9734 failed signature verification", event_id)
        return

    # -- CHECK 4: Must be kind 9734 --
    if zap_request_event.kind().as_u16() != 9734:
        log.warning(
            "Zap receipt %s: embedded event is kind %d, expected 9734",
            event_id, zap_request_event.kind().as_u16(),
        )
        return

    # -- CHECK 5: 9734 'p' tag must reference our bot pubkey --
    p_tags: list[str] = []
    for tag in zap_request_event.tags().to_vec():
        tag_vec = tag.as_vec()
        if len(tag_vec) >= 2 and tag_vec[0] == "p":
            p_tags.append(tag_vec[1])

    if bot_pubkey_hex not in p_tags:
        log.warning(
            "Zap receipt %s: 9734 p-tags %s do not include bot pubkey %s, rejected",
            event_id, p_tags, bot_pubkey_hex[:16],
        )
        return

    # -- CHECK 6: If 9734 has 'amount' tag, it must match bolt11 --
    for tag in zap_request_event.tags().to_vec():
        tag_vec = tag.as_vec()
        if len(tag_vec) >= 2 and tag_vec[0] == "amount":
            try:
                requested_msats: int = int(tag_vec[1])
                if requested_msats != amount_msats:
                    log.warning(
                        "Zap receipt %s: amount mismatch, 9734 says %d msats, bolt11 says %d msats",
                        event_id, requested_msats, amount_msats,
                    )
                    return
            except ValueError:
                log.warning("Zap receipt %s: malformed amount tag in 9734", event_id)
                return
            break

    # -- All checks passed, identify sender --
    sender_hex: str = zap_request_event.author().to_hex()

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
