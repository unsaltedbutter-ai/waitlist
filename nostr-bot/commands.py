"""DM command dispatcher and handlers."""

import logging
from uuid import UUID

import db

log = logging.getLogger(__name__)

HELP_TEXT = (
    "Commands:\n"
    "  login  : get a one-time code to sign in on the website\n"
    "  status : current sub, balance, next service\n"
    "  queue  : full rotation order\n"
    "  skip   : move current service to end of queue\n"
    "  stay   : extend current subscription instead of rotating\n"
    "  help   : this message\n"
    "\n"
    "Zap this bot to add sats to your credit balance."
)


async def handle_dm(user_id: UUID, user_status: str, message: str) -> str:
    """Dispatch a DM command. Returns the reply text."""
    if user_status == "churned":
        return "Your membership has ended."

    cmd = message.strip().lower()

    if cmd == "status":
        return await _cmd_status(user_id)
    elif cmd == "queue":
        return await _cmd_queue(user_id)
    elif cmd == "skip":
        return await _cmd_skip(user_id)
    elif cmd == "stay":
        return await _cmd_stay(user_id)
    elif cmd == "help":
        return HELP_TEXT
    else:
        return HELP_TEXT


async def _cmd_status(user_id: UUID) -> str:
    info = await db.get_user_status(user_id)

    lines = []
    sub = info["subscription"]
    if sub:
        lapse = sub["estimated_lapse_at"]
        lapse_str = lapse.strftime("%b %d") if lapse else "unknown"
        lines.append(f"{sub['display_name']} ({sub['status']}, ends {lapse_str})")
    else:
        lines.append("No active subscription")

    lines.append(f"{info['credit_sats']:,} sats")

    if info["next_service"]:
        lines.append(f"Next: {info['next_service']}")

    return "\n".join(lines)


async def _cmd_queue(user_id: UUID) -> str:
    queue = await db.get_user_queue(user_id)
    if not queue:
        return "Your queue is empty."

    lines = []
    for item in queue:
        status_tag = ""
        if item["sub_status"]:
            status_tag = f" [{item['sub_status']}]"
        lines.append(f"{item['position']}. {item['display_name']}{status_tag}")
    return "\n".join(lines)


async def _cmd_skip(user_id: UUID) -> str:
    service_id = await db.get_active_service_id(user_id)
    if service_id is None:
        return "No active subscription to skip."

    # Get display name from queue for the response
    queue = await db.get_user_queue(user_id)
    name = next(
        (q["display_name"] for q in queue if q["service_id"] == service_id),
        "Current service",
    )

    ok = await db.skip_service(user_id, service_id)
    if not ok:
        return "Could not skip — service not in your queue."
    return f"{name} moved to end of queue."


async def _cmd_stay(user_id: UUID) -> str:
    service_id = await db.get_active_service_id(user_id)
    if service_id is None:
        return "No active subscription to stay on."

    queue = await db.get_user_queue(user_id)
    name = next(
        (q["display_name"] for q in queue if q["service_id"] == service_id),
        "Current service",
    )

    ok = await db.stay_service(user_id, service_id)
    if not ok:
        return "Could not stay — no active subscription found."
    return f"Staying on {name}. We'll renew instead of rotating."
