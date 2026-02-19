"""Tests for zap receipt validation (NIP-57) in the orchestrator.

Uses unittest.mock to construct synthetic nostr events and bolt11 invoices.
No dependency on real nostr_sdk key generation or signing at test time.

Run: cd orchestrator && python -m pytest tests/test_zap_handler.py -v
"""

from __future__ import annotations

import hashlib
import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

import zap_handler

# -- Fake hex pubkeys (64 char hex strings) ------------------------------------

BOT_PK: str = "aa" * 32
PROVIDER_PK: str = "bb" * 32
SENDER_PK: str = "cc" * 32
ATTACKER_PK: str = "dd" * 32

AMOUNT_MSATS: int = 3_000_000  # 3000 sats


# -- Mock builders -------------------------------------------------------------


def _make_tag(key: str, value: str) -> MagicMock:
    """Create a mock tag that returns [key, value] from as_vec()."""
    tag = MagicMock()
    tag.as_vec.return_value = [key, value]
    return tag


def _make_tags_obj(tags: list[MagicMock]) -> MagicMock:
    """Create a mock tags container whose to_vec() returns the tag list."""
    obj = MagicMock()
    obj.to_vec.return_value = tags
    return obj


def _make_9734_json(
    sender_pk: str = SENDER_PK,
    p_hex: str | None = BOT_PK,
    amount_msats: int | None = AMOUNT_MSATS,
    kind_num: int = 9734,
    job_id: str | None = None,
) -> str:
    """Build a fake 9734 JSON string (the zap request embedded in the description tag)."""
    tags: list[list[str]] = []
    if p_hex is not None:
        tags.append(["p", p_hex])
    if amount_msats is not None:
        tags.append(["amount", str(amount_msats)])
    if job_id is not None:
        tags.append(["job_id", job_id])
    tags.append(["relays", "wss://relay.damus.io"])

    return json.dumps({
        "id": "ee" * 32,
        "pubkey": sender_pk,
        "created_at": 1700000000,
        "kind": kind_num,
        "tags": tags,
        "content": "",
        "sig": "ff" * 32,
    })


def _make_9734_event(
    desc_json: str,
    verify_result: bool = True,
) -> MagicMock:
    """Create a mock NostrEvent for the 9734 parsed from description JSON."""
    obj = json.loads(desc_json)
    event = MagicMock()
    event.verify.return_value = verify_result

    kind_mock = MagicMock()
    kind_mock.as_u16.return_value = obj["kind"]
    event.kind.return_value = kind_mock

    author_mock = MagicMock()
    author_mock.to_hex.return_value = obj["pubkey"]
    event.author.return_value = author_mock

    # Build tags from the JSON
    mock_tags: list[MagicMock] = []
    for t in obj["tags"]:
        tag = MagicMock()
        tag.as_vec.return_value = t
        mock_tags.append(tag)
    event.tags.return_value = _make_tags_obj(mock_tags)

    return event


def _make_9735(
    author_pk: str = PROVIDER_PK,
    bolt11_str: str = "lnbc3000n1fake",
    description_json: str | None = None,
    event_id: str = "ab" * 32,
    include_bolt11: bool = True,
    include_description: bool = True,
) -> MagicMock:
    """Create a mock kind 9735 receipt event."""
    event = MagicMock()

    id_mock = MagicMock()
    id_mock.to_hex.return_value = event_id
    event.id.return_value = id_mock

    author_mock = MagicMock()
    author_mock.to_hex.return_value = author_pk
    event.author.return_value = author_mock

    tags: list[MagicMock] = []
    tags.append(_make_tag("p", BOT_PK))
    if include_bolt11:
        tags.append(_make_tag("bolt11", bolt11_str))
    if include_description and description_json is not None:
        tags.append(_make_tag("description", description_json))
    event.tags.return_value = _make_tags_obj(tags)

    return event


def _bolt11_mock(
    amount_msats: int = AMOUNT_MSATS,
    description_hash: str = "will_be_set",
) -> MagicMock:
    """Create a mock bolt11 decoded invoice."""
    mock = MagicMock()
    mock.amount_msat = amount_msats
    mock.description_hash = description_hash
    return mock


def _valid_set(
    job_id: str | None = None,
) -> tuple[MagicMock, str, MagicMock, MagicMock]:
    """Return (receipt_event, desc_json, bolt11_mock, zap_request_event) for a valid zap.

    All six checks will pass with these defaults.
    """
    desc_json = _make_9734_json(job_id=job_id)
    desc_hash = hashlib.sha256(desc_json.encode("utf-8")).hexdigest()
    receipt = _make_9735(description_json=desc_json)
    invoice = _bolt11_mock(description_hash=desc_hash)
    zap_req_event = _make_9734_event(desc_json, verify_result=True)
    return receipt, desc_json, invoice, zap_req_event


# -- Fixtures ------------------------------------------------------------------


@pytest.fixture()
def api_client() -> AsyncMock:
    """Mock ApiClient with get_user and mark_job_paid."""
    client = AsyncMock()
    client.get_user.return_value = {
        "user": {
            "id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
            "debt_sats": 0,
            "onboarded_at": "2026-01-01",
        }
    }
    client.mark_job_paid.return_value = {"status_code": 200, "data": {"success": True}}
    return client


@pytest.fixture()
def send_dm() -> AsyncMock:
    return AsyncMock()


# -- Helpers to run the handler ------------------------------------------------


async def _run(
    receipt: MagicMock,
    invoice: MagicMock,
    zap_req_event: MagicMock,
    send_dm: AsyncMock,
    api_client: AsyncMock,
) -> None:
    """Run handle_zap_receipt with patched bolt11 decode and NostrEvent.from_json."""
    with (
        patch("zap_handler.bolt11_lib.decode", return_value=invoice),
        patch("zap_handler.NostrEvent.from_json", return_value=zap_req_event),
    ):
        await zap_handler.handle_zap_receipt(
            receipt, send_dm, BOT_PK, PROVIDER_PK, api_client,
        )


# -- CHECK 1: 9735 author must be LNURL provider ------------------------------


@pytest.mark.asyncio
async def test_reject_wrong_author(api_client: AsyncMock, send_dm: AsyncMock) -> None:
    """9735 signed by attacker instead of the LNURL provider."""
    receipt, desc_json, invoice, zap_req = _valid_set()
    receipt.author.return_value.to_hex.return_value = ATTACKER_PK

    await _run(receipt, invoice, zap_req, send_dm, api_client)

    api_client.mark_job_paid.assert_not_called()
    send_dm.assert_not_called()


# -- Missing bolt11 tag -------------------------------------------------------


@pytest.mark.asyncio
async def test_reject_missing_bolt11(api_client: AsyncMock, send_dm: AsyncMock) -> None:
    desc_json = _make_9734_json()
    desc_hash = hashlib.sha256(desc_json.encode("utf-8")).hexdigest()
    receipt = _make_9735(description_json=desc_json, include_bolt11=False)
    invoice = _bolt11_mock(description_hash=desc_hash)
    zap_req = _make_9734_event(desc_json)

    await _run(receipt, invoice, zap_req, send_dm, api_client)

    api_client.mark_job_paid.assert_not_called()
    send_dm.assert_not_called()


# -- Missing description tag ---------------------------------------------------


@pytest.mark.asyncio
async def test_reject_missing_description(api_client: AsyncMock, send_dm: AsyncMock) -> None:
    receipt = _make_9735(include_description=False, description_json=None)
    invoice = _bolt11_mock()
    zap_req = MagicMock()

    await _run(receipt, invoice, zap_req, send_dm, api_client)

    api_client.mark_job_paid.assert_not_called()
    send_dm.assert_not_called()


# -- Bad bolt11 string ---------------------------------------------------------


@pytest.mark.asyncio
async def test_reject_bad_bolt11(api_client: AsyncMock, send_dm: AsyncMock) -> None:
    desc_json = _make_9734_json()
    receipt = _make_9735(description_json=desc_json)
    zap_req = _make_9734_event(desc_json)

    with (
        patch("zap_handler.bolt11_lib.decode", side_effect=ValueError("invalid")),
        patch("zap_handler.NostrEvent.from_json", return_value=zap_req),
    ):
        await zap_handler.handle_zap_receipt(
            receipt, send_dm, BOT_PK, PROVIDER_PK, api_client,
        )

    api_client.mark_job_paid.assert_not_called()
    send_dm.assert_not_called()


# -- Zero amount ---------------------------------------------------------------


@pytest.mark.asyncio
async def test_reject_zero_amount(api_client: AsyncMock, send_dm: AsyncMock) -> None:
    desc_json = _make_9734_json()
    desc_hash = hashlib.sha256(desc_json.encode("utf-8")).hexdigest()
    receipt = _make_9735(description_json=desc_json)
    invoice = _bolt11_mock(amount_msats=0, description_hash=desc_hash)
    zap_req = _make_9734_event(desc_json)

    await _run(receipt, invoice, zap_req, send_dm, api_client)

    api_client.mark_job_paid.assert_not_called()
    send_dm.assert_not_called()


# -- CHECK 2: description_hash mismatch ---------------------------------------


@pytest.mark.asyncio
async def test_reject_description_hash_mismatch(api_client: AsyncMock, send_dm: AsyncMock) -> None:
    receipt, desc_json, _, zap_req = _valid_set()
    invoice = _bolt11_mock(description_hash="00" * 32)

    await _run(receipt, invoice, zap_req, send_dm, api_client)

    api_client.mark_job_paid.assert_not_called()
    send_dm.assert_not_called()


# -- CHECK 3: Invalid 9734 (not valid JSON event) -----------------------------


@pytest.mark.asyncio
async def test_reject_invalid_9734(api_client: AsyncMock, send_dm: AsyncMock) -> None:
    """description tag is valid JSON but not a valid nostr event."""
    garbage = '{"foo":"bar"}'
    desc_hash = hashlib.sha256(garbage.encode("utf-8")).hexdigest()
    receipt = _make_9735(description_json=garbage)
    invoice = _bolt11_mock(description_hash=desc_hash)

    with (
        patch("zap_handler.bolt11_lib.decode", return_value=invoice),
        patch("zap_handler.NostrEvent.from_json", side_effect=Exception("invalid event")),
    ):
        await zap_handler.handle_zap_receipt(
            receipt, send_dm, BOT_PK, PROVIDER_PK, api_client,
        )

    api_client.mark_job_paid.assert_not_called()
    send_dm.assert_not_called()


# -- CHECK 3b: Bad 9734 signature ---------------------------------------------


@pytest.mark.asyncio
async def test_reject_bad_9734_signature(api_client: AsyncMock, send_dm: AsyncMock) -> None:
    desc_json = _make_9734_json()
    desc_hash = hashlib.sha256(desc_json.encode("utf-8")).hexdigest()
    receipt = _make_9735(description_json=desc_json)
    invoice = _bolt11_mock(description_hash=desc_hash)
    zap_req = _make_9734_event(desc_json, verify_result=False)

    await _run(receipt, invoice, zap_req, send_dm, api_client)

    api_client.mark_job_paid.assert_not_called()
    send_dm.assert_not_called()


# -- CHECK 4: Wrong kind in 9734 ----------------------------------------------


@pytest.mark.asyncio
async def test_reject_wrong_kind_9734(api_client: AsyncMock, send_dm: AsyncMock) -> None:
    desc_json = _make_9734_json(kind_num=1)
    desc_hash = hashlib.sha256(desc_json.encode("utf-8")).hexdigest()
    receipt = _make_9735(description_json=desc_json)
    invoice = _bolt11_mock(description_hash=desc_hash)
    zap_req = _make_9734_event(desc_json)  # kind=1 from JSON

    await _run(receipt, invoice, zap_req, send_dm, api_client)

    api_client.mark_job_paid.assert_not_called()
    send_dm.assert_not_called()


# -- CHECK 5: Wrong p-tag -----------------------------------------------------


@pytest.mark.asyncio
async def test_reject_wrong_p_tag(api_client: AsyncMock, send_dm: AsyncMock) -> None:
    desc_json = _make_9734_json(p_hex=ATTACKER_PK)
    desc_hash = hashlib.sha256(desc_json.encode("utf-8")).hexdigest()
    receipt = _make_9735(description_json=desc_json)
    invoice = _bolt11_mock(description_hash=desc_hash)
    zap_req = _make_9734_event(desc_json)

    await _run(receipt, invoice, zap_req, send_dm, api_client)

    api_client.mark_job_paid.assert_not_called()
    send_dm.assert_not_called()


# -- CHECK 6: Amount mismatch -------------------------------------------------


@pytest.mark.asyncio
async def test_reject_amount_mismatch(api_client: AsyncMock, send_dm: AsyncMock) -> None:
    """9734 says 3M msats, bolt11 says 1M msats."""
    desc_json = _make_9734_json(amount_msats=3_000_000)
    desc_hash = hashlib.sha256(desc_json.encode("utf-8")).hexdigest()
    receipt = _make_9735(description_json=desc_json)
    invoice = _bolt11_mock(amount_msats=1_000_000, description_hash=desc_hash)
    zap_req = _make_9734_event(desc_json)

    await _run(receipt, invoice, zap_req, send_dm, api_client)

    api_client.mark_job_paid.assert_not_called()
    send_dm.assert_not_called()


# -- Happy path: valid zap with job_id ----------------------------------------


@pytest.mark.asyncio
async def test_valid_zap_with_job_id(api_client: AsyncMock, send_dm: AsyncMock) -> None:
    receipt, desc_json, invoice, zap_req = _valid_set(job_id="job-123")

    await _run(receipt, invoice, zap_req, send_dm, api_client)

    api_client.mark_job_paid.assert_called_once()
    call_args = api_client.mark_job_paid.call_args
    assert call_args[0][0] == "job-123"
    send_dm.assert_called_once()
    assert "received" in send_dm.call_args[0][1].lower()


# -- Already paid (409) -------------------------------------------------------


@pytest.mark.asyncio
async def test_valid_zap_already_paid(api_client: AsyncMock, send_dm: AsyncMock) -> None:
    api_client.mark_job_paid.return_value = {"status_code": 409, "data": {"error": "Already paid"}}
    receipt, desc_json, invoice, zap_req = _valid_set(job_id="job-123")

    await _run(receipt, invoice, zap_req, send_dm, api_client)

    api_client.mark_job_paid.assert_called_once()
    # No DM for already-paid
    send_dm.assert_not_called()


# -- Valid zap without job_id --------------------------------------------------


@pytest.mark.asyncio
async def test_valid_zap_no_job_id(api_client: AsyncMock, send_dm: AsyncMock) -> None:
    receipt, desc_json, invoice, zap_req = _valid_set(job_id=None)

    await _run(receipt, invoice, zap_req, send_dm, api_client)

    api_client.mark_job_paid.assert_not_called()
    send_dm.assert_called_once()
    assert "no job reference" in send_dm.call_args[0][1].lower()


# -- Unregistered user ---------------------------------------------------------


@pytest.mark.asyncio
async def test_unregistered_user_zap(api_client: AsyncMock, send_dm: AsyncMock) -> None:
    api_client.get_user.return_value = None
    receipt, desc_json, invoice, zap_req = _valid_set(job_id="job-123")

    await _run(receipt, invoice, zap_req, send_dm, api_client)

    api_client.mark_job_paid.assert_not_called()
    send_dm.assert_called_once()
    assert "No account found" in send_dm.call_args[0][1]
