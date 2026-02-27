"""Tests for inbound push notification handling (notifications.py)."""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from unittest.mock import AsyncMock

import pytest

from notifications import NotificationHandler, parse_push


# ------------------------------------------------------------------
# Helpers
# ------------------------------------------------------------------


@dataclass(frozen=True)
class FakeConfig:
    base_url: str = "https://unsaltedbutter.ai"


def _payload(type_: str, data: dict) -> str:
    """Build a valid push notification JSON string."""
    return json.dumps({"type": type_, "data": data, "timestamp": 1708300000})


# ------------------------------------------------------------------
# Fixtures
# ------------------------------------------------------------------


@pytest.fixture
def session():
    mock = AsyncMock()
    mock.handle_payment_received = AsyncMock()
    mock.handle_payment_expired = AsyncMock()
    return mock


@pytest.fixture
def job_manager():
    mock = AsyncMock()
    mock.poll_and_claim = AsyncMock(return_value=[])
    return mock


@pytest.fixture
def api():
    mock = AsyncMock()
    mock.get_pending_invite_dms = AsyncMock(return_value=[])
    mock.mark_invite_dm_sent = AsyncMock()
    return mock


@pytest.fixture
def send_dm():
    return AsyncMock()


@pytest.fixture
def send_operator_dm():
    return AsyncMock()


@pytest.fixture
def handler(session, job_manager, api, send_dm, send_operator_dm):
    return NotificationHandler(
        session=session,
        job_manager=job_manager,
        api=api,
        config=FakeConfig(),
        send_dm=send_dm,
        send_operator_dm=send_operator_dm,
    )


# ==================================================================
# parse_push
# ==================================================================


class TestParsePush:
    """Tests for the module-level parse_push function."""

    def test_valid_payload(self):
        raw = json.dumps({
            "type": "jobs_ready",
            "data": {"job_ids": ["j1"]},
            "timestamp": 123456,
        })
        result = parse_push(raw)
        assert result is not None
        assert result["type"] == "jobs_ready"
        assert result["data"]["job_ids"] == ["j1"]

    def test_invalid_json(self):
        assert parse_push("not json at all") is None

    def test_empty_string(self):
        assert parse_push("") is None

    def test_none_input(self):
        assert parse_push(None) is None

    def test_valid_json_missing_type(self):
        raw = json.dumps({"data": {"foo": 1}})
        assert parse_push(raw) is None

    def test_valid_json_missing_data(self):
        raw = json.dumps({"type": "jobs_ready"})
        assert parse_push(raw) is None

    def test_non_dict_json_list(self):
        assert parse_push("[1, 2, 3]") is None

    def test_non_dict_json_string(self):
        assert parse_push('"hello"') is None

    def test_non_dict_json_number(self):
        assert parse_push("42") is None

    def test_minimal_valid_payload(self):
        """type + data is enough, timestamp is optional."""
        raw = json.dumps({"type": "new_user", "data": {}})
        result = parse_push(raw)
        assert result is not None
        assert result["type"] == "new_user"


# ==================================================================
# handle_push routing
# ==================================================================


class TestHandlePushRouting:
    """Tests for handle_push dispatching to the correct handler."""

    @pytest.mark.asyncio
    async def test_jobs_ready_triggers_poll_and_claim(self, handler, job_manager):
        msg = _payload("jobs_ready", {"job_ids": ["j1", "j2"]})
        await handler.handle_push(msg)
        job_manager.poll_and_claim.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_payment_received_with_job_id(self, handler, session):
        msg = _payload("payment_received", {
            "npub_hex": "abc123def456",
            "service_name": "netflix",
            "amount_sats": 3000,
            "job_id": "job-99",
        })
        await handler.handle_push(msg)
        session.handle_payment_received.assert_awaited_once_with("job-99", 3000)

    @pytest.mark.asyncio
    async def test_payment_received_custom_amount(self, handler, session):
        msg = _payload("payment_received", {
            "npub_hex": "abc123",
            "service_name": "hulu",
            "amount_sats": 5000,
            "job_id": "job-50",
        })
        await handler.handle_push(msg)
        session.handle_payment_received.assert_awaited_once_with("job-50", 5000)

    @pytest.mark.asyncio
    async def test_payment_received_without_job_id_logs_warning(
        self, handler, session, caplog
    ):
        msg = _payload("payment_received", {
            "npub_hex": "abc123def456",
            "service_name": "netflix",
            "amount_sats": 3000,
        })
        with caplog.at_level(logging.WARNING):
            await handler.handle_push(msg)
        session.handle_payment_received.assert_not_awaited()
        assert "payment_received push without job_id" in caplog.text

    @pytest.mark.asyncio
    async def test_payment_received_without_job_id_no_npub(
        self, handler, session, caplog
    ):
        """Even without npub_hex, should log a warning (not crash)."""
        msg = _payload("payment_received", {
            "service_name": "netflix",
            "amount_sats": 3000,
        })
        with caplog.at_level(logging.WARNING):
            await handler.handle_push(msg)
        session.handle_payment_received.assert_not_awaited()
        assert "unknown" in caplog.text

    @pytest.mark.asyncio
    async def test_payment_expired_with_job_id(self, handler, session):
        msg = _payload("payment_expired", {
            "npub_hex": "abc123def456",
            "service_name": "netflix",
            "debt_sats": 3000,
            "job_id": "job-77",
        })
        await handler.handle_push(msg)
        session.handle_payment_expired.assert_awaited_once_with("job-77")

    @pytest.mark.asyncio
    async def test_payment_expired_without_job_id_logs_warning(
        self, handler, session, caplog
    ):
        msg = _payload("payment_expired", {
            "npub_hex": "abc123def456",
            "service_name": "netflix",
            "debt_sats": 3000,
        })
        with caplog.at_level(logging.WARNING):
            await handler.handle_push(msg)
        session.handle_payment_expired.assert_not_awaited()
        assert "payment_expired push without job_id" in caplog.text

    @pytest.mark.asyncio
    async def test_payment_expired_without_job_id_no_npub(
        self, handler, session, caplog
    ):
        msg = _payload("payment_expired", {
            "service_name": "netflix",
            "debt_sats": 3000,
        })
        with caplog.at_level(logging.WARNING):
            await handler.handle_push(msg)
        session.handle_payment_expired.assert_not_awaited()
        assert "unknown" in caplog.text

    @pytest.mark.asyncio
    async def test_new_user_dms_operator_and_sends_invites(
        self, handler, send_operator_dm, api
    ):
        api.get_pending_invite_dms.return_value = []
        msg = _payload("new_user", {"npub": "npub1abcdef1234567890"})
        await handler.handle_push(msg)
        send_operator_dm.assert_awaited_once()
        call_args = send_operator_dm.call_args[0][0]
        assert "New user registered" in call_args
        api.get_pending_invite_dms.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_auto_invite_sends_login_link(self, handler, send_dm):
        msg = _payload("auto_invite", {
            "npub_hex": "abc123def456",
            "otp_code": "123456789012",
        })
        await handler.handle_push(msg)
        # Two DMs: formatted code + instructions
        assert send_dm.await_count == 2
        code_msg = send_dm.call_args_list[0][0][1]
        assert "123456-789012" in code_msg
        instr_msg = send_dm.call_args_list[1][0][1]
        assert "login" in instr_msg.lower()

    @pytest.mark.asyncio
    async def test_auto_invite_missing_npub_logs_warning(self, handler, send_dm, caplog):
        msg = _payload("auto_invite", {"otp_code": "123456789012"})
        with caplog.at_level(logging.WARNING):
            await handler.handle_push(msg)
        send_dm.assert_not_awaited()
        assert "auto_invite push missing" in caplog.text

    @pytest.mark.asyncio
    async def test_auto_invite_missing_otp_logs_warning(self, handler, send_dm, caplog):
        msg = _payload("auto_invite", {"npub_hex": "abc123"})
        with caplog.at_level(logging.WARNING):
            await handler.handle_push(msg)
        send_dm.assert_not_awaited()
        assert "auto_invite push missing" in caplog.text

    @pytest.mark.asyncio
    async def test_unknown_type_logs_warning(self, handler, caplog):
        msg = _payload("bogus_type", {"foo": "bar"})
        with caplog.at_level(logging.WARNING):
            await handler.handle_push(msg)
        assert "Unknown push notification type" in caplog.text
        assert "bogus_type" in caplog.text

    @pytest.mark.asyncio
    async def test_non_json_message_ignored(self, handler, caplog, session, job_manager):
        with caplog.at_level(logging.DEBUG):
            await handler.handle_push("hey there, how are you?")
        session.handle_payment_received.assert_not_awaited()
        job_manager.poll_and_claim.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_valid_json_but_missing_fields_ignored(
        self, handler, session, job_manager
    ):
        """JSON that parses but lacks type/data is silently dropped."""
        await handler.handle_push('{"hello": "world"}')
        session.handle_payment_received.assert_not_awaited()
        job_manager.poll_and_claim.assert_not_awaited()


# ==================================================================
# send_pending_invite_dms
# ==================================================================


class TestSendPendingInviteDms:
    """Tests for the send_pending_invite_dms method."""

    @pytest.mark.asyncio
    async def test_empty_pending_list(self, handler, api):
        api.get_pending_invite_dms.return_value = []
        count = await handler.send_pending_invite_dms()
        assert count == 0

    @pytest.mark.asyncio
    async def test_one_pending_entry(self, handler, api, send_dm):
        api.get_pending_invite_dms.return_value = [
            {"id": "w1", "nostr_npub": "npub1alice123"},
        ]
        count = await handler.send_pending_invite_dms()
        assert count == 1
        send_dm.assert_awaited_once()
        call_args = send_dm.call_args
        assert call_args[0][0] == "npub1alice123"
        assert "unsaltedbutter.ai" in call_args[0][1]
        api.mark_invite_dm_sent.assert_awaited_once_with("w1")

    @pytest.mark.asyncio
    async def test_multiple_pending_entries(self, handler, api, send_dm):
        api.get_pending_invite_dms.return_value = [
            {"id": "w1", "nostr_npub": "npub1alice"},
            {"id": "w2", "nostr_npub": "npub1bob"},
            {"id": "w3", "nostr_npub": "npub1carol"},
        ]
        count = await handler.send_pending_invite_dms()
        assert count == 3
        assert send_dm.await_count == 3
        assert api.mark_invite_dm_sent.await_count == 3

    @pytest.mark.asyncio
    async def test_entry_without_npub_skipped(self, handler, api, send_dm):
        api.get_pending_invite_dms.return_value = [
            {"id": "w1", "nostr_npub": None},
            {"id": "w2", "nostr_npub": "npub1bob"},
        ]
        count = await handler.send_pending_invite_dms()
        assert count == 1
        send_dm.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_entry_with_empty_npub_skipped(self, handler, api, send_dm):
        api.get_pending_invite_dms.return_value = [
            {"id": "w1", "nostr_npub": ""},
            {"id": "w2", "nostr_npub": "npub1bob"},
        ]
        count = await handler.send_pending_invite_dms()
        assert count == 1

    @pytest.mark.asyncio
    async def test_dm_send_failure_continues_with_others(
        self, handler, api, send_dm, caplog
    ):
        api.get_pending_invite_dms.return_value = [
            {"id": "w1", "nostr_npub": "npub1alice"},
            {"id": "w2", "nostr_npub": "npub1bob"},
            {"id": "w3", "nostr_npub": "npub1carol"},
        ]
        # First call raises, second and third succeed
        send_dm.side_effect = [
            RuntimeError("relay down"),
            None,
            None,
        ]
        with caplog.at_level(logging.ERROR):
            count = await handler.send_pending_invite_dms()
        assert count == 2
        assert send_dm.await_count == 3
        # Only the two successful ones get marked
        assert api.mark_invite_dm_sent.await_count == 2
        assert "Failed to send invite DM" in caplog.text

    @pytest.mark.asyncio
    async def test_dm_send_failure_does_not_mark_sent(
        self, handler, api, send_dm
    ):
        api.get_pending_invite_dms.return_value = [
            {"id": "w1", "nostr_npub": "npub1alice"},
        ]
        send_dm.side_effect = RuntimeError("relay down")
        count = await handler.send_pending_invite_dms()
        assert count == 0
        api.mark_invite_dm_sent.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_invite_dm_uses_config_base_url(self, handler, api, send_dm):
        api.get_pending_invite_dms.return_value = [
            {"id": "w1", "nostr_npub": "npub1alice"},
        ]
        count = await handler.send_pending_invite_dms()
        assert count == 1
        dm_text = send_dm.call_args[0][1]
        assert "https://unsaltedbutter.ai" in dm_text
