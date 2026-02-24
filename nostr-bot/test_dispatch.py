"""Tests for bot dispatch logic: login OTP, waitlist, invites, push notifications.

Uses the same mock pattern as test_commands.py: real dispatch logic, mocked DB.

Run: cd nostr-bot && python -m pytest test_dispatch.py -v
"""

import json
import os
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import UUID

import pytest

# Must set OPERATOR_NPUB before importing bot (it reads env at module level).
# Use a real valid npub (secp256k1 point) so PublicKey.parse() succeeds.
os.environ.setdefault("OPERATOR_NPUB", "npub1j3yd8lhf6wcpfgy9p8hpyr6ec5yze6nkdyrf6cxstuzydqmfzt9sg9kzlx")
os.environ.setdefault("BASE_URL", "https://unsaltedbutter.ai")

import bot


USER_ID = UUID("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")
REGISTERED_NPUB_HEX = "aabbccdd" * 8
UNREGISTERED_NPUB_HEX = "11223344" * 8
VPS_BOT_HEX = "deadbeef" * 8


def _make_handler():
    """Create a BotNotificationHandler with mocked dependencies."""
    keys = MagicMock()
    keys.public_key.return_value.to_hex.return_value = "botpubkey"
    signer = MagicMock()
    signer.nip04_encrypt = AsyncMock(return_value="encrypted")
    client = MagicMock()
    client.send_event_builder = AsyncMock()
    client.send_private_msg = AsyncMock()
    from nostr_sdk import Timestamp
    start_time = Timestamp.now()
    operator_npub = os.environ.get("OPERATOR_NPUB", "")
    operator_hex = bot._npub_to_hex(operator_npub) if operator_npub else ""
    return bot.BotNotificationHandler(keys, signer, client, start_time, "zapprovider", VPS_BOT_HEX, operator_hex)


@pytest.fixture
def handler():
    return _make_handler()


@pytest.fixture
def mock_api():
    with patch("bot.api_client") as m:
        m.get_user = AsyncMock()
        m.create_otp = AsyncMock()
        m.add_to_waitlist = AsyncMock()
        m.auto_invite = AsyncMock()
        m.get_pending_invite_dms = AsyncMock(return_value=[])
        m.mark_invite_dm_sent = AsyncMock()
        yield m


@pytest.fixture
def mock_commands():
    with patch("bot.commands") as m:
        m.handle_dm = AsyncMock(return_value="help text here")
        yield m


# -- login -----------------------------------------------------------------


@pytest.mark.asyncio
async def test_login_registered_user(handler, mock_api):
    mock_api.get_user.return_value = {"user": {"id": str(USER_ID), "debt_sats": 0, "onboarded_at": "2026-01-01"}}
    mock_api.create_otp.return_value = "123456789012"

    result = await handler._dispatch_command(REGISTERED_NPUB_HEX, "login")

    assert isinstance(result, list)
    assert len(result) == 2
    assert result[0] == "123456-789012"
    assert "15 minutes" in result[1]
    assert "/login" in result[1]
    mock_api.create_otp.assert_awaited_once_with(REGISTERED_NPUB_HEX)


@pytest.mark.asyncio
async def test_login_unregistered_user_at_capacity(handler, mock_api):
    """Unregistered user at capacity should get waitlist message."""
    mock_api.get_user.return_value = None
    mock_api.auto_invite.return_value = {"status": "at_capacity", "invite_code": None}

    result = await handler._dispatch_command(UNREGISTERED_NPUB_HEX, "login")

    assert "waitlist" in result.lower()
    mock_api.auto_invite.assert_awaited_once_with(UNREGISTERED_NPUB_HEX)
    mock_api.create_otp.assert_not_awaited()


@pytest.mark.asyncio
async def test_login_unregistered_user_auto_invited(handler, mock_api):
    """Unregistered user should be auto-invited and get OTP + login link."""
    mock_api.get_user.return_value = None
    mock_api.auto_invite.return_value = {"status": "invited", "invite_code": "ABC123XYZ"}
    mock_api.create_otp.return_value = "999888777666"

    result = await handler._dispatch_command(UNREGISTERED_NPUB_HEX, "login")

    assert isinstance(result, list)
    assert result[0] == "999888-777666"
    assert "/login" in result[1]
    assert "?code=" not in result[1]
    mock_api.create_otp.assert_awaited_once_with(UNREGISTERED_NPUB_HEX)


@pytest.mark.asyncio
async def test_login_case_insensitive(handler, mock_api):
    mock_api.get_user.return_value = {"user": {"id": "u1", "nostr_npub": REGISTERED_NPUB_HEX, "onboarded_at": "2026-01-01"}}
    mock_api.create_otp.return_value = "111111222222"

    for variant in ["LOGIN", "Login", "  login  "]:
        result = await handler._dispatch_command(REGISTERED_NPUB_HEX, variant)
        assert isinstance(result, list)
        assert result[0] == "111111-222222"


# -- waitlist --------------------------------------------------------------


@pytest.mark.asyncio
async def test_waitlist_unregistered_auto_invited(handler, mock_api):
    """Unregistered user DM-ing 'waitlist' should be auto-invited and get login code."""
    mock_api.get_user.return_value = None
    mock_api.auto_invite.return_value = {"status": "invited", "invite_code": "ABC123"}
    mock_api.create_otp.return_value = "123456789012"

    result = await handler._dispatch_command(UNREGISTERED_NPUB_HEX, "waitlist")

    assert isinstance(result, list)
    assert result[0] == "123456-789012"
    mock_api.auto_invite.assert_awaited_once_with(UNREGISTERED_NPUB_HEX)


@pytest.mark.asyncio
async def test_waitlist_unregistered_at_capacity(handler, mock_api):
    """Unregistered user DM-ing 'waitlist' at capacity should get waitlist message."""
    mock_api.get_user.return_value = None
    mock_api.auto_invite.return_value = {"status": "at_capacity", "invite_code": None}

    result = await handler._dispatch_command(UNREGISTERED_NPUB_HEX, "waitlist")

    assert "waitlist" in result.lower()


@pytest.mark.asyncio
async def test_waitlist_unregistered_already_invited(handler, mock_api):
    """Already-invited user DM-ing 'waitlist' should get login code."""
    mock_api.get_user.return_value = None
    mock_api.auto_invite.return_value = {"status": "already_invited", "invite_code": "ABC123XYZ"}
    mock_api.create_otp.return_value = "999888777666"

    result = await handler._dispatch_command(UNREGISTERED_NPUB_HEX, "waitlist")

    assert isinstance(result, list)
    assert result[0] == "999888-777666"
    assert "/login" in result[1]


@pytest.mark.asyncio
async def test_waitlist_registered_user(handler, mock_api):
    mock_api.get_user.return_value = {"user": {"id": str(USER_ID), "debt_sats": 0, "onboarded_at": "2026-01-01"}}

    result = await handler._dispatch_command(REGISTERED_NPUB_HEX, "waitlist")

    assert "already have an account" in result.lower()
    mock_api.auto_invite.assert_not_awaited()


# -- invites (operator) ---------------------------------------------------


@pytest.mark.asyncio
async def test_invites_operator(handler, mock_api):
    operator_npub = os.environ["OPERATOR_NPUB"]
    operator_hex = bot._npub_to_hex(operator_npub)

    handler._send_pending_invite_dms = AsyncMock(return_value=3)
    mock_api.get_user.return_value = {"user": {"id": str(USER_ID), "debt_sats": 0, "onboarded_at": "2026-01-01"}}

    result = await handler._dispatch_command(operator_hex, "invites")

    assert "3" in result
    assert "invite" in result.lower()
    handler._send_pending_invite_dms.assert_awaited_once()


@pytest.mark.asyncio
async def test_invites_non_operator_unregistered(handler, mock_api):
    mock_api.get_user.return_value = None
    mock_api.auto_invite.return_value = {"status": "invited", "invite_code": "XYZ"}
    mock_api.create_otp.return_value = "111122223333"

    result = await handler._dispatch_command(UNREGISTERED_NPUB_HEX, "invites")

    # Auto-invited: gets login code
    assert isinstance(result, list)
    assert result[0] == "111122-223333"
    mock_api.auto_invite.assert_awaited_once_with(UNREGISTERED_NPUB_HEX)


@pytest.mark.asyncio
async def test_invites_non_operator_registered(handler, mock_api, mock_commands):
    mock_api.get_user.return_value = {"user": {"id": str(USER_ID), "debt_sats": 0, "onboarded_at": "2026-01-01"}}
    mock_commands.handle_dm.return_value = "help text"

    result = await handler._dispatch_command(REGISTERED_NPUB_HEX, "invites")

    mock_commands.handle_dm.assert_awaited_once()


# -- unknown command -------------------------------------------------------


@pytest.mark.asyncio
async def test_unknown_command_unregistered(handler, mock_api):
    mock_api.get_user.return_value = None
    mock_api.auto_invite.return_value = {"status": "invited", "invite_code": "XYZ"}
    mock_api.create_otp.return_value = "444455556666"

    result = await handler._dispatch_command(UNREGISTERED_NPUB_HEX, "gibberish")

    # Auto-invited: gets login code
    assert isinstance(result, list)
    assert result[0] == "444455-556666"
    mock_api.auto_invite.assert_awaited_once_with(UNREGISTERED_NPUB_HEX)


@pytest.mark.asyncio
async def test_unknown_command_registered(handler, mock_api, mock_commands):
    mock_api.get_user.return_value = {"user": {"id": str(USER_ID), "debt_sats": 0, "onboarded_at": "2026-01-01"}}
    mock_commands.handle_dm.return_value = "help text"

    result = await handler._dispatch_command(REGISTERED_NPUB_HEX, "gibberish")

    mock_commands.handle_dm.assert_awaited_once_with(REGISTERED_NPUB_HEX, "gibberish")


# -- non-onboarded member -------------------------------------------------


@pytest.mark.asyncio
async def test_non_onboarded_member_gets_finish_setup(handler, mock_api):
    mock_api.get_user.return_value = {"user": {"id": str(USER_ID), "debt_sats": 0, "onboarded_at": None}}

    result = await handler._dispatch_command(REGISTERED_NPUB_HEX, "status")

    assert "complete your setup" in result.lower()
    assert "/login" in result


@pytest.mark.asyncio
async def test_non_onboarded_member_can_still_login(handler, mock_api):
    mock_api.get_user.return_value = {"user": {"id": str(USER_ID), "debt_sats": 0, "onboarded_at": None}}
    mock_api.create_otp.return_value = "123456789012"

    result = await handler._dispatch_command(REGISTERED_NPUB_HEX, "login")

    assert isinstance(result, list)
    assert result[0] == "123456-789012"


# -- invite DM sending ----------------------------------------------------


@pytest.mark.asyncio
async def test_send_pending_invite_dms(handler, mock_api):
    mock_api.get_pending_invite_dms.return_value = [
        {"id": "uuid1", "nostr_npub": UNREGISTERED_NPUB_HEX, "invite_code": "CODE1"},
        {"id": "uuid2", "nostr_npub": REGISTERED_NPUB_HEX, "invite_code": "CODE2"},
    ]

    count = await handler._send_pending_invite_dms()

    assert count == 2
    assert mock_api.mark_invite_dm_sent.await_count == 2


@pytest.mark.asyncio
async def test_send_pending_invite_dms_none_pending(handler, mock_api):
    mock_api.get_pending_invite_dms.return_value = []

    count = await handler._send_pending_invite_dms()

    assert count == 0


@pytest.mark.asyncio
async def test_invites_operator_none_pending(handler, mock_api):
    operator_npub = os.environ["OPERATOR_NPUB"]
    operator_hex = bot._npub_to_hex(operator_npub)

    handler._send_pending_invite_dms = AsyncMock(return_value=0)
    mock_api.get_user.return_value = {"user": {"id": str(USER_ID), "debt_sats": 0, "onboarded_at": "2026-01-01"}}

    result = await handler._dispatch_command(operator_hex, "invites")

    assert "no pending" in result.lower()


# -- push notifications from VPS bot ---------------------------------------


@pytest.mark.asyncio
async def test_push_notification_job_complete(handler):
    payload = json.dumps({
        "type": "job_complete",
        "data": {
            "npub_hex": REGISTERED_NPUB_HEX,
            "service_name": "Netflix",
            "action": "cancel",
            "access_end_date": "March 15",
            "bolt11": "lnbc3000n1fake...",
        },
    })
    await handler._handle_push_notification(payload)
    # Proactive outbound uses NIP-04 (send_event_builder), not NIP-17 (send_private_msg)
    handler._client.send_event_builder.assert_awaited_once()
    handler._client.send_private_msg.assert_not_awaited()


@pytest.mark.asyncio
async def test_push_notification_payment_received(handler):
    payload = json.dumps({
        "type": "payment_received",
        "data": {
            "npub_hex": REGISTERED_NPUB_HEX,
            "service_name": "Hulu",
            "amount_sats": 3000,
        },
    })
    await handler._handle_push_notification(payload)
    # Proactive outbound uses NIP-04 (send_event_builder), not NIP-17 (send_private_msg)
    handler._client.send_event_builder.assert_awaited_once()
    handler._client.send_private_msg.assert_not_awaited()


@pytest.mark.asyncio
async def test_push_notification_payment_expired(handler):
    payload = json.dumps({
        "type": "payment_expired",
        "data": {
            "npub_hex": REGISTERED_NPUB_HEX,
            "service_name": "Netflix",
            "debt_sats": 3000,
        },
    })
    await handler._handle_push_notification(payload)
    # Proactive outbound uses NIP-04 (send_event_builder), not NIP-17 (send_private_msg)
    handler._client.send_event_builder.assert_awaited_once()
    handler._client.send_private_msg.assert_not_awaited()


@pytest.mark.asyncio
async def test_push_notification_invalid_json(handler):
    await handler._handle_push_notification("not json at all")
    handler._client.send_private_msg.assert_not_awaited()


@pytest.mark.asyncio
async def test_push_notification_unknown_type(handler):
    payload = json.dumps({
        "type": "unknown_thing",
        "data": {"npub_hex": REGISTERED_NPUB_HEX},
    })
    await handler._handle_push_notification(payload)
    handler._client.send_private_msg.assert_not_awaited()


@pytest.mark.asyncio
async def test_push_notification_missing_target(handler):
    payload = json.dumps({
        "type": "job_complete",
        "data": {
            "service_name": "Netflix",
            "action": "cancel",
            # npub_hex is missing
        },
    })
    await handler._handle_push_notification(payload)
    # No target to send to
    handler._client.send_private_msg.assert_not_awaited()


# -- dispatch passes npub_hex to commands (not user_id + status) -----------


@pytest.mark.asyncio
async def test_dispatch_passes_npub_to_commands(handler, mock_api, mock_commands):
    mock_api.get_user.return_value = {"user": {"id": str(USER_ID), "debt_sats": 0, "onboarded_at": "2026-01-01"}}
    mock_commands.handle_dm.return_value = "ok"

    await handler._dispatch_command(REGISTERED_NPUB_HEX, "cancel netflix")

    mock_commands.handle_dm.assert_awaited_once_with(REGISTERED_NPUB_HEX, "cancel netflix")
