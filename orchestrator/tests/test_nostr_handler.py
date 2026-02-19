"""Tests for the top-level Nostr event router (nostr_handler.py).

Mocks nostr_sdk types (Event, Keys, Client, etc.) since we cannot create
real cryptographic Nostr events in tests. Tests verify routing logic only:
events get dispatched to the correct handler based on kind and sender.

Run: cd orchestrator && python -m pytest tests/test_nostr_handler.py -v
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from nostr_sdk import Kind, KindStandard

from nostr_handler import NostrHandler

# -- Fake hex pubkeys (64-char hex strings) ------------------------------------

BOT_PK = "aa" * 32
VPS_BOT_PK = "bb" * 32
USER_PK = "cc" * 32
OPERATOR_NPUB = "dd" * 32
ZAP_PROVIDER_PK = "ee" * 32

START_SECS = 2_000_000_000


# -- Mock builders -------------------------------------------------------------


def _make_config() -> MagicMock:
    cfg = MagicMock()
    cfg.vps_bot_pubkey = VPS_BOT_PK
    cfg.zap_provider_pubkey = ZAP_PROVIDER_PK
    cfg.operator_npub = OPERATOR_NPUB
    return cfg


def _make_keys() -> MagicMock:
    keys = MagicMock()
    pk = MagicMock()
    pk.to_hex.return_value = BOT_PK
    keys.public_key.return_value = pk
    keys.secret_key.return_value = MagicMock()
    return keys


def _make_timestamp(secs: int) -> MagicMock:
    ts = MagicMock()
    ts.as_secs.return_value = secs
    return ts


def _make_event(
    kind_value: int,
    created_at_secs: int = START_SECS + 100,
    author_hex: str = USER_PK,
    content: str = "hello",
    event_id_hex: str = "ff" * 32,
) -> MagicMock:
    """Build a mock nostr_sdk.Event.

    Uses real Kind objects for comparison so the handler's isinstance/equality
    checks work correctly against Kind(4), KindStandard.GIFT_WRAP, etc.
    """
    event = MagicMock()

    # Kind: use the real Kind class so equality checks work
    real_kind = Kind(kind_value)
    event.kind.return_value = real_kind

    ts = MagicMock()
    ts.as_secs.return_value = created_at_secs
    event.created_at.return_value = ts

    author = MagicMock()
    author.to_hex.return_value = author_hex
    event.author.return_value = author

    event.content.return_value = content

    eid = MagicMock()
    eid.to_hex.return_value = event_id_hex
    event.id.return_value = eid

    return event


def _make_rumor(
    kind_value: int = 14,
    created_at_secs: int = START_SECS + 100,
    content: str = "hello from nip17",
) -> MagicMock:
    """Build a mock UnsignedEvent (rumor) for NIP-17."""
    rumor = MagicMock()
    real_kind = Kind(kind_value)
    rumor.kind.return_value = real_kind
    ts = MagicMock()
    ts.as_secs.return_value = created_at_secs
    rumor.created_at.return_value = ts
    rumor.content.return_value = content
    return rumor


def _make_unwrapped(sender_hex: str = USER_PK, rumor: MagicMock | None = None) -> MagicMock:
    """Build a mock UnwrappedGift."""
    uw = MagicMock()
    sender = MagicMock()
    sender.to_hex.return_value = sender_hex
    uw.sender.return_value = sender
    uw.rumor.return_value = rumor if rumor else _make_rumor()
    return uw


# -- Fixture: build a NostrHandler with all mocked deps -----------------------


@pytest.fixture()
def handler():
    """Create a NostrHandler with all dependencies mocked."""
    keys = _make_keys()
    signer = MagicMock()
    client = AsyncMock()
    start_time = _make_timestamp(START_SECS)
    config = _make_config()
    commands = AsyncMock()
    notifications = AsyncMock()
    db = AsyncMock()
    api_client = AsyncMock()

    h = NostrHandler(
        keys=keys,
        signer=signer,
        client=client,
        start_time=start_time,
        config=config,
        commands=commands,
        notifications=notifications,
        db=db,
        api_client=api_client,
    )
    # Expose mocks for assertions
    h._test_client = client
    h._test_commands = commands
    h._test_notifications = notifications
    h._test_db = db
    h._test_api_client = api_client
    h._test_keys = keys
    h._test_signer = signer
    return h


RELAY_URL = MagicMock()
SUB_ID = "sub-1"


# ==============================================================================
# NIP-04 DM routing
# ==============================================================================


@pytest.mark.asyncio
@patch("nostr_handler.nip04_decrypt", return_value="user says hi")
async def test_nip04_user_dm_routes_to_commands(mock_decrypt, handler):
    """A kind 4 DM from a regular user routes to commands.handle_dm."""
    event = _make_event(kind_value=4, author_hex=USER_PK, content="encrypted")

    await handler.handle(RELAY_URL, SUB_ID, event)

    handler._test_db.log_message.assert_awaited_once_with("inbound", USER_PK, "user says hi")
    handler._test_commands.handle_dm.assert_awaited_once_with(USER_PK, "user says hi")
    handler._test_notifications.handle_push.assert_not_awaited()


@pytest.mark.asyncio
@patch("nostr_handler.nip04_decrypt", return_value='{"type":"job_dispatched"}')
async def test_nip04_vps_dm_routes_to_notifications(mock_decrypt, handler):
    """A kind 4 DM from the VPS bot routes to notifications.handle_push."""
    event = _make_event(kind_value=4, author_hex=VPS_BOT_PK, content="encrypted")

    await handler.handle(RELAY_URL, SUB_ID, event)

    handler._test_db.log_message.assert_awaited_once_with(
        "inbound", VPS_BOT_PK, '{"type":"job_dispatched"}'
    )
    handler._test_notifications.handle_push.assert_awaited_once_with(
        '{"type":"job_dispatched"}'
    )
    handler._test_commands.handle_dm.assert_not_awaited()


@pytest.mark.asyncio
@patch("nostr_handler.nip04_decrypt", return_value="old message")
async def test_nip04_old_event_skipped(mock_decrypt, handler):
    """Kind 4 events with timestamps before start_time are silently skipped."""
    event = _make_event(kind_value=4, created_at_secs=START_SECS - 100)

    await handler.handle(RELAY_URL, SUB_ID, event)

    mock_decrypt.assert_not_called()
    handler._test_commands.handle_dm.assert_not_awaited()
    handler._test_notifications.handle_push.assert_not_awaited()
    handler._test_db.log_message.assert_not_awaited()


# ==============================================================================
# NIP-17 DM routing
# ==============================================================================


@pytest.mark.asyncio
async def test_nip17_user_dm_routes_to_commands(handler):
    """A kind 1059 gift wrap from a regular user routes to commands.handle_dm."""
    rumor = _make_rumor(kind_value=14, content="nip17 hello")
    unwrapped = _make_unwrapped(sender_hex=USER_PK, rumor=rumor)
    event = _make_event(kind_value=1059)

    with patch("nostr_handler.UnwrappedGift") as MockUG:
        MockUG.from_gift_wrap = AsyncMock(return_value=unwrapped)
        await handler.handle(RELAY_URL, SUB_ID, event)

    handler._test_db.log_message.assert_awaited_once_with("inbound", USER_PK, "nip17 hello")
    handler._test_commands.handle_dm.assert_awaited_once_with(USER_PK, "nip17 hello")
    handler._test_notifications.handle_push.assert_not_awaited()


@pytest.mark.asyncio
async def test_nip17_vps_dm_routes_to_notifications(handler):
    """A kind 1059 gift wrap from the VPS bot routes to notifications.handle_push."""
    rumor = _make_rumor(kind_value=14, content='{"type":"job_completed"}')
    unwrapped = _make_unwrapped(sender_hex=VPS_BOT_PK, rumor=rumor)
    event = _make_event(kind_value=1059)

    with patch("nostr_handler.UnwrappedGift") as MockUG:
        MockUG.from_gift_wrap = AsyncMock(return_value=unwrapped)
        await handler.handle(RELAY_URL, SUB_ID, event)

    handler._test_db.log_message.assert_awaited_once_with(
        "inbound", VPS_BOT_PK, '{"type":"job_completed"}'
    )
    handler._test_notifications.handle_push.assert_awaited_once_with(
        '{"type":"job_completed"}'
    )
    handler._test_commands.handle_dm.assert_not_awaited()


@pytest.mark.asyncio
async def test_nip17_old_rumor_skipped(handler):
    """NIP-17 rumor with timestamp before start_time is silently skipped."""
    rumor = _make_rumor(kind_value=14, created_at_secs=START_SECS - 500)
    unwrapped = _make_unwrapped(sender_hex=USER_PK, rumor=rumor)
    event = _make_event(kind_value=1059)

    with patch("nostr_handler.UnwrappedGift") as MockUG:
        MockUG.from_gift_wrap = AsyncMock(return_value=unwrapped)
        await handler.handle(RELAY_URL, SUB_ID, event)

    handler._test_commands.handle_dm.assert_not_awaited()
    handler._test_notifications.handle_push.assert_not_awaited()
    handler._test_db.log_message.assert_not_awaited()


@pytest.mark.asyncio
async def test_nip17_non_kind14_rumor_skipped(handler):
    """NIP-17 rumor that is not kind 14 (e.g. kind 1 text note) is ignored."""
    rumor = _make_rumor(kind_value=1, content="not a DM")
    unwrapped = _make_unwrapped(sender_hex=USER_PK, rumor=rumor)
    event = _make_event(kind_value=1059)

    with patch("nostr_handler.UnwrappedGift") as MockUG:
        MockUG.from_gift_wrap = AsyncMock(return_value=unwrapped)
        await handler.handle(RELAY_URL, SUB_ID, event)

    handler._test_commands.handle_dm.assert_not_awaited()
    handler._test_notifications.handle_push.assert_not_awaited()
    handler._test_db.log_message.assert_not_awaited()


# ==============================================================================
# Protocol matching (NIP-04 in -> NIP-04 out, NIP-17 in -> NIP-17 out)
# ==============================================================================


@pytest.mark.asyncio
@patch("nostr_handler.nip04_decrypt", return_value="login")
async def test_nip04_dm_records_protocol(mock_decrypt, handler):
    """Receiving a NIP-04 DM records the user's protocol as nip04."""
    event = _make_event(kind_value=4, author_hex=USER_PK)
    await handler.handle(RELAY_URL, SUB_ID, event)
    assert handler._user_protocol[USER_PK] == "nip04"


@pytest.mark.asyncio
async def test_nip17_dm_records_protocol(handler):
    """Receiving a NIP-17 DM records the user's protocol as nip17."""
    rumor = _make_rumor(kind_value=14, content="hello")
    unwrapped = _make_unwrapped(sender_hex=USER_PK, rumor=rumor)
    event = _make_event(kind_value=1059)

    with patch("nostr_handler.UnwrappedGift") as MockUG:
        MockUG.from_gift_wrap = AsyncMock(return_value=unwrapped)
        await handler.handle(RELAY_URL, SUB_ID, event)

    assert handler._user_protocol[USER_PK] == "nip17"


@pytest.mark.asyncio
@patch("nostr_handler.nip04_decrypt", return_value='{"type":"jobs_ready"}')
async def test_vps_bot_dm_does_not_record_protocol(mock_decrypt, handler):
    """DMs from the VPS bot do not record a user protocol."""
    event = _make_event(kind_value=4, author_hex=VPS_BOT_PK)
    await handler.handle(RELAY_URL, SUB_ID, event)
    assert VPS_BOT_PK not in handler._user_protocol


@pytest.mark.asyncio
async def test_outreach_uses_nip04_by_default(handler):
    """Bot-initiated outreach (no prior contact) defaults to NIP-04."""
    new_user = "11" * 32
    assert new_user not in handler._user_protocol

    with patch("nostr_handler.PublicKey") as MockPK:
        pk_instance = MagicMock()
        MockPK.parse.return_value = pk_instance
        with patch.object(handler, "_send_nip04", new_callable=AsyncMock) as mock_nip04:
            await handler.send_dm(new_user, "Time to cancel Netflix")

    mock_nip04.assert_awaited_once_with(pk_instance, "Time to cancel Netflix")
    handler._test_client.send_private_msg.assert_not_awaited()


@pytest.mark.asyncio
@patch("nostr_handler.nip04_decrypt", return_value="login")
async def test_nip04_roundtrip_reply_uses_nip04(mock_decrypt, handler):
    """Full roundtrip: NIP-04 DM in, reply goes out as NIP-04."""
    event = _make_event(kind_value=4, author_hex=USER_PK)
    await handler.handle(RELAY_URL, SUB_ID, event)

    with patch("nostr_handler.PublicKey") as MockPK:
        pk_instance = MagicMock()
        MockPK.parse.return_value = pk_instance
        with patch.object(handler, "_send_nip04", new_callable=AsyncMock) as mock_nip04:
            await handler.send_dm(USER_PK, "reply")

    mock_nip04.assert_awaited_once()
    handler._test_client.send_private_msg.assert_not_awaited()


@pytest.mark.asyncio
async def test_nip17_roundtrip_reply_uses_nip17(handler):
    """Full roundtrip: NIP-17 DM in, reply goes out as NIP-17."""
    rumor = _make_rumor(kind_value=14, content="login")
    unwrapped = _make_unwrapped(sender_hex=USER_PK, rumor=rumor)
    event = _make_event(kind_value=1059)

    with patch("nostr_handler.UnwrappedGift") as MockUG:
        MockUG.from_gift_wrap = AsyncMock(return_value=unwrapped)
        await handler.handle(RELAY_URL, SUB_ID, event)

    with patch("nostr_handler.PublicKey") as MockPK:
        pk_instance = MagicMock()
        MockPK.parse.return_value = pk_instance
        await handler.send_dm(USER_PK, "reply")

    handler._test_client.send_private_msg.assert_awaited_once_with(pk_instance, "reply", [])


# ==============================================================================
# Zap receipt routing
# ==============================================================================


@pytest.mark.asyncio
async def test_zap_receipt_forwarded(handler):
    """Kind 9735 events are forwarded to zap_handler.handle_zap_receipt."""
    event = _make_event(kind_value=9735)

    with patch("nostr_handler.zap_handler.handle_zap_receipt", new_callable=AsyncMock) as mock_zap:
        await handler.handle(RELAY_URL, SUB_ID, event)

    mock_zap.assert_awaited_once()
    args = mock_zap.call_args
    assert args[0][0] is event
    # send_dm is a local closure, skip checking it
    assert args[0][2] == BOT_PK
    assert args[0][3] == ZAP_PROVIDER_PK
    assert args[1]["api_client"] is handler._test_api_client


@pytest.mark.asyncio
async def test_zap_receipt_old_event_skipped(handler):
    """Kind 9735 events before start_time are silently skipped."""
    event = _make_event(kind_value=9735, created_at_secs=START_SECS - 1)

    with patch("nostr_handler.zap_handler.handle_zap_receipt", new_callable=AsyncMock) as mock_zap:
        await handler.handle(RELAY_URL, SUB_ID, event)

    mock_zap.assert_not_awaited()


# ==============================================================================
# send_dm
# ==============================================================================


@pytest.mark.asyncio
async def test_send_dm_default_uses_nip04(handler):
    """send_dm defaults to NIP-04 when no prior protocol is recorded."""
    with patch("nostr_handler.PublicKey") as MockPK:
        pk_instance = MagicMock()
        MockPK.parse.return_value = pk_instance
        with patch.object(handler, "_send_nip04", new_callable=AsyncMock) as mock_nip04:
            await handler.send_dm(USER_PK, "hi there")

    MockPK.parse.assert_called_once_with(USER_PK)
    mock_nip04.assert_awaited_once_with(pk_instance, "hi there")
    handler._test_client.send_private_msg.assert_not_awaited()
    handler._test_db.log_message.assert_awaited_once_with("outbound", USER_PK, "hi there")


@pytest.mark.asyncio
async def test_send_dm_uses_nip17_when_recorded(handler):
    """send_dm uses NIP-17 when the user's last protocol was NIP-17."""
    handler._user_protocol[USER_PK] = "nip17"

    with patch("nostr_handler.PublicKey") as MockPK:
        pk_instance = MagicMock()
        MockPK.parse.return_value = pk_instance
        await handler.send_dm(USER_PK, "hi nip17")

    handler._test_client.send_private_msg.assert_awaited_once_with(pk_instance, "hi nip17", [])
    handler._test_db.log_message.assert_awaited_once_with("outbound", USER_PK, "hi nip17")


@pytest.mark.asyncio
async def test_send_dm_uses_nip04_when_recorded(handler):
    """send_dm uses NIP-04 when the user's last protocol was NIP-04."""
    handler._user_protocol[USER_PK] = "nip04"

    with patch("nostr_handler.PublicKey") as MockPK:
        pk_instance = MagicMock()
        MockPK.parse.return_value = pk_instance
        with patch.object(handler, "_send_nip04", new_callable=AsyncMock) as mock_nip04:
            await handler.send_dm(USER_PK, "hi nip04")

    mock_nip04.assert_awaited_once_with(pk_instance, "hi nip04")
    handler._test_client.send_private_msg.assert_not_awaited()
    handler._test_db.log_message.assert_awaited_once_with("outbound", USER_PK, "hi nip04")


@pytest.mark.asyncio
async def test_send_dm_failure_logged(handler):
    """send_dm catches exceptions and logs them (does not raise)."""
    with patch.object(handler, "_send_nip04", new_callable=AsyncMock, side_effect=RuntimeError("relay down")):
        with patch("nostr_handler.PublicKey") as MockPK:
            MockPK.parse.return_value = MagicMock()
            # Should not raise
            await handler.send_dm(USER_PK, "hi there")

    # Message was not logged (send failed before log_message)
    handler._test_db.log_message.assert_not_awaited()


# ==============================================================================
# send_operator_dm
# ==============================================================================


@pytest.mark.asyncio
async def test_send_operator_dm(handler):
    """send_operator_dm delegates to send_dm with the operator npub."""
    with patch.object(handler, "send_dm", new_callable=AsyncMock) as mock_send:
        await handler.send_operator_dm("system alert")

    mock_send.assert_awaited_once_with(OPERATOR_NPUB, "system alert")


# ==============================================================================
# handle_msg (no-op)
# ==============================================================================


@pytest.mark.asyncio
async def test_handle_msg_is_noop(handler):
    """handle_msg exists and does nothing."""
    result = await handler.handle_msg(RELAY_URL, MagicMock())
    assert result is None


# ==============================================================================
# Error handling in handle()
# ==============================================================================


@pytest.mark.asyncio
@patch("nostr_handler.nip04_decrypt", side_effect=RuntimeError("decrypt boom"))
async def test_handle_catches_nip04_error(mock_decrypt, handler):
    """Exceptions in NIP-04 handling are caught and logged (not raised)."""
    event = _make_event(kind_value=4)

    # Should not raise
    await handler.handle(RELAY_URL, SUB_ID, event)

    # Verify nothing downstream was called
    handler._test_commands.handle_dm.assert_not_awaited()
    handler._test_notifications.handle_push.assert_not_awaited()


@pytest.mark.asyncio
async def test_handle_catches_nip17_error(handler):
    """Exceptions in NIP-17 handling are caught and logged (not raised)."""
    event = _make_event(kind_value=1059)

    with patch("nostr_handler.UnwrappedGift") as MockUG:
        MockUG.from_gift_wrap = AsyncMock(side_effect=RuntimeError("unwrap boom"))
        # Should not raise
        await handler.handle(RELAY_URL, SUB_ID, event)

    handler._test_commands.handle_dm.assert_not_awaited()


@pytest.mark.asyncio
async def test_handle_catches_zap_error(handler):
    """Exceptions in zap handling are caught and logged (not raised)."""
    event = _make_event(kind_value=9735)

    with patch(
        "nostr_handler.zap_handler.handle_zap_receipt",
        new_callable=AsyncMock,
        side_effect=RuntimeError("zap boom"),
    ):
        # Should not raise
        await handler.handle(RELAY_URL, SUB_ID, event)


# ==============================================================================
# Unknown kind (no routing)
# ==============================================================================


@pytest.mark.asyncio
async def test_unknown_kind_ignored(handler):
    """Events with unrecognized kinds are silently ignored."""
    event = _make_event(kind_value=30023)  # long-form article, not handled

    await handler.handle(RELAY_URL, SUB_ID, event)

    handler._test_commands.handle_dm.assert_not_awaited()
    handler._test_notifications.handle_push.assert_not_awaited()


# ==============================================================================
# Zap send_dm closure
# ==============================================================================


@pytest.mark.asyncio
async def test_zap_send_dm_closure_calls_client(handler):
    """The send_dm closure passed to zap_handler uses client.send_private_msg."""
    event = _make_event(kind_value=9735)

    captured_send_dm = None

    async def capture_zap_receipt(ev, send_dm_fn, bot_pk, zap_pk, api_client=None):
        nonlocal captured_send_dm
        captured_send_dm = send_dm_fn

    with patch("nostr_handler.zap_handler.handle_zap_receipt", side_effect=capture_zap_receipt):
        with patch("nostr_handler.PublicKey") as MockPK:
            pk_instance = MagicMock()
            MockPK.parse.return_value = pk_instance
            await handler.handle(RELAY_URL, SUB_ID, event)

            # Now call the captured closure
            assert captured_send_dm is not None
            await captured_send_dm(USER_PK, "zap thanks")

    MockPK.parse.assert_called_with(USER_PK)
    handler._test_client.send_private_msg.assert_awaited_once_with(pk_instance, "zap thanks", [])
