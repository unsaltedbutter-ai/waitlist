"""Tests for zap receipt validation (NIP-57).

Constructs real signed nostr events with test keys and verifies each
validation check rejects forged/spoofed receipts independently.

Run: cd nostr-bot && python -m pytest test_zap_validation.py -v
Requires: pip install pytest pytest-asyncio
"""

import hashlib
import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from nostr_sdk import EventBuilder, Keys, Kind, Tag

import zap_handler

# ── Test keys ────────────────────────────────────────────────

BOT_KEYS = Keys.generate()
PROVIDER_KEYS = Keys.generate()  # simulates LNURL Lightning provider
SENDER_KEYS = Keys.generate()  # simulates a user zapping the bot
ATTACKER_KEYS = Keys.generate()

BOT_PK = BOT_KEYS.public_key().to_hex()
PROVIDER_PK = PROVIDER_KEYS.public_key().to_hex()
SENDER_PK = SENDER_KEYS.public_key().to_hex()

AMOUNT_MSATS = 21_000  # 21 sats


# ── Helpers ──────────────────────────────────────────────────


def _make_9734(sender_keys=None, p_hex=None, amount_msats=None, kind_num=9734):
    """Build and sign a kind 9734 zap request event."""
    tags = []
    if p_hex is not None:
        tags.append(Tag.parse(["p", p_hex]))
    if amount_msats is not None:
        tags.append(Tag.parse(["amount", str(amount_msats)]))
    tags.append(Tag.parse(["relays", "wss://relay.damus.io"]))
    return EventBuilder(Kind(kind_num), "").tags(tags).sign_with_keys(
        sender_keys or SENDER_KEYS
    )


def _bolt11_mock(amount_msats=AMOUNT_MSATS, description_hash="will_be_set"):
    mock = MagicMock()
    mock.amount_msat = amount_msats
    mock.description_hash = description_hash
    return mock


def _make_9735(desc_json, provider_keys=None):
    """Build and sign a kind 9735 zap receipt event."""
    tags = [
        Tag.parse(["p", BOT_PK]),
        Tag.parse(["bolt11", "lnbc210n1fake"]),
        Tag.parse(["description", desc_json]),
    ]
    return EventBuilder(Kind(9735), "").tags(tags).sign_with_keys(
        provider_keys or PROVIDER_KEYS
    )


def _valid_set():
    """Return (receipt_event, bolt11_mock) for a fully valid zap."""
    zap_req = _make_9734(p_hex=BOT_PK, amount_msats=AMOUNT_MSATS)
    desc_json = zap_req.as_json()
    desc_hash = hashlib.sha256(desc_json.encode("utf-8")).hexdigest()
    receipt = _make_9735(desc_json)
    invoice = _bolt11_mock(description_hash=desc_hash)
    return receipt, invoice


@pytest.fixture
def mock_db():
    with patch("zap_handler.db") as m:
        m.get_user_by_npub = AsyncMock(
            return_value={"id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", "status": "active"}
        )
        m.has_paid_membership = AsyncMock(return_value=True)
        m.credit_zap = AsyncMock(return_value=42_000)
        yield m


@pytest.fixture
def send_dm():
    return AsyncMock()


# ── Happy path ───────────────────────────────────────────────


@pytest.mark.asyncio
async def test_valid_zap_credits_user(mock_db, send_dm):
    receipt, invoice = _valid_set()
    with patch("zap_handler.bolt11_lib.decode", return_value=invoice):
        await zap_handler.handle_zap_receipt(receipt, send_dm, BOT_PK, PROVIDER_PK)
    mock_db.credit_zap.assert_called_once()
    send_dm.assert_called_once()  # confirmation DM


# ── CHECK 1: 9735 author must be LNURL provider ─────────────


@pytest.mark.asyncio
async def test_reject_wrong_receipt_author(mock_db, send_dm):
    """9735 signed by attacker instead of the LNURL provider."""
    zap_req = _make_9734(p_hex=BOT_PK, amount_msats=AMOUNT_MSATS)
    desc_json = zap_req.as_json()
    desc_hash = hashlib.sha256(desc_json.encode("utf-8")).hexdigest()
    receipt = _make_9735(desc_json, provider_keys=ATTACKER_KEYS)
    invoice = _bolt11_mock(description_hash=desc_hash)

    with patch("zap_handler.bolt11_lib.decode", return_value=invoice):
        await zap_handler.handle_zap_receipt(receipt, send_dm, BOT_PK, PROVIDER_PK)
    mock_db.credit_zap.assert_not_called()


# ── CHECK 2: bolt11 description_hash ─────────────────────────


@pytest.mark.asyncio
async def test_reject_description_hash_mismatch(mock_db, send_dm):
    """bolt11 description_hash doesn't match SHA-256 of the description tag."""
    receipt, _ = _valid_set()
    invoice = _bolt11_mock(description_hash="0" * 64)

    with patch("zap_handler.bolt11_lib.decode", return_value=invoice):
        await zap_handler.handle_zap_receipt(receipt, send_dm, BOT_PK, PROVIDER_PK)
    mock_db.credit_zap.assert_not_called()


@pytest.mark.asyncio
async def test_reject_missing_description_hash(mock_db, send_dm):
    """bolt11 invoice has no description_hash (not a valid zap invoice)."""
    receipt, _ = _valid_set()
    invoice = _bolt11_mock(description_hash=None)

    with patch("zap_handler.bolt11_lib.decode", return_value=invoice):
        await zap_handler.handle_zap_receipt(receipt, send_dm, BOT_PK, PROVIDER_PK)
    mock_db.credit_zap.assert_not_called()


# ── CHECK 3: 9734 signature must be valid ────────────────────


@pytest.mark.asyncio
async def test_reject_tampered_9734_pubkey(mock_db, send_dm):
    """9734 pubkey swapped to attacker's — verify() catches id/sig mismatch."""
    zap_req = _make_9734(p_hex=BOT_PK, amount_msats=AMOUNT_MSATS)
    desc_json = zap_req.as_json()

    # Tamper: replace the sender pubkey with attacker's.
    # The id was computed over the original pubkey and the sig was made
    # with the original key, so both verify_id() and verify_signature() fail.
    obj = json.loads(desc_json)
    obj["pubkey"] = ATTACKER_KEYS.public_key().to_hex()
    tampered = json.dumps(obj)

    desc_hash = hashlib.sha256(tampered.encode("utf-8")).hexdigest()
    receipt = _make_9735(tampered)
    invoice = _bolt11_mock(description_hash=desc_hash)

    with patch("zap_handler.bolt11_lib.decode", return_value=invoice):
        await zap_handler.handle_zap_receipt(receipt, send_dm, BOT_PK, PROVIDER_PK)
    mock_db.credit_zap.assert_not_called()


@pytest.mark.asyncio
async def test_reject_garbage_description(mock_db, send_dm):
    """description tag is not a nostr event at all."""
    garbage = '{"foo":"bar"}'
    desc_hash = hashlib.sha256(garbage.encode("utf-8")).hexdigest()
    receipt = _make_9735(garbage)
    invoice = _bolt11_mock(description_hash=desc_hash)

    with patch("zap_handler.bolt11_lib.decode", return_value=invoice):
        await zap_handler.handle_zap_receipt(receipt, send_dm, BOT_PK, PROVIDER_PK)
    mock_db.credit_zap.assert_not_called()


# ── CHECK 4: Embedded event must be kind 9734 ───────────────


@pytest.mark.asyncio
async def test_reject_wrong_kind_in_description(mock_db, send_dm):
    """Embedded event is kind 1 (text note), not kind 9734."""
    wrong = _make_9734(p_hex=BOT_PK, amount_msats=AMOUNT_MSATS, kind_num=1)
    desc_json = wrong.as_json()
    desc_hash = hashlib.sha256(desc_json.encode("utf-8")).hexdigest()
    receipt = _make_9735(desc_json)
    invoice = _bolt11_mock(description_hash=desc_hash)

    with patch("zap_handler.bolt11_lib.decode", return_value=invoice):
        await zap_handler.handle_zap_receipt(receipt, send_dm, BOT_PK, PROVIDER_PK)
    mock_db.credit_zap.assert_not_called()


# ── CHECK 5: 9734 p-tag must reference bot ───────────────────


@pytest.mark.asyncio
async def test_reject_wrong_p_tag(mock_db, send_dm):
    """9734 p-tag references someone else — replayed receipt from another target."""
    other_pk = ATTACKER_KEYS.public_key().to_hex()
    zap_req = _make_9734(p_hex=other_pk, amount_msats=AMOUNT_MSATS)
    desc_json = zap_req.as_json()
    desc_hash = hashlib.sha256(desc_json.encode("utf-8")).hexdigest()
    receipt = _make_9735(desc_json)
    invoice = _bolt11_mock(description_hash=desc_hash)

    with patch("zap_handler.bolt11_lib.decode", return_value=invoice):
        await zap_handler.handle_zap_receipt(receipt, send_dm, BOT_PK, PROVIDER_PK)
    mock_db.credit_zap.assert_not_called()


@pytest.mark.asyncio
async def test_reject_missing_p_tag(mock_db, send_dm):
    """9734 has no p-tag at all."""
    zap_req = _make_9734(p_hex=None, amount_msats=AMOUNT_MSATS)  # no p-tag
    desc_json = zap_req.as_json()
    desc_hash = hashlib.sha256(desc_json.encode("utf-8")).hexdigest()
    receipt = _make_9735(desc_json)
    invoice = _bolt11_mock(description_hash=desc_hash)

    with patch("zap_handler.bolt11_lib.decode", return_value=invoice):
        await zap_handler.handle_zap_receipt(receipt, send_dm, BOT_PK, PROVIDER_PK)
    mock_db.credit_zap.assert_not_called()


# ── CHECK 6: Amount tag must match bolt11 ────────────────────


@pytest.mark.asyncio
async def test_reject_amount_inflation(mock_db, send_dm):
    """9734 says 21000 msats, but bolt11 invoice is for 1000000 msats."""
    zap_req = _make_9734(p_hex=BOT_PK, amount_msats=21_000)
    desc_json = zap_req.as_json()
    desc_hash = hashlib.sha256(desc_json.encode("utf-8")).hexdigest()
    receipt = _make_9735(desc_json)
    invoice = _bolt11_mock(amount_msats=1_000_000, description_hash=desc_hash)

    with patch("zap_handler.bolt11_lib.decode", return_value=invoice):
        await zap_handler.handle_zap_receipt(receipt, send_dm, BOT_PK, PROVIDER_PK)
    mock_db.credit_zap.assert_not_called()


# ── Idempotency ──────────────────────────────────────────────


@pytest.mark.asyncio
async def test_duplicate_zap_not_double_credited(mock_db, send_dm):
    """Same event_id processed twice — credit_zap returns None, no DM."""
    receipt, invoice = _valid_set()
    mock_db.credit_zap.return_value = None  # already processed

    with patch("zap_handler.bolt11_lib.decode", return_value=invoice):
        await zap_handler.handle_zap_receipt(receipt, send_dm, BOT_PK, PROVIDER_PK)
    mock_db.credit_zap.assert_called_once()  # called, but returned None
    send_dm.assert_not_called()  # no confirmation for duplicate


# ── Unregistered sender ──────────────────────────────────────


@pytest.mark.asyncio
async def test_unregistered_sender_not_credited(mock_db, send_dm):
    """Zap from npub not in DB — no credit, sends join message."""
    receipt, invoice = _valid_set()
    mock_db.get_user_by_npub.return_value = None

    with patch("zap_handler.bolt11_lib.decode", return_value=invoice):
        await zap_handler.handle_zap_receipt(receipt, send_dm, BOT_PK, PROVIDER_PK)
    mock_db.credit_zap.assert_not_called()
    # Should DM them to join
    send_dm.assert_called_once()
    assert "Join the waitlist" in send_dm.call_args[0][1]


# ── Unpaid member ─────────────────────────────────────────────


@pytest.mark.asyncio
async def test_unpaid_member_not_credited(mock_db, send_dm):
    """Zap from registered user who hasn't paid membership — no credit, told to finish setup."""
    receipt, invoice = _valid_set()
    mock_db.has_paid_membership.return_value = False

    with patch("zap_handler.bolt11_lib.decode", return_value=invoice):
        await zap_handler.handle_zap_receipt(receipt, send_dm, BOT_PK, PROVIDER_PK)
    mock_db.credit_zap.assert_not_called()
    send_dm.assert_called_once()
    assert "finish" in send_dm.call_args[0][1].lower()


@pytest.mark.asyncio
async def test_paid_member_credited(mock_db, send_dm):
    """Zap from registered user with paid membership — credited normally."""
    receipt, invoice = _valid_set()
    mock_db.has_paid_membership.return_value = True

    with patch("zap_handler.bolt11_lib.decode", return_value=invoice):
        await zap_handler.handle_zap_receipt(receipt, send_dm, BOT_PK, PROVIDER_PK)
    mock_db.credit_zap.assert_called_once()
    send_dm.assert_called_once()
    assert "sats" in send_dm.call_args[0][1].lower()
