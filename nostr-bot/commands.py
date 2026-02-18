"""DM command dispatcher and handlers for the pay-per-action concierge model."""

import logging

import api_client

log = logging.getLogger(__name__)

# Valid service aliases (lowercase) -> service_id
SERVICE_ALIASES: dict[str, str] = {
    "netflix": "netflix",
    "hulu": "hulu",
    "disney+": "disney_plus",
    "disney plus": "disney_plus",
    "disneyplus": "disney_plus",
    "prime": "prime_video",
    "prime video": "prime_video",
    "primevideo": "prime_video",
    "amazon": "prime_video",
    "apple tv": "apple_tv_plus",
    "apple tv+": "apple_tv_plus",
    "appletv": "apple_tv_plus",
    "appletv+": "apple_tv_plus",
    "paramount+": "paramount_plus",
    "paramount plus": "paramount_plus",
    "paramountplus": "paramount_plus",
    "paramount": "paramount_plus",
    "peacock": "peacock",
    "espn+": "espn_plus",
    "espn plus": "espn_plus",
    "espn": "espn_plus",
    "max": "max",
    "hbo": "max",
    "hbo max": "max",
}

# Reverse lookup: service_id -> display name
SERVICE_DISPLAY: dict[str, str] = {
    "netflix": "Netflix",
    "hulu": "Hulu",
    "disney_plus": "Disney+",
    "prime_video": "Prime Video",
    "apple_tv_plus": "Apple TV+",
    "paramount_plus": "Paramount+",
    "peacock": "Peacock",
    "espn_plus": "ESPN+",
    "max": "Max",
}

HELP_TEXT = (
    "Commands:\n"
    "  cancel [service]\n  - request a cancel (e.g. cancel netflix)\n"
    "  resume [service]\n  - request a resume (e.g. resume hulu)\n"
    "  status\n  - your active jobs, queue, and debt\n"
    "  queue\n  - your rotation queue order\n"
    "  help\n  - this message\n"
    "\n"
    "3,000 sats per action, billed after completion."
)


def _parse_service(args: str) -> str | None:
    """Parse a service name from user input. Returns service_id or None."""
    normalized = args.strip().lower()
    return SERVICE_ALIASES.get(normalized)


async def handle_dm(npub_hex: str, message: str) -> str:
    """Dispatch a DM command. Returns the reply text."""
    cmd = message.strip().lower()

    # Commands that take a service argument
    if cmd.startswith("cancel "):
        return await _cmd_action(npub_hex, cmd[7:], "cancel")
    elif cmd.startswith("resume "):
        return await _cmd_action(npub_hex, cmd[7:], "resume")
    elif cmd == "status":
        return await _cmd_status(npub_hex)
    elif cmd == "queue":
        return await _cmd_queue(npub_hex)
    elif cmd == "help":
        return HELP_TEXT
    else:
        return HELP_TEXT


async def _cmd_action(npub_hex: str, service_input: str, action: str) -> str:
    """Handle cancel/resume commands by creating an on-demand job via the API."""
    service_id = _parse_service(service_input)
    if service_id is None:
        return f"Unknown service: {service_input.strip()}\nTry: netflix, hulu, disney+, prime video, apple tv+, paramount+, peacock, espn+, max"

    display = SERVICE_DISPLAY.get(service_id, service_id)

    try:
        result = await api_client.create_on_demand_job(npub_hex, service_id, action)
    except Exception as e:
        log.error("API call failed for %s %s: %s", action, service_id, e)
        return "Something went wrong. Try again in a minute."

    status_code = result["status_code"]
    data = result["data"]

    if status_code == 200:
        return f"{display} {action} is queued. I'll let you know when it's done."

    if status_code == 403 and "debt" in str(data.get("error", "")).lower():
        debt = data.get("debt_sats", 0)
        return f"You have an outstanding balance of {debt:,} sats. Please pay before requesting new work."

    if status_code == 409:
        return f"There's already a pending job for {display}. Check your status."

    if status_code == 400:
        error_msg = data.get("error", "")
        if "credentials" in error_msg.lower():
            return f"No credentials on file for {display}. Add them on the website first."
        return f"Could not {action} {display}: {error_msg}"

    if status_code == 404:
        return "Account not found. Sign up at unsaltedbutter.ai"

    # Unexpected status
    log.warning("Unexpected API response %d for %s %s: %s", status_code, action, service_id, data)
    return "Something went wrong. Try again in a minute."


async def _cmd_status(npub_hex: str) -> str:
    """Show user's active jobs, queue position, and debt."""
    try:
        user_data = await api_client.get_user(npub_hex)
    except Exception as e:
        log.error("API call failed for status: %s", e)
        return "Something went wrong. Try again in a minute."

    if user_data is None:
        return "Account not found. Sign up at unsaltedbutter.ai"

    user = user_data["user"]
    active_jobs = user_data.get("active_jobs", [])
    queue = user_data.get("queue", [])

    lines = []

    # Debt warning
    debt = user.get("debt_sats", 0)
    if debt > 0:
        lines.append(f"Outstanding balance: {debt:,} sats")

    # Active jobs
    if active_jobs:
        for job in active_jobs:
            svc = SERVICE_DISPLAY.get(job["service_id"], job["service_id"])
            lines.append(f"{svc} {job['action']}: {job['status']}")
    else:
        lines.append("No active jobs")

    # Queue
    if queue:
        q_str = ", ".join(
            SERVICE_DISPLAY.get(q["service_id"], q["service_id"]) for q in queue
        )
        lines.append(f"Queue: {q_str}")

    return "\n".join(lines)


async def _cmd_queue(npub_hex: str) -> str:
    """Show user's rotation queue order."""
    try:
        user_data = await api_client.get_user(npub_hex)
    except Exception as e:
        log.error("API call failed for queue: %s", e)
        return "Something went wrong. Try again in a minute."

    if user_data is None:
        return "Account not found. Sign up at unsaltedbutter.ai"

    queue = user_data.get("queue", [])
    if not queue:
        return "Your queue is empty."

    lines = []
    for item in queue:
        display = SERVICE_DISPLAY.get(item["service_id"], item["service_id"])
        lines.append(f"{item['position']}. {display}")
    return "\n".join(lines)
