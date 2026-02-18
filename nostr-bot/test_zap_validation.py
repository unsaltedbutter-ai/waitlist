"""Tests for zap receipt validation (NIP-57) and job payment confirmation.

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

# -- Test keys -------------------------------------------------------------

BOT_KEYS = Keys.generate()
PROVIDER_KEYS = Keys.generate()  # simulates LNURL Lightning provider
SENDER_KEYS = Keys.generate()  # simulates a user zapping the bot
ATTACKER_KEYS = Keys.generate()

BOT_PK = BOT_KEYS.public_key().to_hex()
PROVIDER_PK = PROVIDER_KEYS.public_key().to_hex()
SENDER_PK = SENDER_KEYS.public_key().to_hex()

AMOUNT_MSATS = 3_000_000  # 3000 sats (one action)


# -- Helpers ---------------------------------------------------------------


def _make_9734(sender_keys=None, p_hex=None, amount_msats=None, kind_num=9734, job_id=None):
    """Build and sign a kind 9734 zap request event."""
    tags = []
    if p_hex is not None:
        tags.append(Tag.parse(["p", p_hex]))
    if amount_msats is not None:
        tags.append(Tag.parse(["amount", str(amount_msats)]))
    if job_id is not None:
        tags.append(Tag.parse(["job_id", job_id]))
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
        Tag.parse(["bolt11", "lnbc3000n1fake"]),
        Tag.parse(["description", desc_json]),
    ]
    return EventBuilder(Kind(9735), "").tags(tags).sign_with_keys(
        provider_keys or PROVIDER_KEYS
    )


def _valid_set(job_id=None):
    """Return (receipt_event, bolt11_mock) for a fully valid zap."""
    zap_req = _make_9734(p_hex=BOT_PK, amount_msats=AMOUNT_MSATS, job_id=job_id)
    desc_json = zap_req.as_json()
    desc_hash = hashlib.sha256(desc_json.encode("utf-8")).hexdigest()
    receipt = _make_9735(desc_json)
    invoice = _bolt11_mock(description_hash=desc_hash)
    return receipt, invoice


@pytest.fixture
def mock_db():
    with patch("zap_handler.db") as m:
        m.get_user_by_npub = AsyncMock(
            return_value={"id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", "debt_sats": 0, "onboarded_at": "2026-01-01"}
        )
        yield m


@pytest.fixture
def mock_api():
    with patch("zap_handler.api_client") as m:
        m.mark_job_paid = AsyncMock(return_value={"status_code": 200, "data": {"success": True}})
        yield m


@pytest.fixture
def send_dm():
    return AsyncMock()


# -- Happy path: zap with job_id tag -----------------------------------------


@pytest.mark.asyncio
async def test_valid_zap_with_job_id_marks_paid(mock_db, mock_api, send_dm):
    receipt, invoice = _valid_set(job_id="job-123")
    with patch("zap_handler.bolt11_lib.decode", return_value=invoice):
        await zap_handler.handle_zap_receipt(receipt, send_dm, BOT_PK, PROVIDER_PK)
    mock_api.mark_job_paid.assert_called_once()
    call_kwargs = mock_api.mark_job_paid.call_args
    assert call_kwargs[0][0] == "job-123"
    send_dm.assert_called_once()  # payment confirmation DM
    assert "received" in send_dm.call_args[0][1].lower()


# -- Zap without job_id tag (no job reference) --------------------------------


@pytest.mark.asyncio
async def test_valid_zap_no_job_id_sends_info(mock_db, mock_api, send_dm):
    receipt, invoice = _valid_set(job_id=None)
    with patch("zap_handler.bolt11_lib.decode", return_value=invoice):
        await zap_handler.handle_zap_receipt(receipt, send_dm, BOT_PK, PROVIDER_PK)
    mock_api.mark_job_paid.assert_not_called()
    send_dm.assert_called_once()
    assert "no job reference" in send_dm.call_args[0][1].lower()


# -- Job already paid (409) ---------------------------------------------------


@pytest.mark.asyncio
async def test_zap_job_already_paid(mock_db, mock_api, send_dm):
    mock_api.mark_job_paid.return_value = {"status_code": 409, "data": {"error": "Already paid"}}
    receipt, invoice = _valid_set(job_id="job-123")
    with patch("zap_handler.bolt11_lib.decode", return_value=invoice):
        await zap_handler.handle_zap_receipt(receipt, send_dm, BOT_PK, PROVIDER_PK)
    mock_api.mark_job_paid.assert_called_once()
    # No error DM for already-paid
    send_dm.assert_not_called()


# -- API error marking paid ---------------------------------------------------


@pytest.mark.asyncio
async def test_zap_api_error(mock_db, mock_api, send_dm):
    mock_api.mark_job_paid.side_effect = Exception("connection refused")
    receipt, invoice = _valid_set(job_id="job-123")
    with patch("zap_handler.bolt11_lib.decode", return_value=invoice):
        await zap_handler.handle_zap_receipt(receipt, send_dm, BOT_PK, PROVIDER_PK)
    send_dm.assert_called_once()
    assert "error" in send_dm.call_args[0][1].lower()


# -- API returns non-200 non-409 -----------------------------------------------


@pytest.mark.asyncio
async def test_zap_api_unexpected_status(mock_db, mock_api, send_dm):
    mock_api.mark_job_paid.return_value = {"status_code": 400, "data": {"error": "not payable"}}
    receipt, invoice = _valid_set(job_id="job-123")
    with patch("zap_handler.bolt11_lib.decode", return_value=invoice):
        await zap_handler.handle_zap_receipt(receipt, send_dm, BOT_PK, PROVIDER_PK)
    send_dm.assert_called_once()
    assert "couldn't apply" in send_dm.call_args[0][1].lower()


# -- CHECK 1: 9735 author must be LNURL provider ------------------------------


@pytest.mark.asyncio
async def test_reject_wrong_receipt_author(mock_db, mock_api, send_dm):
    """9735 signed by attacker instead of the LNURL provider."""
    zap_req = _make_9734(p_hex=BOT_PK, amount_msats=AMOUNT_MSATS)
    desc_json = zap_req.as_json()
    desc_hash = hashlib.sha256(desc_json.encode("utf-8")).hexdigest()
    receipt = _make_9735(desc_json, provider_keys=ATTACKER_KEYS)
    invoice = _bolt11_mock(description_hash=desc_hash)

    with patch("zap_handler.bolt11_lib.decode", return_value=invoice):
        await zap_handler.handle_zap_receipt(receipt, send_dm, BOT_PK, PROVIDER_PK)
    mock_api.mark_job_paid.assert_not_called()


# -- CHECK 2: bolt11 description_hash ------------------------------------------


@pytest.mark.asyncio
async def test_reject_description_hash_mismatch(mock_db, mock_api, send_dm):
    receipt, _ = _valid_set()
    invoice = _bolt11_mock(description_hash="0" * 64)

    with patch("zap_handler.bolt11_lib.decode", return_value=invoice):
        await zap_handler.handle_zap_receipt(receipt, send_dm, BOT_PK, PROVIDER_PK)
    mock_api.mark_job_paid.assert_not_called()


@pytest.mark.asyncio
async def test_reject_missing_description_hash(mock_db, mock_api, send_dm):
    receipt, _ = _valid_set()
    invoice = _bolt11_mock(description_hash=None)

    with patch("zap_handler.bolt11_lib.decode", return_value=invoice):
        await zap_handler.handle_zap_receipt(receipt, send_dm, BOT_PK, PROVIDER_PK)
    mock_api.mark_job_paid.assert_not_called()


# -- CHECK 3: 9734 signature must be valid ------------------------------------


@pytest.mark.asyncio
async def test_reject_tampered_9734_pubkey(mock_db, mock_api, send_dm):
    zap_req = _make_9734(p_hex=BOT_PK, amount_msats=AMOUNT_MSATS)
    desc_json = zap_req.as_json()

    obj = json.loads(desc_json)
    obj["pubkey"] = ATTACKER_KEYS.public_key().to_hex()
    tampered = json.dumps(obj)

    desc_hash = hashlib.sha256(tampered.encode("utf-8")).hexdigest()
    receipt = _make_9735(tampered)
    invoice = _bolt11_mock(description_hash=desc_hash)

    with patch("zap_handler.bolt11_lib.decode", return_value=invoice):
        await zap_handler.handle_zap_receipt(receipt, send_dm, BOT_PK, PROVIDER_PK)
    mock_api.mark_job_paid.assert_not_called()


@pytest.mark.asyncio
async def test_reject_garbage_description(mock_db, mock_api, send_dm):
    garbage = '{"foo":"bar"}'
    desc_hash = hashlib.sha256(garbage.encode("utf-8")).hexdigest()
    receipt = _make_9735(garbage)
    invoice = _bolt11_mock(description_hash=desc_hash)

    with patch("zap_handler.bolt11_lib.decode", return_value=invoice):
        await zap_handler.handle_zap_receipt(receipt, send_dm, BOT_PK, PROVIDER_PK)
    mock_api.mark_job_paid.assert_not_called()


# -- CHECK 4: Embedded event must be kind 9734 --------------------------------


@pytest.mark.asyncio
async def test_reject_wrong_kind_in_description(mock_db, mock_api, send_dm):
    wrong = _make_9734(p_hex=BOT_PK, amount_msats=AMOUNT_MSATS, kind_num=1)
    desc_json = wrong.as_json()
    desc_hash = hashlib.sha256(desc_json.encode("utf-8")).hexdigest()
    receipt = _make_9735(desc_json)
    invoice = _bolt11_mock(description_hash=desc_hash)

    with patch("zap_handler.bolt11_lib.decode", return_value=invoice):
        await zap_handler.handle_zap_receipt(receipt, send_dm, BOT_PK, PROVIDER_PK)
    mock_api.mark_job_paid.assert_not_called()


# -- CHECK 5: 9734 p-tag must reference bot ------------------------------------


@pytest.mark.asyncio
async def test_reject_wrong_p_tag(mock_db, mock_api, send_dm):
    other_pk = ATTACKER_KEYS.public_key().to_hex()
    zap_req = _make_9734(p_hex=other_pk, amount_msats=AMOUNT_MSATS)
    desc_json = zap_req.as_json()
    desc_hash = hashlib.sha256(desc_json.encode("utf-8")).hexdigest()
    receipt = _make_9735(desc_json)
    invoice = _bolt11_mock(description_hash=desc_hash)

    with patch("zap_handler.bolt11_lib.decode", return_value=invoice):
        await zap_handler.handle_zap_receipt(receipt, send_dm, BOT_PK, PROVIDER_PK)
    mock_api.mark_job_paid.assert_not_called()


@pytest.mark.asyncio
async def test_reject_missing_p_tag(mock_db, mock_api, send_dm):
    zap_req = _make_9734(p_hex=None, amount_msats=AMOUNT_MSATS)
    desc_json = zap_req.as_json()
    desc_hash = hashlib.sha256(desc_json.encode("utf-8")).hexdigest()
    receipt = _make_9735(desc_json)
    invoice = _bolt11_mock(description_hash=desc_hash)

    with patch("zap_handler.bolt11_lib.decode", return_value=invoice):
        await zap_handler.handle_zap_receipt(receipt, send_dm, BOT_PK, PROVIDER_PK)
    mock_api.mark_job_paid.assert_not_called()


# -- CHECK 6: Amount tag must match bolt11 -------------------------------------


@pytest.mark.asyncio
async def test_reject_amount_inflation(mock_db, mock_api, send_dm):
    zap_req = _make_9734(p_hex=BOT_PK, amount_msats=3_000_000)
    desc_json = zap_req.as_json()
    desc_hash = hashlib.sha256(desc_json.encode("utf-8")).hexdigest()
    receipt = _make_9735(desc_json)
    invoice = _bolt11_mock(amount_msats=1_000_000, description_hash=desc_hash)

    with patch("zap_handler.bolt11_lib.decode", return_value=invoice):
        await zap_handler.handle_zap_receipt(receipt, send_dm, BOT_PK, PROVIDER_PK)
    mock_api.mark_job_paid.assert_not_called()


# -- Unregistered sender -------------------------------------------------------


@pytest.mark.asyncio
async def test_unregistered_sender_not_processed(mock_db, mock_api, send_dm):
    receipt, invoice = _valid_set(job_id="job-123")
    mock_db.get_user_by_npub.return_value = None

    with patch("zap_handler.bolt11_lib.decode", return_value=invoice):
        await zap_handler.handle_zap_receipt(receipt, send_dm, BOT_PK, PROVIDER_PK)
    mock_api.mark_job_paid.assert_not_called()
    send_dm.assert_called_once()
    assert "No account found" in send_dm.call_args[0][1]
