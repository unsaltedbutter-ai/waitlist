"""Tests for bot dispatch logic: login OTP, waitlist, invites, unknown users.

Uses the same mock pattern as test_commands.py: real dispatch logic, mocked DB.

Run: cd nostr-bot && python -m pytest test_dispatch.py -v
"""

import os
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import UUID

import pytest

# Must set OPERATOR_NPUB before importing bot (it reads env at module level)
os.environ.setdefault("OPERATOR_NPUB", "npub1operator000000000000000000000000000000000000000000000uqhpv3")
os.environ.setdefault("BASE_URL", "https://unsaltedbutter.ai")

import bot


USER_ID = UUID("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")
REGISTERED_NPUB_HEX = "aabbccdd" * 8
UNREGISTERED_NPUB_HEX = "11223344" * 8


def _make_handler():
    """Create a BotNotificationHandler with mocked dependencies."""
    keys = MagicMock()
    keys.public_key.return_value.to_hex.return_value = "botpubkey"
    signer = MagicMock()
    signer.nip04_encrypt = AsyncMock(return_value="encrypted")
    client = MagicMock()
    client.send_event_builder = AsyncMock()
    from nostr_sdk import Timestamp
    start_time = Timestamp.now()
    return bot.BotNotificationHandler(keys, signer, client, start_time, "zapprovider")


@pytest.fixture
def handler():
    return _make_handler()


@pytest.fixture
def mock_db():
    with patch("bot.db") as m:
        m.get_user_by_npub = AsyncMock()
        m.create_otp = AsyncMock()
        m.add_to_waitlist = AsyncMock()
        m.has_onboarded = AsyncMock(return_value=True)
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
async def test_login_registered_user(handler, mock_db):
    mock_db.get_user_by_npub.return_value = {"id": USER_ID, "status": "active", "onboarded_at": "2026-01-01"}
    mock_db.create_otp.return_value = "123456789012"

    result = await handler._dispatch_command(REGISTERED_NPUB_HEX, "login")

    assert isinstance(result, list)
    assert len(result) == 2
    assert result[0] == "123456-789012"  # first bubble is just the code
    assert "5 minutes" in result[1]
    assert "/login" in result[1]
    mock_db.create_otp.assert_awaited_once_with(REGISTERED_NPUB_HEX)


@pytest.mark.asyncio
async def test_login_unregistered_user(handler, mock_db):
    mock_db.get_user_by_npub.return_value = None
    mock_db.create_otp.return_value = "000000000001"

    result = await handler._dispatch_command(UNREGISTERED_NPUB_HEX, "login")

    assert isinstance(result, list)
    assert result[0] == "000000-000001"
    mock_db.create_otp.assert_awaited_once_with(UNREGISTERED_NPUB_HEX)


@pytest.mark.asyncio
async def test_login_case_insensitive(handler, mock_db):
    mock_db.get_user_by_npub.return_value = None
    mock_db.create_otp.return_value = "111111222222"

    for variant in ["LOGIN", "Login", "  login  "]:
        result = await handler._dispatch_command(UNREGISTERED_NPUB_HEX, variant)
        assert isinstance(result, list)
        assert result[0] == "111111-222222"


# -- waitlist --------------------------------------------------------------


@pytest.mark.asyncio
async def test_waitlist_unregistered_new(handler, mock_db):
    mock_db.get_user_by_npub.return_value = None
    mock_db.add_to_waitlist.return_value = ("added", None)

    result = await handler._dispatch_command(UNREGISTERED_NPUB_HEX, "waitlist")

    assert "on the waitlist" in result.lower()
    mock_db.add_to_waitlist.assert_awaited_once_with(UNREGISTERED_NPUB_HEX)


@pytest.mark.asyncio
async def test_waitlist_unregistered_already_waitlisted(handler, mock_db):
    mock_db.get_user_by_npub.return_value = None
    mock_db.add_to_waitlist.return_value = ("already_waitlisted", None)

    result = await handler._dispatch_command(UNREGISTERED_NPUB_HEX, "waitlist")

    assert "already on the waitlist" in result.lower()


@pytest.mark.asyncio
async def test_waitlist_unregistered_already_invited(handler, mock_db):
    mock_db.get_user_by_npub.return_value = None
    mock_db.add_to_waitlist.return_value = ("already_invited", "ABC123XYZ")

    result = await handler._dispatch_command(UNREGISTERED_NPUB_HEX, "waitlist")

    assert "already been invited" in result.lower()
    assert "/login?code=ABC123XYZ" in result


@pytest.mark.asyncio
async def test_waitlist_registered_user(handler, mock_db):
    mock_db.get_user_by_npub.return_value = {"id": USER_ID, "status": "active", "onboarded_at": "2026-01-01"}

    result = await handler._dispatch_command(REGISTERED_NPUB_HEX, "waitlist")

    assert "already have an account" in result.lower()
    mock_db.add_to_waitlist.assert_not_awaited()


# -- invites (operator) ---------------------------------------------------


@pytest.mark.asyncio
async def test_invites_operator(handler, mock_db):
    operator_npub = os.environ["OPERATOR_NPUB"]
    operator_hex = bot._npub_to_hex(operator_npub)

    # Mock the invite DM sending
    handler._send_pending_invite_dms = AsyncMock(return_value=3)

    # Operator user lookup doesn't matter for "invites", but must be set
    mock_db.get_user_by_npub.return_value = {"id": USER_ID, "status": "active", "onboarded_at": "2026-01-01"}

    result = await handler._dispatch_command(operator_hex, "invites")

    assert "3" in result
    assert "invite" in result.lower()
    handler._send_pending_invite_dms.assert_awaited_once()


@pytest.mark.asyncio
async def test_invites_non_operator_unregistered(handler, mock_db):
    mock_db.get_user_by_npub.return_value = None

    result = await handler._dispatch_command(UNREGISTERED_NPUB_HEX, "invites")

    # Non-operator, unregistered: falls through to "Join the waitlist"
    assert result == "Join the waitlist"


@pytest.mark.asyncio
async def test_invites_non_operator_registered(handler, mock_db, mock_commands):
    mock_db.get_user_by_npub.return_value = {"id": USER_ID, "status": "active", "onboarded_at": "2026-01-01"}
    mock_commands.handle_dm.return_value = "help text"

    result = await handler._dispatch_command(REGISTERED_NPUB_HEX, "invites")

    # Non-operator, registered: falls through to commands.handle_dm
    mock_commands.handle_dm.assert_awaited_once()


# -- unknown command -------------------------------------------------------


@pytest.mark.asyncio
async def test_unknown_command_unregistered(handler, mock_db):
    mock_db.get_user_by_npub.return_value = None

    result = await handler._dispatch_command(UNREGISTERED_NPUB_HEX, "gibberish")

    assert result == "Join the waitlist"


@pytest.mark.asyncio
async def test_unknown_command_registered(handler, mock_db, mock_commands):
    mock_db.get_user_by_npub.return_value = {"id": USER_ID, "status": "active", "onboarded_at": "2026-01-01"}
    mock_commands.handle_dm.return_value = "help text"

    result = await handler._dispatch_command(REGISTERED_NPUB_HEX, "gibberish")

    mock_commands.handle_dm.assert_awaited_once_with(USER_ID, "active", "gibberish")


# -- non-onboarded member -------------------------------------------------


@pytest.mark.asyncio
async def test_non_onboarded_member_gets_finish_setup(handler, mock_db):
    mock_db.get_user_by_npub.return_value = {"id": USER_ID, "status": "active", "onboarded_at": None}
    mock_db.has_onboarded.return_value = False

    result = await handler._dispatch_command(REGISTERED_NPUB_HEX, "status")

    assert "complete your setup" in result.lower()
    assert "/login" in result


@pytest.mark.asyncio
async def test_non_onboarded_member_can_still_login(handler, mock_db):
    mock_db.get_user_by_npub.return_value = {"id": USER_ID, "status": "active", "onboarded_at": None}
    mock_db.has_onboarded.return_value = False
    mock_db.create_otp.return_value = "123456789012"

    result = await handler._dispatch_command(REGISTERED_NPUB_HEX, "login")

    assert isinstance(result, list)
    assert result[0] == "123456-789012"


# -- invite DM sending ----------------------------------------------------


@pytest.mark.asyncio
async def test_send_pending_invite_dms(handler, mock_db):
    mock_db.get_pending_invite_dms.return_value = [
        {"id": "uuid1", "nostr_npub": UNREGISTERED_NPUB_HEX, "invite_code": "CODE1"},
        {"id": "uuid2", "nostr_npub": REGISTERED_NPUB_HEX, "invite_code": "CODE2"},
    ]

    count = await handler._send_pending_invite_dms()

    assert count == 2
    assert mock_db.mark_invite_dm_sent.await_count == 2


@pytest.mark.asyncio
async def test_send_pending_invite_dms_none_pending(handler, mock_db):
    mock_db.get_pending_invite_dms.return_value = []

    count = await handler._send_pending_invite_dms()

    assert count == 0


@pytest.mark.asyncio
async def test_invites_operator_none_pending(handler, mock_db):
    operator_npub = os.environ["OPERATOR_NPUB"]
    operator_hex = bot._npub_to_hex(operator_npub)

    handler._send_pending_invite_dms = AsyncMock(return_value=0)
    mock_db.get_user_by_npub.return_value = {"id": USER_ID, "status": "active", "onboarded_at": "2026-01-01"}

    result = await handler._dispatch_command(operator_hex, "invites")

    assert "no pending" in result.lower()
