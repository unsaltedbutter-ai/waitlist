"""Tests for the per-user conversation state machine (session.py)."""

from __future__ import annotations

from dataclasses import dataclass
from unittest.mock import AsyncMock

import pytest
import pytest_asyncio

from db import Database
from session import (
    Session,
    IDLE,
    OTP_CONFIRM,
    EXECUTING,
    AWAITING_OTP,
    AWAITING_CREDENTIAL,
    INVOICE_SENT,
)
from timers import TimerQueue, OTP_TIMEOUT, PAYMENT_EXPIRY


# ------------------------------------------------------------------
# Helpers
# ------------------------------------------------------------------


def _make_job(
    job_id: str = "job-1",
    user_npub: str = "npub1alice",
    service_id: str = "netflix",
    action: str = "cancel",
    trigger: str = "outreach",
    status: str = "dispatched",
    created_at: str = "2026-02-18T10:00:00",
    **overrides,
) -> dict:
    base = {
        "id": job_id,
        "user_npub": user_npub,
        "service_id": service_id,
        "action": action,
        "trigger": trigger,
        "status": status,
        "billing_date": None,
        "access_end_date": None,
        "outreach_count": 0,
        "next_outreach_at": None,
        "amount_sats": None,
        "invoice_id": None,
        "created_at": created_at,
        "updated_at": created_at,
    }
    base.update(overrides)
    return base


@dataclass(frozen=True)
class FakeConfig:
    action_price_sats: int = 3000
    otp_timeout_seconds: int = 900
    payment_expiry_seconds: int = 86400
    base_url: str = "https://unsaltedbutter.ai"


# ------------------------------------------------------------------
# Fixtures
# ------------------------------------------------------------------


@pytest_asyncio.fixture
async def db():
    database = Database(":memory:")
    await database.connect()
    yield database
    await database.close()


@pytest_asyncio.fixture
async def timers(db: Database):
    queue = TimerQueue(db, tick_seconds=1)
    yield queue
    await queue.stop()


@pytest_asyncio.fixture
async def deps(db, timers):
    """Return a dict of all Session dependencies with mocks where needed."""
    api = AsyncMock()
    agent = AsyncMock()
    send_dm = AsyncMock()
    send_operator_dm = AsyncMock()
    config = FakeConfig()

    session = Session(
        db=db,
        api=api,
        agent=agent,
        timers=timers,
        config=config,
        send_dm=send_dm,
        send_operator_dm=send_operator_dm,
    )
    return {
        "session": session,
        "db": db,
        "api": api,
        "agent": agent,
        "timers": timers,
        "send_dm": send_dm,
        "send_operator_dm": send_operator_dm,
        "config": config,
    }


# ------------------------------------------------------------------
# get_state / is_busy
# ------------------------------------------------------------------


@pytest.mark.asyncio
async def test_get_state_no_session(deps):
    s = deps["session"]
    assert await s.get_state("npub1alice") == IDLE


@pytest.mark.asyncio
async def test_get_state_with_session(deps):
    s = deps["session"]
    db = deps["db"]
    await db.upsert_session("npub1alice", EXECUTING, job_id="job-1")
    assert await s.get_state("npub1alice") == EXECUTING


@pytest.mark.asyncio
async def test_is_busy_false_when_idle(deps):
    s = deps["session"]
    assert await s.is_busy("npub1alice") is False


@pytest.mark.asyncio
async def test_is_busy_true_when_executing(deps):
    s = deps["session"]
    db = deps["db"]
    await db.upsert_session("npub1alice", EXECUTING, job_id="job-1")
    assert await s.is_busy("npub1alice") is True


# ------------------------------------------------------------------
# handle_yes: IDLE -> EXECUTING (skips OTP_CONFIRM)
# ------------------------------------------------------------------


@pytest.mark.asyncio
async def test_handle_yes(deps):
    s = deps["session"]
    db = deps["db"]
    api = deps["api"]
    agent = deps["agent"]
    send_dm = deps["send_dm"]

    await db.upsert_job(_make_job())
    api.get_credentials.return_value = {"email": "a@b.com", "password": "pw"}
    agent.execute.return_value = True

    await s.handle_yes("npub1alice", "job-1")

    # Session should go straight to EXECUTING
    session = await db.get_session("npub1alice")
    assert session is not None
    assert session["state"] == EXECUTING
    assert session["job_id"] == "job-1"

    # Agent dispatched
    agent.execute.assert_awaited_once()

    # DM sent (executing message)
    send_dm.assert_awaited_once()
    msg = send_dm.call_args[0][1]
    assert "Cancelling" in msg or "Netflix" in msg


@pytest.mark.asyncio
async def test_handle_yes_no_credentials(deps):
    """If no creds on file, send no_credentials DM."""
    s = deps["session"]
    db = deps["db"]
    api = deps["api"]
    send_dm = deps["send_dm"]

    await db.upsert_job(_make_job())
    api.get_credentials.return_value = None

    await s.handle_yes("npub1alice", "job-1")

    # No session created
    assert await db.get_session("npub1alice") is None
    send_dm.assert_awaited_once()
    msg = send_dm.call_args[0][1]
    assert "credentials" in msg.lower() or "login" in msg.lower()


@pytest.mark.asyncio
async def test_handle_yes_job_not_found(deps):
    """If the job doesn't exist locally, send error."""
    s = deps["session"]
    db = deps["db"]
    send_dm = deps["send_dm"]

    await s.handle_yes("npub1alice", "nonexistent-job")

    assert await db.get_session("npub1alice") is None
    send_dm.assert_awaited_once()
    msg = send_dm.call_args[0][1]
    assert "wrong" in msg.lower() or "try again" in msg.lower()


# ------------------------------------------------------------------
# handle_otp_confirm_yes: OTP_CONFIRM -> EXECUTING
# ------------------------------------------------------------------


@pytest.mark.asyncio
async def test_otp_confirm_yes_happy_path(deps):
    s = deps["session"]
    db = deps["db"]
    api = deps["api"]
    agent = deps["agent"]
    send_dm = deps["send_dm"]

    await db.upsert_job(_make_job())
    await db.upsert_session("npub1alice", OTP_CONFIRM, job_id="job-1")

    api.get_credentials.return_value = {"email": "a@b.com", "password": "pw"}
    agent.execute.return_value = True

    await s.handle_otp_confirm_yes("npub1alice")

    # Session should be EXECUTING
    session = await db.get_session("npub1alice")
    assert session["state"] == EXECUTING

    # Job should be active locally
    job = await db.get_job("job-1")
    assert job["status"] == "active"

    # VPS job status updated
    api.update_job_status.assert_awaited_once_with("job-1", "active")

    # Agent dispatched with credentials
    agent.execute.assert_awaited_once_with(
        "job-1", "netflix", "cancel", {"email": "a@b.com", "pass": "pw"},
        plan_id=None,
    )

    # DM sent (executing message)
    assert send_dm.await_count == 1
    msg = send_dm.call_args[0][1]
    assert "Cancelling" in msg or "Netflix" in msg


@pytest.mark.asyncio
async def test_otp_confirm_yes_resume_passes_plan_id(deps):
    """Resume jobs should pass plan_id to agent.execute()."""
    s = deps["session"]
    db = deps["db"]
    api = deps["api"]
    agent = deps["agent"]

    await db.upsert_job(_make_job(action="resume", plan_id="netflix_premium"))
    await db.upsert_session("npub1alice", OTP_CONFIRM, job_id="job-1")

    api.get_credentials.return_value = {"email": "a@b.com", "password": "pw"}
    agent.execute.return_value = True

    await s.handle_otp_confirm_yes("npub1alice")

    agent.execute.assert_awaited_once_with(
        "job-1", "netflix", "resume", {"email": "a@b.com", "pass": "pw"},
        plan_id="netflix_premium",
    )


@pytest.mark.asyncio
async def test_otp_confirm_yes_no_credentials(deps):
    """If no creds on file, send no_credentials DM and delete session."""
    s = deps["session"]
    db = deps["db"]
    api = deps["api"]
    send_dm = deps["send_dm"]

    await db.upsert_job(_make_job())
    await db.upsert_session("npub1alice", OTP_CONFIRM, job_id="job-1")

    api.get_credentials.return_value = None

    await s.handle_otp_confirm_yes("npub1alice")

    # Session deleted
    assert await db.get_session("npub1alice") is None

    # DM tells user to add credentials
    send_dm.assert_awaited_once()
    msg = send_dm.call_args[0][1]
    assert "credentials" in msg.lower() or "No credentials" in msg


@pytest.mark.asyncio
async def test_otp_confirm_yes_agent_rejects(deps):
    """If agent rejects the job, handle as failure."""
    s = deps["session"]
    db = deps["db"]
    api = deps["api"]
    agent = deps["agent"]
    send_dm = deps["send_dm"]
    send_op = deps["send_operator_dm"]

    await db.upsert_job(_make_job())
    await db.upsert_session("npub1alice", OTP_CONFIRM, job_id="job-1")

    api.get_credentials.return_value = {"email": "a@b.com", "password": "pw"}
    agent.execute.return_value = False

    await s.handle_otp_confirm_yes("npub1alice")

    # Session deleted (failure -> IDLE)
    assert await db.get_session("npub1alice") is None

    # Job status is failed
    job = await db.get_job("job-1")
    assert job["status"] == "failed"

    # User was DM'd about failure (cancel action)
    assert send_dm.await_count >= 2  # executing msg + failure msg
    # Operator was notified (error msg + npub in separate bubble)
    assert send_op.await_count == 2


@pytest.mark.asyncio
async def test_otp_confirm_yes_wrong_state(deps):
    """If session is not in OTP_CONFIRM, do nothing."""
    s = deps["session"]
    db = deps["db"]
    send_dm = deps["send_dm"]

    await db.upsert_session("npub1alice", EXECUTING, job_id="job-1")
    await s.handle_otp_confirm_yes("npub1alice")

    # No DM sent, session unchanged
    send_dm.assert_not_awaited()


# ------------------------------------------------------------------
# handle_otp_confirm_no: OTP_CONFIRM -> IDLE
# ------------------------------------------------------------------


@pytest.mark.asyncio
async def test_otp_confirm_no(deps):
    s = deps["session"]
    db = deps["db"]
    send_dm = deps["send_dm"]

    await db.upsert_session("npub1alice", OTP_CONFIRM, job_id="job-1")
    await s.handle_otp_confirm_no("npub1alice")

    assert await db.get_session("npub1alice") is None
    send_dm.assert_awaited_once()
    msg = send_dm.call_args[0][1]
    assert "Cancelled" in msg


# ------------------------------------------------------------------
# handle_otp_needed: EXECUTING -> AWAITING_OTP
# ------------------------------------------------------------------


@pytest.mark.asyncio
async def test_otp_needed(deps):
    s = deps["session"]
    db = deps["db"]
    send_dm = deps["send_dm"]

    await db.upsert_session("npub1alice", EXECUTING, job_id="job-1")
    await s.handle_otp_needed("job-1", "netflix", "Enter the 6-digit code")

    session = await db.get_session("npub1alice")
    assert session["state"] == AWAITING_OTP

    send_dm.assert_awaited_once()
    msg = send_dm.call_args[0][1]
    assert "code" in msg.lower()


@pytest.mark.asyncio
async def test_otp_needed_no_session(deps):
    """If no session for this job, log warning and do nothing."""
    s = deps["session"]
    send_dm = deps["send_dm"]

    await s.handle_otp_needed("nonexistent-job", "netflix", None)
    send_dm.assert_not_awaited()


# ------------------------------------------------------------------
# handle_otp_input: AWAITING_OTP -> EXECUTING
# ------------------------------------------------------------------


@pytest.mark.asyncio
async def test_otp_input(deps):
    s = deps["session"]
    db = deps["db"]
    agent = deps["agent"]
    send_dm = deps["send_dm"]

    await db.upsert_session("npub1alice", AWAITING_OTP, job_id="job-1")
    await s.handle_otp_input("npub1alice", "123456")

    # State transitions to EXECUTING
    session = await db.get_session("npub1alice")
    assert session["state"] == EXECUTING
    assert session["otp_attempts"] == 1

    # OTP relayed to agent
    agent.relay_otp.assert_awaited_once_with("job-1", "123456")

    # DM acknowledgement
    send_dm.assert_awaited_once()
    msg = send_dm.call_args[0][1]
    assert "code" in msg.lower() or "Got it" in msg


@pytest.mark.asyncio
async def test_otp_input_does_not_double_log(deps):
    """handle_otp_input must NOT write its own log entry.

    The inbound message is already logged by nostr_handler (with automatic
    OTP redaction in db.log_message). A second log call here would create
    a duplicate row.
    """
    s = deps["session"]
    db = deps["db"]

    await db.upsert_session("npub1alice", AWAITING_OTP, job_id="job-1")
    await s.handle_otp_input("npub1alice", "987654")

    log_entries = await db.get_messages("npub1alice")
    assert len(log_entries) == 0  # session.py no longer writes to message_log


@pytest.mark.asyncio
async def test_otp_input_increments_attempts(deps):
    """Each OTP input should increment the otp_attempts counter."""
    s = deps["session"]
    db = deps["db"]

    await db.upsert_session(
        "npub1alice", AWAITING_OTP, job_id="job-1", otp_attempts=2
    )
    await s.handle_otp_input("npub1alice", "111111")

    session = await db.get_session("npub1alice")
    assert session["otp_attempts"] == 3


@pytest.mark.asyncio
async def test_otp_input_wrong_state(deps):
    """If not in AWAITING_OTP, do nothing."""
    s = deps["session"]
    db = deps["db"]
    agent = deps["agent"]

    await db.upsert_session("npub1alice", EXECUTING, job_id="job-1")
    await s.handle_otp_input("npub1alice", "123456")

    agent.relay_otp.assert_not_awaited()


# ------------------------------------------------------------------
# handle_credential_needed: EXECUTING -> AWAITING_CREDENTIAL
# ------------------------------------------------------------------


@pytest.mark.asyncio
async def test_credential_needed(deps):
    s = deps["session"]
    db = deps["db"]
    send_dm = deps["send_dm"]

    await db.upsert_session("npub1alice", EXECUTING, job_id="job-1")
    await s.handle_credential_needed("job-1", "disney_plus", "cvv")

    session = await db.get_session("npub1alice")
    assert session["state"] == "AWAITING_CREDENTIAL"

    send_dm.assert_awaited_once()
    msg = send_dm.call_args[0][1]
    assert "CVV" in msg or "security code" in msg


@pytest.mark.asyncio
async def test_credential_needed_no_session(deps):
    """If no session for this job, log warning and do nothing."""
    s = deps["session"]
    send_dm = deps["send_dm"]

    await s.handle_credential_needed("nonexistent-job", "netflix", "cvv")
    send_dm.assert_not_awaited()


# ------------------------------------------------------------------
# handle_credential_input: AWAITING_CREDENTIAL -> EXECUTING
# ------------------------------------------------------------------


@pytest.mark.asyncio
async def test_credential_input(deps):
    s = deps["session"]
    db = deps["db"]
    agent = deps["agent"]
    send_dm = deps["send_dm"]

    await db.upsert_session("npub1alice", EXECUTING, job_id="job-1")
    # Simulate credential needed first (sets internal state)
    await s.handle_credential_needed("job-1", "disney_plus", "cvv")
    send_dm.reset_mock()

    await db.upsert_session(
        "npub1alice", "AWAITING_CREDENTIAL", job_id="job-1"
    )
    await s.handle_credential_input("npub1alice", "123")

    # State transitions to EXECUTING
    session = await db.get_session("npub1alice")
    assert session["state"] == EXECUTING

    # Agent was told to relay the credential
    agent.relay_credential.assert_awaited_once_with("job-1", "cvv", "123")

    # DM acknowledgement sent
    send_dm.assert_awaited_once()
    msg = send_dm.call_args[0][1]
    assert "Got it" in msg


@pytest.mark.asyncio
async def test_credential_input_wrong_state(deps):
    """If not in AWAITING_CREDENTIAL, do nothing."""
    s = deps["session"]
    db = deps["db"]
    agent = deps["agent"]

    await db.upsert_session("npub1alice", EXECUTING, job_id="job-1")
    await s.handle_credential_input("npub1alice", "123")

    agent.relay_credential.assert_not_awaited()


# ------------------------------------------------------------------
# handle_result: success
# ------------------------------------------------------------------


@pytest.mark.asyncio
async def test_result_success_cancel(deps):
    s = deps["session"]
    db = deps["db"]
    api = deps["api"]
    send_dm = deps["send_dm"]

    await db.upsert_job(_make_job(action="cancel"))
    await db.upsert_session("npub1alice", EXECUTING, job_id="job-1")

    api.create_invoice.return_value = {
        "invoice_id": "inv-1",
        "bolt11": "lnbc3000...",
        "amount_sats": 3000,
    }

    await s.handle_result(
        job_id="job-1",
        success=True,
        access_end_date="2026-03-15",
        error=None,
        duration_seconds=45,
    )

    # Session is INVOICE_SENT
    session = await db.get_session("npub1alice")
    assert session["state"] == INVOICE_SENT

    # Job has invoice_id and amount
    job = await db.get_job("job-1")
    assert job["invoice_id"] == "inv-1"
    assert job["amount_sats"] == 3000
    assert job["access_end_date"] == "2026-03-15"

    # User got two DMs: success + invoice
    assert send_dm.await_count == 2
    success_msg = send_dm.call_args_list[0][0][1]
    invoice_msg = send_dm.call_args_list[1][0][1]
    assert "cancelled" in success_msg.lower() or "Netflix" in success_msg
    assert "3,000" in invoice_msg or "lnbc" in invoice_msg


@pytest.mark.asyncio
async def test_result_success_resume(deps):
    s = deps["session"]
    db = deps["db"]
    api = deps["api"]
    send_dm = deps["send_dm"]

    await db.upsert_job(_make_job(action="resume"))
    await db.upsert_session("npub1alice", EXECUTING, job_id="job-1")

    api.create_invoice.return_value = {
        "invoice_id": "inv-2",
        "bolt11": "lnbc3000resume...",
        "amount_sats": 3000,
    }

    await s.handle_result(
        job_id="job-1",
        success=True,
        access_end_date=None,
        error=None,
        duration_seconds=30,
    )

    session = await db.get_session("npub1alice")
    assert session["state"] == INVOICE_SENT

    # First DM should be resume success
    success_msg = send_dm.call_args_list[0][0][1]
    assert "reactivated" in success_msg.lower() or "live" in success_msg.lower()


# ------------------------------------------------------------------
# handle_result: failure
# ------------------------------------------------------------------


@pytest.mark.asyncio
async def test_result_failure_cancel(deps):
    """Cancel failure: DM user immediately (constraint #11), notify operator."""
    s = deps["session"]
    db = deps["db"]
    api = deps["api"]
    send_dm = deps["send_dm"]
    send_op = deps["send_operator_dm"]

    await db.upsert_job(_make_job(action="cancel"))
    await db.upsert_session("npub1alice", EXECUTING, job_id="job-1")

    await s.handle_result(
        job_id="job-1",
        success=False,
        access_end_date=None,
        error="Login page changed",
        duration_seconds=60,
    )

    # Session deleted (back to IDLE)
    assert await db.get_session("npub1alice") is None

    # Job status is failed
    job = await db.get_job("job-1")
    assert job["status"] == "failed"

    # User gets failure DM
    send_dm.assert_awaited_once()
    msg = send_dm.call_args[0][1]
    assert "Failed" in msg or "failed" in msg
    assert "notified" in msg.lower()

    # Operator notified (error msg + npub in separate bubbles)
    assert send_op.await_count == 2
    op_msg = send_op.call_args_list[0][0][0]
    assert "failed" in op_msg.lower() or "Failed" in op_msg
    assert send_op.call_args_list[1][0][0] == "npub1alice"


@pytest.mark.asyncio
async def test_result_failure_resume(deps):
    """Resume failure: still DM user (less urgent), notify operator."""
    s = deps["session"]
    db = deps["db"]
    api = deps["api"]
    send_dm = deps["send_dm"]
    send_op = deps["send_operator_dm"]

    await db.upsert_job(_make_job(action="resume"))
    await db.upsert_session("npub1alice", EXECUTING, job_id="job-1")

    await s.handle_result(
        job_id="job-1",
        success=False,
        access_end_date=None,
        error="Timeout on resume page",
        duration_seconds=120,
    )

    # Session deleted
    assert await db.get_session("npub1alice") is None

    # User DM uses failure message
    send_dm.assert_awaited_once()
    msg = send_dm.call_args[0][1]
    assert "failed" in msg.lower()
    assert "notified" in msg.lower()

    # Operator still notified (error msg + npub in separate bubbles)
    assert send_op.await_count == 2
    op_msg = send_op.call_args_list[0][0][0]
    assert "failed" in op_msg.lower() or "Failed" in op_msg
    assert send_op.call_args_list[1][0][0] == "npub1alice"


@pytest.mark.asyncio
async def test_result_failure_credential_invalid_dm(deps):
    """When error_code='credential_invalid', user DM says credentials were rejected."""
    s = deps["session"]
    db = deps["db"]
    api = deps["api"]
    send_dm = deps["send_dm"]

    await db.upsert_job(_make_job(action="cancel"))
    await db.upsert_session("npub1alice", EXECUTING, job_id="job-1")

    await s.handle_result(
        job_id="job-1",
        success=False,
        access_end_date=None,
        error="Sign-in failed: credentials rejected by service",
        duration_seconds=30,
        error_code="credential_invalid",
    )

    # Session deleted (back to IDLE)
    assert await db.get_session("npub1alice") is None

    # User gets credential-specific failure DM
    send_dm.assert_awaited_once()
    msg = send_dm.call_args[0][1]
    assert "credentials were rejected" in msg
    # Should NOT contain the generic "notified our human" text
    assert "notified" not in msg.lower()


@pytest.mark.asyncio
async def test_result_failure_generic_dm_unchanged(deps):
    """When error_code=None, user DM is the existing generic message."""
    s = deps["session"]
    db = deps["db"]
    api = deps["api"]
    send_dm = deps["send_dm"]

    await db.upsert_job(_make_job(action="cancel"))
    await db.upsert_session("npub1alice", EXECUTING, job_id="job-1")

    await s.handle_result(
        job_id="job-1",
        success=False,
        access_end_date=None,
        error="Login page changed",
        duration_seconds=60,
        error_code=None,
    )

    # User gets generic failure DM
    send_dm.assert_awaited_once()
    msg = send_dm.call_args[0][1]
    assert "notified" in msg.lower()
    assert "credentials" not in msg.lower()


@pytest.mark.asyncio
async def test_result_failure_updates_vps(deps):
    """Failure should update VPS job status to 'failed'."""
    s = deps["session"]
    db = deps["db"]
    api = deps["api"]

    await db.upsert_job(_make_job())
    await db.upsert_session("npub1alice", EXECUTING, job_id="job-1")

    await s.handle_result(
        job_id="job-1",
        success=False,
        access_end_date=None,
        error="oops",
        duration_seconds=10,
    )

    api.update_job_status.assert_awaited_once_with("job-1", "failed")


# ------------------------------------------------------------------
# handle_payment_received: INVOICE_SENT -> IDLE
# ------------------------------------------------------------------


@pytest.mark.asyncio
async def test_payment_received(deps):
    s = deps["session"]
    db = deps["db"]
    send_dm = deps["send_dm"]

    await db.upsert_job(_make_job(status="active"))
    await db.upsert_session("npub1alice", INVOICE_SENT, job_id="job-1")

    await s.handle_payment_received("job-1", 3000)

    # Session deleted
    assert await db.get_session("npub1alice") is None

    # Local job updated
    job = await db.get_job("job-1")
    assert job["status"] == "completed_paid"

    # DM thanks
    send_dm.assert_awaited_once()
    msg = send_dm.call_args[0][1]
    assert "3,000" in msg


# ------------------------------------------------------------------
# handle_payment_expired: INVOICE_SENT -> IDLE
# ------------------------------------------------------------------


@pytest.mark.asyncio
async def test_payment_expired(deps):
    s = deps["session"]
    db = deps["db"]
    api = deps["api"]
    send_dm = deps["send_dm"]

    await db.upsert_job(_make_job(status="active"))
    await db.upsert_session("npub1alice", INVOICE_SENT, job_id="job-1")

    api.get_user.return_value = {"debt_sats": 3000}

    await s.handle_payment_expired("job-1")

    # Session deleted
    assert await db.get_session("npub1alice") is None

    # Local job is completed_reneged
    job = await db.get_job("job-1")
    assert job["status"] == "completed_reneged"

    # VPS updated
    api.update_job_status.assert_awaited_once_with("job-1", "completed_reneged")

    # DM includes debt amount
    send_dm.assert_awaited_once()
    msg = send_dm.call_args[0][1]
    assert "3,000" in msg
    assert "expired" in msg.lower()


# ------------------------------------------------------------------
# handle_otp_timeout: AWAITING_OTP -> IDLE
# ------------------------------------------------------------------


@pytest.mark.asyncio
async def test_otp_timeout(deps):
    s = deps["session"]
    db = deps["db"]
    api = deps["api"]
    agent = deps["agent"]
    send_dm = deps["send_dm"]

    await db.upsert_job(_make_job(status="active"))
    await db.upsert_session("npub1alice", AWAITING_OTP, job_id="job-1")

    await s.handle_otp_timeout("job-1")

    # Session deleted
    assert await db.get_session("npub1alice") is None

    # Agent aborted
    agent.abort.assert_awaited_once_with("job-1")

    # VPS job status: user_abandon
    api.update_job_status.assert_awaited_once_with("job-1", "user_abandon")

    # Local job status
    job = await db.get_job("job-1")
    assert job["status"] == "user_abandon"

    # DM user about timeout
    send_dm.assert_awaited_once()
    msg = send_dm.call_args[0][1]
    assert "15 minutes" in msg or "cancelled" in msg.lower()


@pytest.mark.asyncio
async def test_otp_timeout_wrong_state(deps):
    """If session is not AWAITING_OTP, do nothing."""
    s = deps["session"]
    db = deps["db"]
    agent = deps["agent"]
    send_dm = deps["send_dm"]

    await db.upsert_session("npub1alice", EXECUTING, job_id="job-1")
    await s.handle_otp_timeout("job-1")

    agent.abort.assert_not_awaited()
    send_dm.assert_not_awaited()


# ------------------------------------------------------------------
# cancel_session: force cancel in each state
# ------------------------------------------------------------------


@pytest.mark.asyncio
async def test_cancel_session_otp_confirm(deps):
    """Cancelling from OTP_CONFIRM: just delete session, no agent abort."""
    s = deps["session"]
    db = deps["db"]
    agent = deps["agent"]

    await db.upsert_session("npub1alice", OTP_CONFIRM, job_id="job-1")
    await s.cancel_session("npub1alice")

    assert await db.get_session("npub1alice") is None
    agent.abort.assert_not_awaited()


@pytest.mark.asyncio
async def test_cancel_session_executing(deps):
    """Cancelling from EXECUTING: abort agent, cancel timers, delete session."""
    s = deps["session"]
    db = deps["db"]
    agent = deps["agent"]

    await db.upsert_session("npub1alice", EXECUTING, job_id="job-1")
    await s.cancel_session("npub1alice")

    assert await db.get_session("npub1alice") is None
    agent.abort.assert_awaited_once_with("job-1")


@pytest.mark.asyncio
async def test_cancel_session_awaiting_otp(deps):
    """Cancelling from AWAITING_OTP: abort agent."""
    s = deps["session"]
    db = deps["db"]
    agent = deps["agent"]

    await db.upsert_session("npub1alice", AWAITING_OTP, job_id="job-1")
    await s.cancel_session("npub1alice")

    assert await db.get_session("npub1alice") is None
    agent.abort.assert_awaited_once_with("job-1")


@pytest.mark.asyncio
async def test_cancel_session_invoice_sent(deps):
    """Cancelling from INVOICE_SENT: no agent abort, cancel payment timer."""
    s = deps["session"]
    db = deps["db"]
    agent = deps["agent"]

    await db.upsert_session("npub1alice", INVOICE_SENT, job_id="job-1")
    await s.cancel_session("npub1alice")

    assert await db.get_session("npub1alice") is None
    agent.abort.assert_not_awaited()


@pytest.mark.asyncio
async def test_cancel_session_no_session(deps):
    """Cancelling when no session exists: no-op."""
    s = deps["session"]
    agent = deps["agent"]

    await s.cancel_session("npub1nobody")
    agent.abort.assert_not_awaited()


# ------------------------------------------------------------------
# Busy guard
# ------------------------------------------------------------------


@pytest.mark.asyncio
async def test_busy_guard(deps):
    """While in any non-IDLE state, is_busy should return True."""
    s = deps["session"]
    db = deps["db"]

    for state in (OTP_CONFIRM, EXECUTING, AWAITING_OTP, INVOICE_SENT):
        await db.upsert_session("npub1alice", state, job_id="job-1")
        assert await s.is_busy("npub1alice") is True

    await db.delete_session("npub1alice")
    assert await s.is_busy("npub1alice") is False


# ------------------------------------------------------------------
# Timer scheduling
# ------------------------------------------------------------------


@pytest.mark.asyncio
async def test_otp_confirm_yes_schedules_otp_timeout(deps):
    """After dispatching to agent, an OTP timeout timer should be scheduled."""
    s = deps["session"]
    db = deps["db"]
    api = deps["api"]
    agent = deps["agent"]

    await db.upsert_job(_make_job())
    await db.upsert_session("npub1alice", OTP_CONFIRM, job_id="job-1")
    api.get_credentials.return_value = {"email": "a@b.com", "password": "pw"}
    agent.execute.return_value = True

    await s.handle_otp_confirm_yes("npub1alice")

    # Check that an OTP_TIMEOUT timer was added
    cursor = await db._db.execute(
        "SELECT * FROM timers WHERE timer_type = ? AND target_id = ? AND fired = 0",
        (OTP_TIMEOUT, "job-1"),
    )
    rows = await cursor.fetchall()
    assert len(rows) == 1


@pytest.mark.asyncio
async def test_otp_needed_reschedules_timer(deps):
    """handle_otp_needed should cancel old OTP timer and schedule a new one."""
    s = deps["session"]
    db = deps["db"]
    timers = deps["timers"]

    await db.upsert_session("npub1alice", EXECUTING, job_id="job-1")

    # Pre-schedule an OTP timeout
    await timers.schedule_delay(OTP_TIMEOUT, "job-1", 999)

    await s.handle_otp_needed("job-1", "netflix", None)

    # Old timer cancelled, new one scheduled
    cursor = await db._db.execute(
        "SELECT * FROM timers WHERE timer_type = ? AND target_id = ? AND fired = 0",
        (OTP_TIMEOUT, "job-1"),
    )
    rows = await cursor.fetchall()
    assert len(rows) == 1  # exactly one (new) timer


@pytest.mark.asyncio
async def test_otp_input_cancels_timeout_timer(deps):
    """When user provides OTP, the timeout timer should be cancelled."""
    s = deps["session"]
    db = deps["db"]
    timers = deps["timers"]

    await db.upsert_session("npub1alice", AWAITING_OTP, job_id="job-1")
    await timers.schedule_delay(OTP_TIMEOUT, "job-1", 900)

    await s.handle_otp_input("npub1alice", "123456")

    cursor = await db._db.execute(
        "SELECT * FROM timers WHERE timer_type = ? AND target_id = ? AND fired = 0",
        (OTP_TIMEOUT, "job-1"),
    )
    rows = await cursor.fetchall()
    assert len(rows) == 0


@pytest.mark.asyncio
async def test_result_success_schedules_payment_expiry(deps):
    """Successful result should schedule a payment expiry timer."""
    s = deps["session"]
    db = deps["db"]
    api = deps["api"]

    await db.upsert_job(_make_job())
    await db.upsert_session("npub1alice", EXECUTING, job_id="job-1")

    api.create_invoice.return_value = {
        "invoice_id": "inv-1",
        "bolt11": "lnbc...",
        "amount_sats": 3000,
    }

    await s.handle_result("job-1", True, None, None, 30)

    cursor = await db._db.execute(
        "SELECT * FROM timers WHERE timer_type = ? AND target_id = ? AND fired = 0",
        (PAYMENT_EXPIRY, "job-1"),
    )
    rows = await cursor.fetchall()
    assert len(rows) == 1


@pytest.mark.asyncio
async def test_payment_received_cancels_expiry_timer(deps):
    """Payment received should cancel the payment expiry timer."""
    s = deps["session"]
    db = deps["db"]
    timers = deps["timers"]

    await db.upsert_job(_make_job(status="active"))
    await db.upsert_session("npub1alice", INVOICE_SENT, job_id="job-1")
    await timers.schedule_delay(PAYMENT_EXPIRY, "job-1", 86400)

    await s.handle_payment_received("job-1", 3000)

    cursor = await db._db.execute(
        "SELECT * FROM timers WHERE timer_type = ? AND target_id = ? AND fired = 0",
        (PAYMENT_EXPIRY, "job-1"),
    )
    rows = await cursor.fetchall()
    assert len(rows) == 0


# ------------------------------------------------------------------
# Edge: handle_result cancels OTP timer
# ------------------------------------------------------------------


@pytest.mark.asyncio
async def test_result_cancels_otp_timer(deps):
    """handle_result should cancel OTP timeout (in case result arrives from AWAITING_OTP)."""
    s = deps["session"]
    db = deps["db"]
    api = deps["api"]
    timers = deps["timers"]

    await db.upsert_job(_make_job())
    await db.upsert_session("npub1alice", AWAITING_OTP, job_id="job-1")
    await timers.schedule_delay(OTP_TIMEOUT, "job-1", 900)

    api.create_invoice.return_value = {
        "invoice_id": "inv-1",
        "bolt11": "lnbc...",
        "amount_sats": 3000,
    }

    await s.handle_result("job-1", True, None, None, 30)

    cursor = await db._db.execute(
        "SELECT * FROM timers WHERE timer_type = ? AND target_id = ? AND fired = 0",
        (OTP_TIMEOUT, "job-1"),
    )
    rows = await cursor.fetchall()
    assert len(rows) == 0
