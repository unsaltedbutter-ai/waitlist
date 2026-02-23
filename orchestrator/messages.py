"""
DM message templates for UnsaltedButter orchestrator.

Pure functions, no side effects, no I/O. Each function returns a string
(or list of strings for multi-message flows).
"""

from __future__ import annotations

SERVICE_DISPLAY: dict[str, str] = {
    "netflix": "Netflix",
    "hulu": "Hulu",
    "disney_plus": "Disney+",
    "apple_tv": "Apple TV+",
    "paramount": "Paramount+",
    "peacock": "Peacock",
    "max": "Max",
}


def display_name(service_id: str) -> str:
    """Return human-friendly service name."""
    return SERVICE_DISPLAY.get(service_id, service_id)


# ---------------------------------------------------------------------------
# Outreach
# ---------------------------------------------------------------------------


_OTP_NOTE = "You may need to send me a verification code if one pops up."


def outreach_cancel(service_id: str, access_end_date: str) -> str:
    """First outreach for a cancel job. Tells user their access end date."""
    name = display_name(service_id)
    return (
        f"Ready to cancel {name}? You can watch until {access_end_date}.\n"
        f"{_OTP_NOTE}\n"
        f"[yes | snooze | skip]"
    )


def outreach_cancel_no_date(service_id: str) -> str:
    """Outreach for cancel when we don't have billing date yet (first time)."""
    name = display_name(service_id)
    return (
        f"Ready to cancel {name}?\n"
        f"{_OTP_NOTE}\n"
        f"[yes | snooze | skip]"
    )


def outreach_resume(service_id: str, ending_service: str | None = None) -> str:
    """Outreach for a resume job. Optionally mention which service is ending."""
    name = display_name(service_id)
    if ending_service:
        ending_name = display_name(ending_service)
        return (
            f"With {ending_name} ending soon, want to resume {name}?\n"
            f"{_OTP_NOTE}\n"
            f"[yes | snooze | skip]"
        )
    return (
        f"Want to resume {name}?\n"
        f"{_OTP_NOTE}\n"
        f"[yes | snooze | skip]"
    )


def last_chance(service_id: str, days_left: int) -> str:
    """Last-chance ping at 4 days before billing."""
    name = display_name(service_id)
    return (
        f"{name} bills you again in {days_left} days. "
        f"Last chance to cancel this cycle. [yes | skip]"
    )


def outreach_followup(service_id: str) -> str:
    """Follow-up outreach after snooze/silence (48h later)."""
    name = display_name(service_id)
    return f"Still thinking about {name}? [yes | snooze | skip]"


# ---------------------------------------------------------------------------
# OTP flow
# ---------------------------------------------------------------------------


def otp_confirm(service_id: str, action: str) -> str:
    """Ask user to confirm they're available for OTP codes."""
    return f"Can I count on you to help me with OTP codes for the next ~2 minutes?"


def executing(service_id: str, action: str) -> str:
    """Tell user we're starting the action."""
    name = display_name(service_id)
    verb = "Cancelling" if action == "cancel" else "Resuming"
    return f"{verb} {name}..."


def otp_needed(service_id: str, prompt: str | None = None) -> str:
    """Ask user for OTP code. Optional prompt from agent."""
    name = display_name(service_id)
    if prompt:
        return f"{name}: {prompt}\nWhat's the code?"
    return f"{name} is asking for a verification code. What is it?"


def otp_received() -> str:
    """Acknowledge OTP code received."""
    return "Got it. Entering the code now..."


def otp_timeout() -> str:
    """OTP timeout message."""
    return (
        "No code received in 15 minutes. "
        "The session has been cancelled. Try again when you're ready."
    )


# ---------------------------------------------------------------------------
# Credential flow
# ---------------------------------------------------------------------------


def credential_needed(service_id: str, credential_name: str) -> str:
    """Ask user for a credential (CVV, ZIP, etc.)."""
    name = display_name(service_id)
    labels = {
        'cvv': 'CVV/security code',
        'zip': 'ZIP code',
        'name': 'full name',
        'birth': 'date of birth',
    }
    label = labels.get(credential_name, credential_name)
    return f"{name} is asking for your {label}. What is it?"


def credential_received() -> str:
    """Acknowledge credential received."""
    return "Got it. Entering that now..."


# ---------------------------------------------------------------------------
# Result
# ---------------------------------------------------------------------------


def action_success_cancel(service_id: str, access_end_date: str | None) -> str:
    """Cancel succeeded."""
    name = display_name(service_id)
    msg = f"{name} cancelled."
    if access_end_date:
        msg += f" Your access continues through {access_end_date}."
    return msg


def action_success_resume(service_id: str) -> str:
    """Resume succeeded."""
    name = display_name(service_id)
    return f"{name} reactivated. Your account should be live."


def action_failed(service_id: str, action: str) -> str:
    """Action failed. Brief, honest, no internal details."""
    name = display_name(service_id)
    verb = "cancel" if action == "cancel" else "resume"
    return f"Failed to {verb} {name}. We've notified our human. \U0001f916"


def action_failed_cancel(service_id: str) -> str:
    """Cancel failed (legacy wrapper)."""
    return action_failed(service_id, "cancel")


def action_failed_resume(service_id: str) -> str:
    """Resume failed (legacy wrapper)."""
    return action_failed(service_id, "resume")


# ---------------------------------------------------------------------------
# Payment
# ---------------------------------------------------------------------------


def invoice(amount_sats: int, bolt11: str) -> str:
    """Invoice message after work completes."""
    return f"{amount_sats:,} sats please. Pay this invoice:\n{bolt11}"


def payment_received(amount_sats: int) -> str:
    """Payment confirmation."""
    return (
        f"Payment received ({amount_sats:,} sats). "
        "It's been a pleasure doing business with you."
    )


def payment_expired(service_id: str, debt_sats: int) -> str:
    """Invoice expired, debt recorded."""
    name = display_name(service_id)
    return (
        f"Your invoice for {name} expired. "
        f"Outstanding balance: {debt_sats:,} sats. "
        f"Please pay before requesting new work."
    )


def debt_block(debt_sats: int) -> str:
    """User has debt, block new work."""
    return (
        f"You have an outstanding balance of {debt_sats:,} sats. "
        f"Please pay before requesting new work."
    )


# ---------------------------------------------------------------------------
# Welcome / help / misc
# ---------------------------------------------------------------------------


def welcome(services: list[str]) -> str:
    """Welcome message after onboarding. Offer cancel-all."""
    names = [display_name(s) for s in services]
    joined = ", ".join(names)
    return (
        f"Welcome to UnsaltedButter.\n\n"
        f"Your services: {joined}\n\n"
        f"Want me to cancel all of them now to start your rotation? [yes | no]"
    )


def help_text() -> str:
    """Help message."""
    return (
        "Commands:\n"
        "  cancel [service]: request a cancel (e.g. cancel netflix)\n"
        "  resume [service]: request a resume (e.g. resume hulu)\n"
        "  status: your active jobs, queue, and debt\n"
        "  queue: your rotation queue order\n"
        "  help: this message\n"
        "\n"
        "3,000 sats per action, billed after completion."
    )


def busy() -> str:
    """User has an active task, can't start another."""
    return "You have an active task. Finish it first."


def waitlist_added() -> str:
    return "You're on the waitlist. We'll DM you when a spot opens."


def waitlist_already() -> str:
    return "You're already on the waitlist. We'll DM you when a spot opens."


def waitlist_invited(base_url: str) -> str:
    return f"You've already been invited. DM me 'login' to get your code.\n\n{base_url}/login"


def login_code(code: str, base_url: str) -> list[str]:
    """Login OTP code. Returns TWO messages (code first, instructions second)."""
    formatted = f"{code[:6]}-{code[6:]}"
    return [
        formatted,
        f"That's your login code. Enter it within 5 minutes.\n\n{base_url}/login",
    ]


def not_registered(base_url: str) -> str:
    return f"Complete your setup first.\n\n{base_url}/login"


def invite_dm(base_url: str) -> str:
    return f"You're in. DM me 'login' to get your code.\n\n{base_url}/login"


def already_has_account() -> str:
    return "You already have an account."


def user_skip_ack(service_id: str) -> str:
    name = display_name(service_id)
    return f"Got it. Skipping {name} this cycle."


def user_snooze_ack() -> str:
    return "Snoozed. I'll check back in 48 hours."


def session_cancelled() -> str:
    return "Cancelled."


def unknown_service(service_input: str) -> str:
    return (
        f"Unknown service: {service_input}\n"
        f"Try: netflix, hulu, disney+, apple tv+, paramount+, peacock, max"
    )


def queued(service_id: str, action: str) -> str:
    name = display_name(service_id)
    return f"{name} {action} is queued. I'll let you know when it's done."


def no_credentials(service_id: str, base_url: str) -> str:
    name = display_name(service_id)
    return (
        f"No credentials on file for {name}. "
        f"Add them on the website first.\n\n{base_url}/login"
    )


def error_generic() -> str:
    return "Something went wrong. Try again in a minute."


def operator_job_failed(job_id: str, service_id: str, error: str | None) -> str:
    """Operator alert for job failure."""
    name = display_name(service_id)
    msg = f"Job {job_id[:8]} failed: {name}"
    if error:
        msg += f"\nError: {error}"
    return msg


def operator_agent_down(minutes: int) -> str:
    """Operator alert for agent unreachable."""
    return f"Agent unreachable for {minutes} minutes. Check Mac Mini."
