"""Inbound push notification handling for the concierge model.

The VPS private bot sends DMs to this bot with structured JSON payloads
for events like job completion, payment reminders, etc. This module
parses those payloads and forwards human-readable messages to users.

Push notification types from VPS:
  - job_complete: a job finished, includes invoice bolt11
  - payment_received: user paid an invoice
  - payment_expired: invoice expired, debt recorded
  - new_user: new user registered via waitlist invite
"""

import json
import logging

log = logging.getLogger(__name__)


def parse_push_notification(message: str) -> dict | None:
    """Try to parse a push notification JSON from the VPS private bot.

    Expected format: {"type": "...", "data": {...}}
    Returns the parsed dict or None if not a valid push notification.
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


def format_job_complete(data: dict) -> str | None:
    """Format a job_complete notification for the user.

    data fields: service_name, action, access_end_date (optional), bolt11 (optional)
    """
    service = data.get("service_name", "your service")
    action = data.get("action", "action")
    access_end = data.get("access_end_date")
    bolt11 = data.get("bolt11")

    if action == "cancel":
        msg = f"Your {service} was cancelled."
        if access_end:
            msg += f" You have access until {access_end}."
    elif action == "resume":
        msg = f"Your {service} was resumed."
    else:
        msg = f"Your {service} {action} is done."

    if bolt11:
        msg += f"\n\nInvoice (3,000 sats):\n{bolt11}"

    return msg


def format_payment_received(data: dict) -> str:
    """Format a payment_received notification."""
    service = data.get("service_name", "your service")
    amount = data.get("amount_sats", 3000)
    return f"Payment received ({amount:,} sats) for {service}. Thanks."


def format_payment_expired(data: dict) -> str:
    """Format a payment_expired notification (debt recorded)."""
    service = data.get("service_name", "your service")
    debt = data.get("debt_sats", 0)
    return (
        f"Your invoice for {service} expired. "
        f"Outstanding balance: {debt:,} sats. "
        f"Please pay before requesting new work."
    )


def format_new_user(data: dict) -> str:
    """Format a new_user notification (for the operator)."""
    npub = data.get("npub", "unknown")
    return f"New user registered: {npub[:16]}..."


def format_notification(payload: dict) -> tuple[str | None, str | None]:
    """Format a push notification into (target_npub_hex, message).

    Returns (None, None) if the notification type is unknown or data is invalid.
    """
    notif_type = payload.get("type")
    data = payload.get("data", {})
    target_npub = data.get("npub_hex")

    if notif_type == "job_complete":
        msg = format_job_complete(data)
        return (target_npub, msg)

    elif notif_type == "payment_received":
        msg = format_payment_received(data)
        return (target_npub, msg)

    elif notif_type == "payment_expired":
        msg = format_payment_expired(data)
        return (target_npub, msg)

    elif notif_type == "new_user":
        # This goes to the operator, not the user
        msg = format_new_user(data)
        return (data.get("operator_npub_hex"), msg)

    else:
        log.warning("Unknown push notification type: %s", notif_type)
        return (None, None)
