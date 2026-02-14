"""Kind 9735 zap receipt processing → credit topup.

Validates zap receipts per NIP-57 before crediting:
  1. 9735 author must be the configured LNURL provider's nostr pubkey
  2. bolt11 description_hash must equal SHA-256 of the description tag (binds invoice to 9734)
  3. Embedded 9734 zap request must have a valid signature
  4. 9734 must be kind 9734
  5. 9734 must have a 'p' tag matching the bot's pubkey (zap was for us)
  6. If 9734 has an 'amount' tag, it must match the bolt11 amount
"""

import hashlib
import json
import logging

import bolt11 as bolt11_lib
from nostr_sdk import Event as NostrEvent

import db

log = logging.getLogger(__name__)


async def handle_zap_receipt(
    event,
    send_dm,
    bot_pubkey_hex: str,
    zap_provider_pubkey_hex: str,
) -> None:
    """Parse and validate a kind 9735 zap receipt, then credit the sender.

    Args:
        event: nostr_sdk.Event (kind 9735)
        send_dm: async callable(pubkey_hex: str, text: str) to DM the sender
        bot_pubkey_hex: hex pubkey of this bot (zap recipient)
        zap_provider_pubkey_hex: hex pubkey of the LNURL/Lightning provider
            that signs legitimate zap receipts
    """
    event_id = event.id().to_hex()

    # ── CHECK 1: 9735 must be signed by our LNURL provider ──────
    receipt_author = event.author().to_hex()
    if receipt_author != zap_provider_pubkey_hex:
        log.warning(
            "Zap receipt %s: author %s does not match provider %s — rejected",
            event_id, receipt_author[:16], zap_provider_pubkey_hex[:16],
        )
        return

    # ── Extract tags ─────────────────────────────────────────────
    bolt11_str = None
    description_json = None
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

    # ── Decode bolt11 invoice ────────────────────────────────────
    try:
        invoice = bolt11_lib.decode(bolt11_str)
    except Exception:
        log.warning("Zap receipt %s: failed to decode bolt11", event_id)
        return

    amount_msats = invoice.amount_msat
    if not amount_msats or amount_msats <= 0:
        log.warning("Zap receipt %s: zero or missing amount", event_id)
        return
    amount_sats = amount_msats // 1000

    # ── CHECK 2: bolt11 description_hash must match SHA-256 of description tag ──
    # NIP-57 requires the invoice use description_hash (BOLT-11 'h' tag), not
    # description ('d' tag). This binds the payment to the exact 9734 zap request.
    expected_hash = hashlib.sha256(description_json.encode("utf-8")).hexdigest()
    if not invoice.description_hash:
        log.warning("Zap receipt %s: bolt11 missing description_hash (not a valid zap invoice)", event_id)
        return
    if invoice.description_hash != expected_hash:
        log.warning("Zap receipt %s: bolt11 description_hash mismatch", event_id)
        return

    # ── CHECK 3: Parse 9734 and verify its signature ────────────────
    # Event.from_json() only parses — it does NOT verify the signature.
    # We must call verify() explicitly to confirm the 9734 was actually
    # signed by the claimed pubkey.
    try:
        zap_request_event = NostrEvent.from_json(description_json)
    except Exception:
        log.warning("Zap receipt %s: embedded 9734 is not a valid nostr event", event_id)
        return

    if not zap_request_event.verify():
        log.warning("Zap receipt %s: embedded 9734 failed signature verification", event_id)
        return

    # ── CHECK 4: Must be kind 9734 ──────────────────────────────
    if zap_request_event.kind().as_u16() != 9734:
        log.warning(
            "Zap receipt %s: embedded event is kind %d, expected 9734",
            event_id, zap_request_event.kind().as_u16(),
        )
        return

    # ── CHECK 5: 9734 'p' tag must reference our bot pubkey ─────
    p_tags = []
    for tag in zap_request_event.tags().to_vec():
        tag_vec = tag.as_vec()
        if len(tag_vec) >= 2 and tag_vec[0] == "p":
            p_tags.append(tag_vec[1])

    if bot_pubkey_hex not in p_tags:
        log.warning(
            "Zap receipt %s: 9734 p-tags %s do not include bot pubkey %s — rejected",
            event_id, p_tags, bot_pubkey_hex[:16],
        )
        return

    # ── CHECK 6: If 9734 has 'amount' tag, it must match bolt11 ─
    for tag in zap_request_event.tags().to_vec():
        tag_vec = tag.as_vec()
        if len(tag_vec) >= 2 and tag_vec[0] == "amount":
            try:
                requested_msats = int(tag_vec[1])
                if requested_msats != amount_msats:
                    log.warning(
                        "Zap receipt %s: amount mismatch — 9734 says %d msats, bolt11 says %d msats",
                        event_id, requested_msats, amount_msats,
                    )
                    return
            except ValueError:
                log.warning("Zap receipt %s: malformed amount tag in 9734", event_id)
                return
            break

    # ── All checks passed — identify sender and credit ───────────
    sender_hex = zap_request_event.author().to_hex()

    user = await db.get_user_by_npub(sender_hex)
    if user is None:
        log.info("Zap from unregistered npub %s (%d sats) — ignoring", sender_hex[:16], amount_sats)
        try:
            await send_dm(sender_hex, "Not signed up. Join the waitlist at unsaltedbutter.ai")
        except Exception:
            log.debug("Could not DM unregistered zapper %s", sender_hex[:16])
        return

    # Credit the account (idempotent)
    new_balance = await db.credit_zap(event_id, user["id"], sender_hex, amount_sats)

    if new_balance is None:
        log.info("Zap receipt %s already processed (idempotent skip)", event_id)
        return

    log.info("Credited %d sats to user %s (new balance: %d)", amount_sats, str(user["id"])[:8], new_balance)

    try:
        await send_dm(
            sender_hex,
            f"Received {amount_sats:,} sats. New balance: {new_balance:,} sats.",
        )
    except Exception:
        log.warning("Failed to send zap confirmation DM to %s", sender_hex[:16])
