"""Tests for DM command routing (commands.py)."""

from __future__ import annotations

from dataclasses import dataclass
from unittest.mock import AsyncMock, call

import pytest
import pytest_asyncio

from commands import CommandRouter, parse_service, SERVICE_ALIASES
from session import (
    IDLE, OTP_CONFIRM, AWAITING_OTP, AWAITING_CREDENTIAL, EXECUTING, INVOICE_SENT,
)
import messages


# ------------------------------------------------------------------
# Helpers
# ------------------------------------------------------------------

ALICE = "npub1alice"
OPERATOR = "npub1operator"


@dataclass(frozen=True)
class FakeConfig:
    base_url: str = "https://unsaltedbutter.ai"
    operator_pubkey: str = OPERATOR


def _make_router(
    *,
    api: AsyncMock | None = None,
    session: AsyncMock | None = None,
    job_manager: AsyncMock | None = None,
    config: FakeConfig | None = None,
    send_dm: AsyncMock | None = None,
) -> tuple[CommandRouter, dict]:
    """Build a CommandRouter with AsyncMock dependencies. Returns (router, deps)."""
    api = api or AsyncMock()
    session = session or AsyncMock()
    job_manager = job_manager or AsyncMock()
    config = config or FakeConfig()
    send_dm = send_dm or AsyncMock()

    # Default session.get_state to IDLE
    session.get_state.return_value = IDLE

    router = CommandRouter(
        api=api,
        session=session,
        job_manager=job_manager,
        config=config,
        send_dm=send_dm,
    )
    return router, {
        "api": api,
        "session": session,
        "job_manager": job_manager,
        "config": config,
        "send_dm": send_dm,
    }


def _make_job(
    job_id: str = "job-1",
    service_id: str = "netflix",
    action: str = "cancel",
    status: str = "outreach_sent",
) -> dict:
    return {
        "id": job_id,
        "service_id": service_id,
        "action": action,
        "status": status,
    }


# ==================================================================
# parse_service
# ==================================================================


class TestParseService:
    def test_all_aliases_resolve(self):
        for alias, expected in SERVICE_ALIASES.items():
            assert parse_service(alias) == expected

    def test_case_insensitive(self):
        assert parse_service("Netflix") == "netflix"
        assert parse_service("HULU") == "hulu"
        assert parse_service("Disney+") == "disney_plus"

    def test_strips_whitespace(self):
        assert parse_service("  netflix  ") == "netflix"

    def test_unknown_returns_none(self):
        assert parse_service("crunchyroll") is None
        assert parse_service("") is None
        assert parse_service("net flix") is None


# ==================================================================
# _is_otp_like
# ==================================================================


class TestIsOtpLike:
    def setup_method(self):
        self.router, _ = _make_router()

    def test_six_digits(self):
        assert self.router._is_otp_like("123456") is True

    def test_four_digits(self):
        assert self.router._is_otp_like("1234") is True

    def test_eight_digits(self):
        assert self.router._is_otp_like("12345678") is True

    def test_digits_with_spaces(self):
        assert self.router._is_otp_like("123 456") is True

    def test_digits_with_dashes(self):
        assert self.router._is_otp_like("12-34-56") is True

    def test_mixed_separators(self):
        assert self.router._is_otp_like("12 34-56") is True

    def test_three_digits_cvv(self):
        assert self.router._is_otp_like("123") is True

    def test_too_short(self):
        assert self.router._is_otp_like("12") is False

    def test_too_long(self):
        assert self.router._is_otp_like("123456789") is False

    def test_non_digits(self):
        assert self.router._is_otp_like("abcdef") is False

    def test_mixed_alpha_digits(self):
        assert self.router._is_otp_like("12ab56") is False

    def test_empty(self):
        assert self.router._is_otp_like("") is False


# ==================================================================
# _is_operator
# ==================================================================


class TestIsOperator:
    def test_matching_operator(self):
        router, _ = _make_router()
        assert router._is_operator(OPERATOR) is True

    def test_non_operator(self):
        router, _ = _make_router()
        assert router._is_operator(ALICE) is False


# ==================================================================
# State-based routing: AWAITING_OTP
# ==================================================================


@pytest.mark.asyncio
async def test_awaiting_otp_digits_relayed():
    """Digits during AWAITING_OTP should be relayed as OTP input."""
    router, deps = _make_router()
    deps["session"].get_state.return_value = AWAITING_OTP

    await router.handle_dm(ALICE, "123456")

    deps["session"].handle_otp_input.assert_awaited_once_with(ALICE, "123456")
    deps["send_dm"].assert_not_awaited()


@pytest.mark.asyncio
async def test_awaiting_otp_digits_strips_spaces():
    """OTP with spaces should be stripped before relaying."""
    router, deps = _make_router()
    deps["session"].get_state.return_value = AWAITING_OTP

    await router.handle_dm(ALICE, "123 456")

    deps["session"].handle_otp_input.assert_awaited_once_with(ALICE, "123456")


@pytest.mark.asyncio
async def test_awaiting_otp_digits_strips_dashes():
    """OTP with dashes should be stripped before relaying."""
    router, deps = _make_router()
    deps["session"].get_state.return_value = AWAITING_OTP

    await router.handle_dm(ALICE, "12-34-56")

    deps["session"].handle_otp_input.assert_awaited_once_with(ALICE, "123456")


@pytest.mark.asyncio
async def test_awaiting_otp_non_digits_sends_busy():
    """Non-digit text during AWAITING_OTP should send busy message."""
    router, deps = _make_router()
    deps["session"].get_state.return_value = AWAITING_OTP

    await router.handle_dm(ALICE, "help")

    deps["session"].handle_otp_input.assert_not_awaited()
    deps["send_dm"].assert_awaited_once_with(ALICE, messages.busy())


# ==================================================================
# State-based routing: AWAITING_CREDENTIAL
# ==================================================================


@pytest.mark.asyncio
async def test_awaiting_credential_forwards_value():
    """Non-empty text during AWAITING_CREDENTIAL should be forwarded as credential."""
    router, deps = _make_router()
    deps["session"].get_state.return_value = AWAITING_CREDENTIAL

    await router.handle_dm(ALICE, "123")

    deps["session"].handle_credential_input.assert_awaited_once_with(ALICE, "123")
    deps["send_dm"].assert_not_awaited()


@pytest.mark.asyncio
async def test_awaiting_credential_forwards_text():
    """Text credential values (names, zip codes) should be forwarded."""
    router, deps = _make_router()
    deps["session"].get_state.return_value = AWAITING_CREDENTIAL

    await router.handle_dm(ALICE, "90210")

    deps["session"].handle_credential_input.assert_awaited_once_with(ALICE, "90210")


@pytest.mark.asyncio
async def test_awaiting_credential_empty_sends_busy():
    """Empty input during AWAITING_CREDENTIAL should send busy message."""
    router, deps = _make_router()
    deps["session"].get_state.return_value = AWAITING_CREDENTIAL

    await router.handle_dm(ALICE, "   ")

    deps["session"].handle_credential_input.assert_not_awaited()
    deps["send_dm"].assert_awaited_once_with(ALICE, messages.busy())


# ==================================================================
# State-based routing: OTP_CONFIRM
# ==================================================================


@pytest.mark.asyncio
async def test_otp_confirm_yes_dispatches():
    """'yes' in OTP_CONFIRM should request dispatch."""
    router, deps = _make_router()
    deps["session"].get_state.return_value = OTP_CONFIRM
    deps["job_manager"].get_active_job_for_user.return_value = _make_job()

    await router.handle_dm(ALICE, "yes")

    deps["job_manager"].request_dispatch.assert_awaited_once_with(ALICE, "job-1")


@pytest.mark.asyncio
async def test_otp_confirm_y_dispatches():
    """'y' in OTP_CONFIRM should also dispatch."""
    router, deps = _make_router()
    deps["session"].get_state.return_value = OTP_CONFIRM
    deps["job_manager"].get_active_job_for_user.return_value = _make_job()

    await router.handle_dm(ALICE, "y")

    deps["job_manager"].request_dispatch.assert_awaited_once_with(ALICE, "job-1")


@pytest.mark.asyncio
async def test_otp_confirm_yes_no_active_job_falls_through():
    """'yes' in OTP_CONFIRM with no active job should call handle_otp_confirm_yes directly."""
    router, deps = _make_router()
    deps["session"].get_state.return_value = OTP_CONFIRM
    deps["job_manager"].get_active_job_for_user.return_value = None

    await router.handle_dm(ALICE, "yes")

    deps["session"].handle_otp_confirm_yes.assert_awaited_once_with(ALICE)


@pytest.mark.asyncio
async def test_otp_confirm_no_cancels():
    """'no' in OTP_CONFIRM should cancel the session."""
    router, deps = _make_router()
    deps["session"].get_state.return_value = OTP_CONFIRM

    await router.handle_dm(ALICE, "no")

    deps["session"].handle_otp_confirm_no.assert_awaited_once_with(ALICE)


@pytest.mark.asyncio
async def test_otp_confirm_cancel_cancels():
    """'cancel' in OTP_CONFIRM should cancel the session."""
    router, deps = _make_router()
    deps["session"].get_state.return_value = OTP_CONFIRM

    await router.handle_dm(ALICE, "cancel")

    deps["session"].handle_otp_confirm_no.assert_awaited_once_with(ALICE)


@pytest.mark.asyncio
async def test_otp_confirm_n_cancels():
    """'n' in OTP_CONFIRM should cancel the session."""
    router, deps = _make_router()
    deps["session"].get_state.return_value = OTP_CONFIRM

    await router.handle_dm(ALICE, "n")

    deps["session"].handle_otp_confirm_no.assert_awaited_once_with(ALICE)


@pytest.mark.asyncio
async def test_otp_confirm_random_text_sends_busy():
    """Random text in OTP_CONFIRM should send busy message."""
    router, deps = _make_router()
    deps["session"].get_state.return_value = OTP_CONFIRM

    await router.handle_dm(ALICE, "what is going on")

    deps["send_dm"].assert_awaited_once_with(ALICE, messages.busy())


# ==================================================================
# State-based routing: EXECUTING / INVOICE_SENT
# ==================================================================


@pytest.mark.asyncio
async def test_executing_sends_busy():
    """Any text during EXECUTING should send busy."""
    router, deps = _make_router()
    deps["session"].get_state.return_value = EXECUTING

    await router.handle_dm(ALICE, "help")

    deps["send_dm"].assert_awaited_once_with(ALICE, messages.busy())


@pytest.mark.asyncio
async def test_invoice_sent_sends_busy():
    """Any text during INVOICE_SENT should send busy."""
    router, deps = _make_router()
    deps["session"].get_state.return_value = INVOICE_SENT

    await router.handle_dm(ALICE, "status")

    deps["send_dm"].assert_awaited_once_with(ALICE, messages.busy())


# ==================================================================
# IDLE commands: yes / skip / snooze
# ==================================================================


@pytest.mark.asyncio
async def test_idle_yes_with_active_job():
    """'yes' in IDLE with an active job should start session."""
    router, deps = _make_router()
    deps["job_manager"].get_active_job_for_user.return_value = _make_job()

    await router.handle_dm(ALICE, "yes")

    deps["session"].handle_yes.assert_awaited_once_with(ALICE, "job-1")


@pytest.mark.asyncio
async def test_idle_yes_without_active_job():
    """'yes' in IDLE with no active job should send help."""
    router, deps = _make_router()
    deps["job_manager"].get_active_job_for_user.return_value = None

    await router.handle_dm(ALICE, "yes")

    deps["send_dm"].assert_awaited_once_with(ALICE, messages.help_text())


@pytest.mark.asyncio
async def test_idle_skip_with_active_job():
    """'skip' in IDLE should skip the active job."""
    router, deps = _make_router()
    deps["job_manager"].get_active_job_for_user.return_value = _make_job()

    await router.handle_dm(ALICE, "skip")

    deps["job_manager"].handle_skip.assert_awaited_once_with(ALICE, "job-1")


@pytest.mark.asyncio
async def test_idle_skip_without_active_job():
    """'skip' without active job should send help."""
    router, deps = _make_router()
    deps["job_manager"].get_active_job_for_user.return_value = None

    await router.handle_dm(ALICE, "skip")

    deps["send_dm"].assert_awaited_once_with(ALICE, messages.help_text())


@pytest.mark.asyncio
async def test_idle_snooze_with_active_job():
    """'snooze' should snooze the active job."""
    router, deps = _make_router()
    deps["job_manager"].get_active_job_for_user.return_value = _make_job()

    await router.handle_dm(ALICE, "snooze")

    deps["job_manager"].handle_snooze.assert_awaited_once_with(ALICE, "job-1")


@pytest.mark.asyncio
async def test_idle_snooze_without_active_job():
    """'snooze' without active job should send help."""
    router, deps = _make_router()
    deps["job_manager"].get_active_job_for_user.return_value = None

    await router.handle_dm(ALICE, "snooze")

    deps["send_dm"].assert_awaited_once_with(ALICE, messages.help_text())


# ==================================================================
# IDLE commands: cancel / resume
# ==================================================================


@pytest.mark.asyncio
async def test_cancel_known_service_queued():
    """'cancel netflix' with queue > 1 should send queued message."""
    router, deps = _make_router()
    deps["api"].get_user.return_value = {"debt_sats": 0}
    deps["api"].create_on_demand_job.return_value = {
        "status_code": 200,
        "data": {"id": "job-2", "queue_position": 3},
    }

    await router.handle_dm(ALICE, "cancel netflix")

    deps["api"].create_on_demand_job.assert_awaited_once_with(
        ALICE, "netflix", "cancel"
    )
    deps["send_dm"].assert_awaited_once()
    msg = deps["send_dm"].call_args[0][1]
    assert "Netflix" in msg
    assert "queue" in msg.lower()
    deps["job_manager"].poll_and_claim.assert_awaited_once()


@pytest.mark.asyncio
async def test_cancel_known_service_no_queue():
    """'cancel netflix' with queue_position=1 should skip queued message."""
    router, deps = _make_router()
    deps["api"].get_user.return_value = {"debt_sats": 0}
    deps["api"].create_on_demand_job.return_value = {
        "status_code": 200,
        "data": {"id": "job-2", "queue_position": 1},
    }

    await router.handle_dm(ALICE, "cancel netflix")

    deps["api"].create_on_demand_job.assert_awaited_once_with(
        ALICE, "netflix", "cancel"
    )
    # No queued DM sent, only poll_and_claim triggers outreach
    deps["send_dm"].assert_not_awaited()
    deps["job_manager"].poll_and_claim.assert_awaited_once()


@pytest.mark.asyncio
async def test_cancel_unknown_service():
    """'cancel crunchyroll' should send unknown service message."""
    router, deps = _make_router()

    await router.handle_dm(ALICE, "cancel crunchyroll")

    deps["send_dm"].assert_awaited_once()
    msg = deps["send_dm"].call_args[0][1]
    assert "Unknown service" in msg
    assert "crunchyroll" in msg


@pytest.mark.asyncio
async def test_resume_known_service():
    """'resume hulu' should create an on-demand resume job."""
    router, deps = _make_router()
    deps["api"].get_user.return_value = {"debt_sats": 0}
    deps["api"].create_on_demand_job.return_value = {
        "status_code": 200,
        "data": {"id": "job-3"},
    }

    await router.handle_dm(ALICE, "resume hulu")

    deps["api"].create_on_demand_job.assert_awaited_once_with(
        ALICE, "hulu", "resume"
    )


@pytest.mark.asyncio
async def test_action_with_debt():
    """Cancel/resume with outstanding debt should be blocked."""
    router, deps = _make_router()
    deps["api"].get_user.return_value = {"debt_sats": 3000}

    await router.handle_dm(ALICE, "cancel netflix")

    deps["api"].create_on_demand_job.assert_not_awaited()
    deps["send_dm"].assert_awaited_once()
    msg = deps["send_dm"].call_args[0][1]
    assert "3,000" in msg
    assert "outstanding" in msg.lower()


@pytest.mark.asyncio
async def test_action_unregistered_user():
    """Cancel from unregistered user should auto-waitlist."""
    router, deps = _make_router()
    deps["api"].get_user.return_value = None
    deps["api"].add_to_waitlist.return_value = {"status": "added"}

    await router.handle_dm(ALICE, "cancel netflix")

    deps["api"].add_to_waitlist.assert_awaited_once_with(ALICE)
    deps["send_dm"].assert_awaited_once()
    msg = deps["send_dm"].call_args[0][1]
    assert "waitlist" in msg.lower()


@pytest.mark.asyncio
async def test_action_api_403_debt():
    """API 403 with debt should show debt message."""
    router, deps = _make_router()
    deps["api"].get_user.return_value = {"debt_sats": 0}
    deps["api"].create_on_demand_job.return_value = {
        "status_code": 403,
        "data": {"error": "debt", "debt_sats": 6000},
    }

    await router.handle_dm(ALICE, "cancel netflix")

    deps["send_dm"].assert_awaited_once()
    msg = deps["send_dm"].call_args[0][1]
    assert "6,000" in msg


@pytest.mark.asyncio
async def test_action_api_409_duplicate():
    """API 409 should show pending job message."""
    router, deps = _make_router()
    deps["api"].get_user.return_value = {"debt_sats": 0}
    deps["api"].create_on_demand_job.return_value = {
        "status_code": 409,
        "data": {"error": "duplicate"},
    }

    await router.handle_dm(ALICE, "cancel netflix")

    deps["send_dm"].assert_awaited_once()
    msg = deps["send_dm"].call_args[0][1]
    assert "pending job" in msg.lower()
    assert "Netflix" in msg


@pytest.mark.asyncio
async def test_action_api_400_no_credentials():
    """API 400 with credentials error should show no_credentials message."""
    router, deps = _make_router()
    deps["api"].get_user.return_value = {"debt_sats": 0}
    deps["api"].create_on_demand_job.return_value = {
        "status_code": 400,
        "data": {"error": "No credentials found"},
    }

    await router.handle_dm(ALICE, "cancel netflix")

    deps["send_dm"].assert_awaited_once()
    msg = deps["send_dm"].call_args[0][1]
    assert "credentials" in msg.lower()


@pytest.mark.asyncio
async def test_action_api_400_other_error():
    """API 400 with non-credentials error should send generic message (no internal details)."""
    router, deps = _make_router()
    deps["api"].get_user.return_value = {"debt_sats": 0}
    deps["api"].create_on_demand_job.return_value = {
        "status_code": 400,
        "data": {"error": "Invalid service"},
    }

    await router.handle_dm(ALICE, "cancel netflix")

    deps["send_dm"].assert_awaited_once()
    msg = deps["send_dm"].call_args[0][1]
    # Must NOT leak internal error text to user
    assert "Invalid service" not in msg
    assert "wrong" in msg.lower()


@pytest.mark.asyncio
async def test_action_api_404():
    """API 404 should show not_registered message."""
    router, deps = _make_router()
    deps["api"].get_user.return_value = {"debt_sats": 0}
    deps["api"].create_on_demand_job.return_value = {
        "status_code": 404,
        "data": {"error": "user not found"},
    }

    await router.handle_dm(ALICE, "cancel netflix")

    deps["send_dm"].assert_awaited_once()
    msg = deps["send_dm"].call_args[0][1]
    assert "unsaltedbutter.ai" in msg


@pytest.mark.asyncio
async def test_action_api_unexpected_status():
    """Unexpected API status should show generic error."""
    router, deps = _make_router()
    deps["api"].get_user.return_value = {"debt_sats": 0}
    deps["api"].create_on_demand_job.return_value = {
        "status_code": 500,
        "data": {"error": "internal"},
    }

    await router.handle_dm(ALICE, "cancel netflix")

    deps["send_dm"].assert_awaited_once()
    msg = deps["send_dm"].call_args[0][1]
    assert "wrong" in msg.lower()


@pytest.mark.asyncio
async def test_action_api_exception():
    """API exception during create_on_demand_job should send generic error."""
    router, deps = _make_router()
    deps["api"].get_user.return_value = {"debt_sats": 0}
    deps["api"].create_on_demand_job.side_effect = Exception("network error")

    await router.handle_dm(ALICE, "cancel netflix")

    deps["send_dm"].assert_awaited_once()
    msg = deps["send_dm"].call_args[0][1]
    assert "wrong" in msg.lower()


@pytest.mark.asyncio
async def test_cancel_service_alias_disney_plus():
    """'cancel disney+' should resolve to disney_plus."""
    router, deps = _make_router()
    deps["api"].get_user.return_value = {"debt_sats": 0}
    deps["api"].create_on_demand_job.return_value = {
        "status_code": 200,
        "data": {},
    }

    await router.handle_dm(ALICE, "cancel disney+")

    deps["api"].create_on_demand_job.assert_awaited_once_with(
        ALICE, "disney_plus", "cancel"
    )


@pytest.mark.asyncio
async def test_resume_service_alias_hbo():
    """'resume hbo' should resolve to max."""
    router, deps = _make_router()
    deps["api"].get_user.return_value = {"debt_sats": 0}
    deps["api"].create_on_demand_job.return_value = {
        "status_code": 200,
        "data": {},
    }

    await router.handle_dm(ALICE, "resume hbo")

    deps["api"].create_on_demand_job.assert_awaited_once_with(
        ALICE, "max", "resume"
    )


# ==================================================================
# IDLE commands: status
# ==================================================================


@pytest.mark.asyncio
async def test_status_registered_user():
    """Status for a registered user should show jobs and queue."""
    router, deps = _make_router()
    deps["api"].get_user.return_value = {
        "user": {"debt_sats": 0},
        "active_jobs": [
            {"service_id": "netflix", "action": "cancel", "status": "active"}
        ],
        "queue": [
            {"service_id": "hulu", "position": 1},
        ],
    }

    await router.handle_dm(ALICE, "status")

    deps["send_dm"].assert_awaited_once()
    msg = deps["send_dm"].call_args[0][1]
    assert "Netflix" in msg
    assert "cancel" in msg
    assert "Hulu" in msg


@pytest.mark.asyncio
async def test_status_with_debt():
    """Status with debt should show outstanding balance."""
    router, deps = _make_router()
    deps["api"].get_user.return_value = {
        "user": {"debt_sats": 3000},
        "active_jobs": [],
        "queue": [],
    }

    await router.handle_dm(ALICE, "status")

    deps["send_dm"].assert_awaited_once()
    msg = deps["send_dm"].call_args[0][1]
    assert "3,000" in msg
    assert "No active jobs" in msg


@pytest.mark.asyncio
async def test_status_unregistered_user():
    """Status for unregistered user should auto-waitlist."""
    router, deps = _make_router()
    deps["api"].get_user.return_value = None
    deps["api"].add_to_waitlist.return_value = {"status": "added"}

    await router.handle_dm(ALICE, "status")

    deps["api"].add_to_waitlist.assert_awaited_once()


@pytest.mark.asyncio
async def test_status_api_error():
    """Status API failure should send generic error."""
    router, deps = _make_router()
    deps["api"].get_user.side_effect = Exception("timeout")

    await router.handle_dm(ALICE, "status")

    deps["send_dm"].assert_awaited_once()
    msg = deps["send_dm"].call_args[0][1]
    assert "wrong" in msg.lower()


# ==================================================================
# IDLE commands: queue
# ==================================================================


@pytest.mark.asyncio
async def test_queue_with_items():
    """Queue command with items should list them."""
    router, deps = _make_router()
    deps["api"].get_user.return_value = {
        "queue": [
            {"service_id": "netflix", "position": 1},
            {"service_id": "hulu", "position": 2},
        ],
    }

    await router.handle_dm(ALICE, "queue")

    deps["send_dm"].assert_awaited_once()
    msg = deps["send_dm"].call_args[0][1]
    assert "1. Netflix" in msg
    assert "2. Hulu" in msg


@pytest.mark.asyncio
async def test_queue_empty():
    """Queue command with no items should say empty."""
    router, deps = _make_router()
    deps["api"].get_user.return_value = {"queue": []}

    await router.handle_dm(ALICE, "queue")

    deps["send_dm"].assert_awaited_once()
    msg = deps["send_dm"].call_args[0][1]
    assert "empty" in msg.lower()


@pytest.mark.asyncio
async def test_queue_unregistered():
    """Queue for unregistered user should auto-waitlist."""
    router, deps = _make_router()
    deps["api"].get_user.return_value = None
    deps["api"].add_to_waitlist.return_value = {"status": "added"}

    await router.handle_dm(ALICE, "queue")

    deps["api"].add_to_waitlist.assert_awaited_once()


# ==================================================================
# IDLE commands: help
# ==================================================================


@pytest.mark.asyncio
async def test_help():
    """'help' should send help text."""
    router, deps = _make_router()

    await router.handle_dm(ALICE, "help")

    deps["send_dm"].assert_awaited_once_with(ALICE, messages.help_text())


@pytest.mark.asyncio
async def test_unknown_command_sends_help():
    """Unknown command should send help text."""
    router, deps = _make_router()

    await router.handle_dm(ALICE, "xyzzy")

    deps["send_dm"].assert_awaited_once_with(ALICE, messages.help_text())


# ==================================================================
# IDLE commands: login
# ==================================================================


@pytest.mark.asyncio
async def test_login_registered_user():
    """Login for registered user should send two DMs (code + instructions)."""
    router, deps = _make_router()
    deps["api"].get_user.return_value = {"id": "user-1"}
    deps["api"].create_otp.return_value = "123456789012"

    await router.handle_dm(ALICE, "login")

    # Two DMs sent: formatted code and instructions
    assert deps["send_dm"].await_count == 2
    code_msg = deps["send_dm"].call_args_list[0][0][1]
    instr_msg = deps["send_dm"].call_args_list[1][0][1]
    assert "123456-789012" in code_msg
    assert "login" in instr_msg.lower()


@pytest.mark.asyncio
async def test_login_unregistered_auto_waitlists():
    """Login for unregistered user should add to waitlist."""
    router, deps = _make_router()
    deps["api"].get_user.return_value = None
    deps["api"].add_to_waitlist.return_value = {"status": "added"}

    await router.handle_dm(ALICE, "login")

    deps["api"].add_to_waitlist.assert_awaited_once_with(ALICE)
    deps["send_dm"].assert_awaited_once()
    msg = deps["send_dm"].call_args[0][1]
    assert "waitlist" in msg.lower()


@pytest.mark.asyncio
async def test_login_already_invited_not_registered():
    """Login for invited-but-not-registered user should tell them to complete setup."""
    router, deps = _make_router()
    deps["api"].get_user.return_value = None
    deps["api"].add_to_waitlist.return_value = {"status": "already_invited"}

    await router.handle_dm(ALICE, "login")

    deps["send_dm"].assert_awaited_once()
    msg = deps["send_dm"].call_args[0][1]
    assert "setup" in msg.lower() or "login" in msg.lower()


@pytest.mark.asyncio
async def test_login_otp_creation_fails():
    """If OTP creation fails, send generic error."""
    router, deps = _make_router()
    deps["api"].get_user.return_value = {"id": "user-1"}
    deps["api"].create_otp.side_effect = Exception("500")

    await router.handle_dm(ALICE, "login")

    deps["send_dm"].assert_awaited_once()
    msg = deps["send_dm"].call_args[0][1]
    assert "wrong" in msg.lower()


# ==================================================================
# IDLE commands: waitlist
# ==================================================================


@pytest.mark.asyncio
async def test_waitlist_new_user():
    """Waitlist for new user should add them."""
    router, deps = _make_router()
    deps["api"].get_user.return_value = None
    deps["api"].add_to_waitlist.return_value = {"status": "added"}

    await router.handle_dm(ALICE, "waitlist")

    deps["api"].add_to_waitlist.assert_awaited_once_with(ALICE)
    deps["send_dm"].assert_awaited_once()
    msg = deps["send_dm"].call_args[0][1]
    assert "waitlist" in msg.lower()


@pytest.mark.asyncio
async def test_waitlist_already_waitlisted():
    """Waitlist for already-waitlisted user should say so."""
    router, deps = _make_router()
    deps["api"].get_user.return_value = None
    deps["api"].add_to_waitlist.return_value = {"status": "already_waitlisted"}

    await router.handle_dm(ALICE, "waitlist")

    deps["send_dm"].assert_awaited_once()
    msg = deps["send_dm"].call_args[0][1]
    assert "already" in msg.lower()
    assert "waitlist" in msg.lower()


@pytest.mark.asyncio
async def test_waitlist_already_invited():
    """Waitlist for already-invited user should tell them to login."""
    router, deps = _make_router()
    deps["api"].get_user.return_value = None
    deps["api"].add_to_waitlist.return_value = {"status": "already_invited"}

    await router.handle_dm(ALICE, "waitlist")

    deps["send_dm"].assert_awaited_once()
    msg = deps["send_dm"].call_args[0][1]
    assert "invited" in msg.lower() or "login" in msg.lower()


@pytest.mark.asyncio
async def test_waitlist_registered_user():
    """Waitlist for registered user should say they already have an account."""
    router, deps = _make_router()
    deps["api"].get_user.return_value = {"id": "user-1"}

    await router.handle_dm(ALICE, "waitlist")

    deps["send_dm"].assert_awaited_once()
    msg = deps["send_dm"].call_args[0][1]
    assert "already have an account" in msg.lower()


# ==================================================================
# IDLE commands: invites (operator only)
# ==================================================================


@pytest.mark.asyncio
async def test_invites_operator_sends_pending():
    """Operator 'invites' should send pending invite DMs."""
    router, deps = _make_router()
    deps["api"].get_pending_invite_dms.return_value = [
        {"id": "wl-1", "npub_hex": "npub1bob"},
        {"id": "wl-2", "npub_hex": "npub1carol"},
    ]

    await router.handle_dm(OPERATOR, "invites")

    # Two invite DMs + one summary DM to operator
    assert deps["send_dm"].await_count == 3
    # Invitee DMs
    first_call = deps["send_dm"].call_args_list[0]
    assert first_call[0][0] == "npub1bob"
    second_call = deps["send_dm"].call_args_list[1]
    assert second_call[0][0] == "npub1carol"
    # Summary to operator
    summary = deps["send_dm"].call_args_list[2][0][1]
    assert "2" in summary


@pytest.mark.asyncio
async def test_invites_operator_no_pending():
    """Operator 'invites' with none pending should say so."""
    router, deps = _make_router()
    deps["api"].get_pending_invite_dms.return_value = []

    await router.handle_dm(OPERATOR, "invites")

    deps["send_dm"].assert_awaited_once()
    msg = deps["send_dm"].call_args[0][1]
    assert "No pending" in msg


@pytest.mark.asyncio
async def test_invites_non_operator():
    """Non-operator 'invites' should show help text."""
    router, deps = _make_router()

    await router.handle_dm(ALICE, "invites")

    deps["send_dm"].assert_awaited_once_with(ALICE, messages.help_text())


# ==================================================================
# Auto-waitlist for unregistered users
# ==================================================================


@pytest.mark.asyncio
async def test_auto_waitlist_on_cancel():
    """Unregistered user sending 'cancel netflix' should be auto-waitlisted."""
    router, deps = _make_router()
    deps["api"].get_user.return_value = None
    deps["api"].add_to_waitlist.return_value = {"status": "added"}

    await router.handle_dm(ALICE, "cancel netflix")

    deps["api"].add_to_waitlist.assert_awaited_once_with(ALICE)


@pytest.mark.asyncio
async def test_auto_waitlist_already_invited():
    """Auto-waitlist for already-invited user should show invited message."""
    router, deps = _make_router()
    deps["api"].get_user.return_value = None
    deps["api"].add_to_waitlist.return_value = {"status": "already_invited"}

    await router.handle_dm(ALICE, "resume hulu")

    deps["send_dm"].assert_awaited_once()
    msg = deps["send_dm"].call_args[0][1]
    assert "invited" in msg.lower() or "login" in msg.lower()


@pytest.mark.asyncio
async def test_auto_waitlist_api_failure():
    """Auto-waitlist API failure should send not_registered message."""
    router, deps = _make_router()
    deps["api"].get_user.return_value = None
    deps["api"].add_to_waitlist.side_effect = Exception("network")

    await router.handle_dm(ALICE, "cancel netflix")

    deps["send_dm"].assert_awaited_once()
    msg = deps["send_dm"].call_args[0][1]
    assert "setup" in msg.lower() or "unsaltedbutter" in msg.lower()


# ==================================================================
# Case insensitivity
# ==================================================================


@pytest.mark.asyncio
async def test_commands_case_insensitive():
    """Commands should be case-insensitive."""
    router, deps = _make_router()

    await router.handle_dm(ALICE, "HELP")
    deps["send_dm"].assert_awaited_once_with(ALICE, messages.help_text())


@pytest.mark.asyncio
async def test_whitespace_trimmed():
    """Leading/trailing whitespace should be trimmed."""
    router, deps = _make_router()

    await router.handle_dm(ALICE, "  help  ")
    deps["send_dm"].assert_awaited_once_with(ALICE, messages.help_text())
