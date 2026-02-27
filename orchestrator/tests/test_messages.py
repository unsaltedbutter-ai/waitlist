"""Tests for DM message templates."""

from __future__ import annotations

import inspect
import types

import pytest

from messages import (
    SERVICE_DISPLAY,
    action_failed_cancel,
    action_starting,
    action_failed_resume,
    action_success_cancel,
    action_success_resume,
    already_has_account,
    busy,
    credential_needed,
    credential_received,
    debt_block,
    display_name,
    error_generic,
    executing,
    help_text,
    invite_dm,
    invoice,
    last_chance,
    login_code,
    no_credentials,
    not_registered,
    operator_agent_down,
    operator_job_failed,
    otp_confirm,
    otp_needed,
    otp_received,
    otp_timeout,
    outreach_cancel,
    outreach_cancel_no_date,
    outreach_followup,
    outreach_resume,
    payment_expired,
    payment_received,
    queued,
    session_cancelled,
    unknown_service,
    user_skip_ack,
    user_snooze_ack,
    waitlist_added,
    waitlist_already,
    waitlist_invited,
    welcome,
)
import messages as messages_module


# ---------------------------------------------------------------------------
# display_name
# ---------------------------------------------------------------------------


class TestDisplayName:
    @pytest.mark.parametrize("service_id,expected", list(SERVICE_DISPLAY.items()))
    def test_display_name_known(self, service_id: str, expected: str) -> None:
        assert display_name(service_id) == expected

    def test_display_name_unknown(self) -> None:
        assert display_name("crunchyroll") == "crunchyroll"


# ---------------------------------------------------------------------------
# Outreach
# ---------------------------------------------------------------------------


class TestOutreach:
    def test_outreach_cancel(self) -> None:
        msg = outreach_cancel("netflix", "March 15")
        assert "Netflix" in msg
        assert "March 15" in msg
        assert "[yes | snooze | skip]" in msg

    def test_outreach_cancel_no_date(self) -> None:
        msg = outreach_cancel_no_date("hulu")
        assert "Hulu" in msg
        assert "[yes | snooze | skip]" in msg

    def test_outreach_resume_with_ending(self) -> None:
        msg = outreach_resume("disney_plus", ending_service="netflix")
        assert "Disney+" in msg
        assert "Netflix" in msg
        assert "ending soon" in msg

    def test_outreach_resume_without_ending(self) -> None:
        msg = outreach_resume("max")
        assert "Max" in msg
        assert "[yes | snooze | skip]" in msg

    def test_last_chance(self) -> None:
        msg = last_chance("paramount", 4)
        assert "Paramount+" in msg
        assert "4 days" in msg

    def test_outreach_followup(self) -> None:
        msg = outreach_followup("peacock")
        assert "Peacock" in msg
        assert "[yes | snooze | skip]" in msg


# ---------------------------------------------------------------------------
# OTP flow
# ---------------------------------------------------------------------------


class TestOtpFlow:
    def test_otp_confirm(self) -> None:
        msg = otp_confirm("netflix", "cancel")
        assert "OTP" in msg
        assert "2 minutes" in msg

    def test_executing_cancel(self) -> None:
        msg = executing("netflix", "cancel")
        assert "Cancelling" in msg
        assert "Netflix" in msg

    def test_executing_resume(self) -> None:
        msg = executing("hulu", "resume")
        assert "Resuming" in msg
        assert "Hulu" in msg

    def test_otp_needed_default(self) -> None:
        msg = otp_needed("netflix")
        assert "Netflix" in msg
        assert "verification code" in msg

    def test_otp_needed_custom(self) -> None:
        msg = otp_needed("netflix", prompt="Enter the 6-digit code from your email")
        assert "Netflix" in msg
        assert "Enter the 6-digit code from your email" in msg
        assert "What's the code?" in msg

    def test_otp_received(self) -> None:
        msg = otp_received()
        assert "Got it" in msg

    def test_otp_timeout(self) -> None:
        msg = otp_timeout()
        assert "15 minutes" in msg
        assert "cancelled" in msg


# ---------------------------------------------------------------------------
# Credential flow
# ---------------------------------------------------------------------------


class TestCredentialFlow:
    def test_credential_needed_cvv(self) -> None:
        msg = credential_needed("disney_plus", "cvv")
        assert "Disney+" in msg
        assert "CVV" in msg or "security code" in msg

    def test_credential_needed_zip(self) -> None:
        msg = credential_needed("netflix", "zip")
        assert "Netflix" in msg
        assert "ZIP" in msg

    def test_credential_needed_unknown(self) -> None:
        msg = credential_needed("hulu", "ssn")
        assert "Hulu" in msg
        assert "ssn" in msg

    def test_credential_received(self) -> None:
        msg = credential_received()
        assert "Got it" in msg


# ---------------------------------------------------------------------------
# Result
# ---------------------------------------------------------------------------


class TestResult:
    def test_action_success_cancel_with_date(self) -> None:
        msg = action_success_cancel("netflix", "March 15")
        assert "Netflix" in msg
        assert "cancelled" in msg
        assert "March 15" in msg

    def test_action_success_cancel_no_date(self) -> None:
        msg = action_success_cancel("netflix", None)
        assert "Netflix" in msg
        assert "cancelled" in msg
        assert "through" not in msg

    def test_action_success_resume(self) -> None:
        msg = action_success_resume("hulu")
        assert "Hulu" in msg
        assert "reactivated" in msg

    def test_action_failed_cancel(self) -> None:
        msg = action_failed_cancel("netflix")
        assert "Failed to cancel Netflix" in msg
        assert "notified" in msg

    def test_action_failed_cancel_no_internal_details(self) -> None:
        """Cancel failure message must never contain internal error details."""
        msg = action_failed_cancel("netflix")
        assert "Error:" not in msg

    def test_action_failed_resume(self) -> None:
        msg = action_failed_resume("disney_plus")
        assert "Disney+" in msg
        assert "resume" in msg

    def test_action_failed_unified(self) -> None:
        from messages import action_failed
        msg = action_failed("netflix", "cancel")
        assert "Failed to cancel Netflix" in msg
        assert "\U0001f916" in msg


# ---------------------------------------------------------------------------
# Payment
# ---------------------------------------------------------------------------


class TestPayment:
    def test_invoice_returns_two_messages(self) -> None:
        parts = invoice(3000, "lnbc3000...")
        assert isinstance(parts, list)
        assert len(parts) == 2
        assert "3,000 sats" in parts[0]
        assert "Zap" in parts[0]
        assert parts[1] == "lnbc3000..."

    def test_invoice_large_amount(self) -> None:
        parts = invoice(1_000_000, "lnbc1m...")
        assert "1,000,000 sats" in parts[0]
        assert parts[1] == "lnbc1m..."

    def test_payment_received(self) -> None:
        msg = payment_received(3000)
        assert "pleasure" in msg

    def test_payment_expired(self) -> None:
        msg = payment_expired("netflix", 3000)
        assert "Netflix" in msg
        assert "3,000 sats" in msg
        assert "expired" in msg

    def test_debt_block(self) -> None:
        msg = debt_block(6000)
        assert "6,000 sats" in msg
        assert "pay" in msg.lower()


# ---------------------------------------------------------------------------
# Welcome / help / misc
# ---------------------------------------------------------------------------


class TestMisc:
    def test_welcome(self) -> None:
        msg = welcome(["netflix", "hulu", "disney_plus"])
        assert "Netflix" in msg
        assert "Hulu" in msg
        assert "Disney+" in msg
        assert "[yes | no]" in msg

    def test_help_text(self) -> None:
        msg = help_text()
        assert "cancel" in msg
        assert "resume" in msg
        assert "status" in msg
        assert "login" in msg
        assert "queue" not in msg
        assert "help" not in msg
        assert "3,000 sats" in msg

    def test_help_text_custom_price(self) -> None:
        msg = help_text(action_price_sats=5000)
        assert "5,000 sats" in msg
        assert "3,000" not in msg

    def test_busy_generic(self) -> None:
        msg = busy()
        assert "finish" in msg.lower()

    def test_busy_with_job(self) -> None:
        msg = busy("netflix", "cancel")
        assert "cancelling Netflix" in msg

    def test_busy_resume(self) -> None:
        msg = busy("hulu", "resume")
        assert "resuming Hulu" in msg

    def test_waitlist_added(self) -> None:
        assert "waitlist" in waitlist_added().lower()

    def test_waitlist_already(self) -> None:
        assert "already" in waitlist_already().lower()

    def test_waitlist_invited(self) -> None:
        msg = waitlist_invited("https://unsaltedbutter.ai")
        assert "https://unsaltedbutter.ai/login" in msg

    def test_login_code_returns_two_messages(self) -> None:
        result = login_code("123456789012", "https://unsaltedbutter.ai")
        assert isinstance(result, list)
        assert len(result) == 2
        # First message is the formatted code only
        assert result[0] == "123456-789012"
        # Second message is the URL with code only
        assert result[1] == "https://unsaltedbutter.ai/login?code=123456-789012"

    def test_not_registered(self) -> None:
        msg = not_registered("https://unsaltedbutter.ai")
        assert "https://unsaltedbutter.ai/login" in msg

    def test_invite_dm(self) -> None:
        msg = invite_dm("https://unsaltedbutter.ai")
        assert "https://unsaltedbutter.ai/login" in msg

    def test_already_has_account(self) -> None:
        assert "already" in already_has_account().lower()

    def test_user_skip_ack(self) -> None:
        msg = user_skip_ack("netflix")
        assert "Netflix" in msg
        assert "Skipping" in msg

    def test_user_snooze_ack(self) -> None:
        msg = user_snooze_ack()
        assert "48 hours" in msg

    def test_session_cancelled(self) -> None:
        assert session_cancelled() == "Cancelled."

    def test_unknown_service(self) -> None:
        msg = unknown_service("foobar")
        assert "foobar" in msg
        assert "netflix" in msg

    def test_queued(self) -> None:
        msg = queued("netflix", "cancel", queue_pos=3)
        assert "Netflix" in msg
        assert "cancelling" in msg
        assert "4 minutes" in msg

    def test_action_starting(self) -> None:
        msg = action_starting("netflix", "cancel")
        assert "Cancelling" in msg
        assert "Netflix" in msg
        assert "OTP" in msg

    def test_action_starting_resume(self) -> None:
        msg = action_starting("hulu", "resume")
        assert "Resuming" in msg
        assert "Hulu" in msg

    def test_no_credentials(self) -> None:
        msg = no_credentials("netflix", "https://unsaltedbutter.ai")
        assert "Netflix" in msg
        assert "https://unsaltedbutter.ai/login" in msg

    def test_error_generic(self) -> None:
        assert "wrong" in error_generic().lower()

    def test_operator_job_failed(self) -> None:
        msg = operator_job_failed("abcdef12-3456-7890", "netflix", "Timeout")
        assert "abcdef12" in msg
        assert "Netflix" in msg
        assert "Timeout" in msg

    def test_operator_job_failed_no_error(self) -> None:
        msg = operator_job_failed("abcdef12-3456-7890", "netflix", None)
        assert "Error" not in msg

    def test_operator_agent_down(self) -> None:
        msg = operator_agent_down(10)
        assert "10 minutes" in msg
        assert "Mac Mini" in msg


# ---------------------------------------------------------------------------
# Global: no em dashes anywhere
# ---------------------------------------------------------------------------


class TestNoEmDashes:
    def test_no_em_dashes(self) -> None:
        """Scan every public function in messages module; no output may contain U+2014."""
        em_dash = "\u2014"
        failures: list[str] = []

        for name, func in inspect.getmembers(messages_module, inspect.isfunction):
            if name.startswith("_"):
                continue

            sig = inspect.signature(func)
            args: list[object] = []
            for param in sig.parameters.values():
                if param.annotation in (str, "str"):
                    args.append("test_value")
                elif param.annotation in (int, "int"):
                    args.append(42)
                elif param.annotation in ("str | None",):
                    args.append("test_value")
                elif param.annotation in ("list[str]",):
                    args.append(["netflix", "hulu"])
                else:
                    args.append("test_value")

            try:
                result = func(*args)
            except Exception:
                continue

            texts = result if isinstance(result, list) else [result]
            for text in texts:
                if isinstance(text, str) and em_dash in text:
                    failures.append(f"{name}: contains em dash")

        assert not failures, f"Em dashes found in: {failures}"
