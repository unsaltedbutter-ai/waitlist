"""Tests for TTS Bot zap receipt handling.

Tests the NostrHandler.handle_zap() method: job matching, overpayment,
underpayment, no pending job, already paid (409), and synthesis trigger.

Run: PYTHONPATH=. python3 -m pytest tts_bot/tests/test_zap_handler.py -v
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from shared.zap_verify import ValidatedZap
from tts_bot.nostr_handler import NostrHandler

# -- Constants -----------------------------------------------------------------

SENDER_HEX = "cc" * 32
ZAP_EVENT_ID = "ab" * 32
JOB_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
CACHE_ID = "11111111-2222-3333-4444-555555555555"


# -- Fixtures ------------------------------------------------------------------


def _make_config() -> MagicMock:
    cfg = MagicMock()
    cfg.api_base_url = "https://unsaltedbutter.ai"
    cfg.default_voice = "af_heart"
    cfg.max_plays = 3
    return cfg


def _make_api() -> AsyncMock:
    api = AsyncMock()
    api.get_pending_audio_job.return_value = None
    api.confirm_audio_payment.return_value = {
        "status_code": 200,
        "id": JOB_ID,
        "requester_npub": SENDER_HEX,
        "amount_sats": 500,
        "was_cached": False,
        "audio_cache_id": CACHE_ID,
        "tweet_text": "Hello world",
        "tweet_author": "Test User (@test)",
    }
    return api


def _make_handler(api: AsyncMock | None = None) -> tuple[NostrHandler, AsyncMock, AsyncMock]:
    """Create handler with mocked dependencies. Returns (handler, api, send_dm)."""
    a = api or _make_api()
    send_dm = AsyncMock()
    tts_agent = AsyncMock()

    handler = NostrHandler(
        config=_make_config(),
        api=a,
        tts_agent=tts_agent,
        send_dm_fn=send_dm,
    )
    return handler, a, send_dm


def _make_zap(amount_sats: int = 500) -> ValidatedZap:
    return ValidatedZap(
        event_id=ZAP_EVENT_ID,
        sender_hex=SENDER_HEX,
        amount_sats=amount_sats,
        bolt11="lnbc500n1fake",
    )


# -- Tests ---------------------------------------------------------------------


@pytest.mark.asyncio
async def test_zap_no_pending_job() -> None:
    """Zap arrives but user has no pending audio job."""
    handler, api, send_dm = _make_handler()
    api.get_pending_audio_job.return_value = None

    await handler.handle_zap(_make_zap())

    api.confirm_audio_payment.assert_not_called()
    send_dm.assert_called_once()
    assert "no open invoice" in send_dm.call_args[0][1].lower()


@pytest.mark.asyncio
async def test_zap_underpayment() -> None:
    """Zap amount is less than the job requires."""
    handler, api, send_dm = _make_handler()
    api.get_pending_audio_job.return_value = {
        "has_active": True,
        "job_id": JOB_ID,
        "status": "pending_payment",
        "amount_sats": 500,
        "was_cached": False,
        "audio_cache_id": CACHE_ID,
    }

    await handler.handle_zap(_make_zap(amount_sats=100))

    api.confirm_audio_payment.assert_not_called()
    send_dm.assert_called_once()
    assert "requires 500" in send_dm.call_args[0][1].lower()


@pytest.mark.asyncio
async def test_zap_exact_payment_triggers_synthesis() -> None:
    """Zap matches exactly: marks paid, triggers synthesis."""
    handler, api, send_dm = _make_handler()
    api.get_pending_audio_job.return_value = {
        "has_active": True,
        "job_id": JOB_ID,
        "status": "pending_payment",
        "amount_sats": 500,
        "was_cached": False,
        "audio_cache_id": CACHE_ID,
    }

    with patch.object(handler, "handle_payment_received", new_callable=AsyncMock) as mock_synth:
        await handler.handle_zap(_make_zap(amount_sats=500))

    api.confirm_audio_payment.assert_called_once_with(JOB_ID, ZAP_EVENT_ID)
    mock_synth.assert_called_once()
    call_kwargs = mock_synth.call_args[1]
    assert call_kwargs["requester_npub"] == SENDER_HEX
    assert call_kwargs["audio_job_id"] == JOB_ID


@pytest.mark.asyncio
async def test_zap_overpayment_accepted() -> None:
    """Zap exceeds job amount: still accepted."""
    handler, api, send_dm = _make_handler()
    api.get_pending_audio_job.return_value = {
        "has_active": True,
        "job_id": JOB_ID,
        "status": "pending_payment",
        "amount_sats": 500,
        "was_cached": False,
        "audio_cache_id": CACHE_ID,
    }

    with patch.object(handler, "handle_payment_received", new_callable=AsyncMock) as mock_synth:
        await handler.handle_zap(_make_zap(amount_sats=1000))

    api.confirm_audio_payment.assert_called_once()
    mock_synth.assert_called_once()


@pytest.mark.asyncio
async def test_zap_already_paid_409() -> None:
    """VPS returns 409 (already paid): no synthesis, no DM."""
    handler, api, send_dm = _make_handler()
    api.get_pending_audio_job.return_value = {
        "has_active": True,
        "job_id": JOB_ID,
        "status": "pending_payment",
        "amount_sats": 500,
        "was_cached": False,
        "audio_cache_id": CACHE_ID,
    }
    api.confirm_audio_payment.return_value = {"status_code": 409}

    with patch.object(handler, "handle_payment_received", new_callable=AsyncMock) as mock_synth:
        await handler.handle_zap(_make_zap())

    api.confirm_audio_payment.assert_called_once()
    mock_synth.assert_not_called()
    send_dm.assert_not_called()


@pytest.mark.asyncio
async def test_zap_api_error_sends_dm() -> None:
    """API error confirming payment: DM user about the issue."""
    handler, api, send_dm = _make_handler()
    api.get_pending_audio_job.return_value = {
        "has_active": True,
        "job_id": JOB_ID,
        "status": "pending_payment",
        "amount_sats": 500,
        "was_cached": False,
        "audio_cache_id": CACHE_ID,
    }
    api.confirm_audio_payment.side_effect = Exception("connection error")

    await handler.handle_zap(_make_zap())

    send_dm.assert_called_once()
    assert "error" in send_dm.call_args[0][1].lower()


@pytest.mark.asyncio
async def test_zap_cached_job_passes_was_cached() -> None:
    """Zap for a cached job passes was_cached=True to synthesis."""
    handler, api, send_dm = _make_handler()
    api.get_pending_audio_job.return_value = {
        "has_active": True,
        "job_id": JOB_ID,
        "status": "pending_payment",
        "amount_sats": 375,
        "was_cached": True,
        "audio_cache_id": CACHE_ID,
    }
    api.confirm_audio_payment.return_value = {
        "status_code": 200,
        "id": JOB_ID,
        "was_cached": True,
        "audio_cache_id": CACHE_ID,
        "tweet_text": "Cached tweet",
        "tweet_author": None,
    }

    with patch.object(handler, "handle_payment_received", new_callable=AsyncMock) as mock_synth:
        await handler.handle_zap(_make_zap(amount_sats=375))

    call_kwargs = mock_synth.call_args[1]
    assert call_kwargs["was_cached"] is True
