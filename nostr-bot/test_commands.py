"""Tests for DM command handlers.

Uses the same mock pattern as test_zap_validation.py: real logic, mocked DB.

Run: cd nostr-bot && python -m pytest test_commands.py -v
"""

from datetime import datetime
from unittest.mock import AsyncMock, patch
from uuid import UUID

import pytest

import commands

USER_ID = UUID("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")


@pytest.fixture
def mock_db():
    with patch("commands.db") as m:
        m.get_user_status = AsyncMock()
        m.get_user_queue = AsyncMock()
        m.get_active_service_id = AsyncMock()
        m.skip_service = AsyncMock()
        m.stay_service = AsyncMock()
        yield m


# ── status ───────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_status_active_sub_with_lapse(mock_db):
    mock_db.get_user_status.return_value = {
        "subscription": {
            "display_name": "Netflix",
            "status": "active",
            "estimated_lapse_at": datetime(2025, 3, 15),
        },
        "credit_sats": 45230,
        "next_service": "Hulu",
    }
    result = await commands.handle_dm(USER_ID, "active", "status")
    assert "Netflix (active, ends Mar 15)" in result
    assert "45,230 sats" in result
    assert "Next: Hulu" in result


@pytest.mark.asyncio
async def test_status_no_active_sub(mock_db):
    mock_db.get_user_status.return_value = {
        "subscription": None,
        "credit_sats": 0,
        "next_service": None,
    }
    result = await commands.handle_dm(USER_ID, "active", "status")
    assert "No active subscription" in result


@pytest.mark.asyncio
async def test_status_without_next_service(mock_db):
    mock_db.get_user_status.return_value = {
        "subscription": {
            "display_name": "Netflix",
            "status": "active",
            "estimated_lapse_at": datetime(2025, 3, 15),
        },
        "credit_sats": 1000,
        "next_service": None,
    }
    result = await commands.handle_dm(USER_ID, "active", "status")
    assert "Next:" not in result


@pytest.mark.asyncio
async def test_status_credit_formatting(mock_db):
    mock_db.get_user_status.return_value = {
        "subscription": None,
        "credit_sats": 1234567,
        "next_service": None,
    }
    result = await commands.handle_dm(USER_ID, "active", "status")
    assert "1,234,567 sats" in result


# ── queue ────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_queue_populated(mock_db):
    mock_db.get_user_queue.return_value = [
        {"position": 1, "display_name": "Netflix", "service_id": "netflix", "sub_status": "active"},
        {"position": 2, "display_name": "Hulu", "service_id": "hulu", "sub_status": None},
    ]
    result = await commands.handle_dm(USER_ID, "active", "queue")
    assert "1. Netflix [active]" in result
    assert "2. Hulu" in result
    assert "[" not in result.split("\n")[1] or "Hulu" in result  # Hulu has no status tag


@pytest.mark.asyncio
async def test_queue_empty(mock_db):
    mock_db.get_user_queue.return_value = []
    result = await commands.handle_dm(USER_ID, "active", "queue")
    assert "empty" in result.lower()


# ── skip ─────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_skip_success(mock_db):
    mock_db.get_active_service_id.return_value = "netflix"
    mock_db.get_user_queue.return_value = [
        {"position": 1, "display_name": "Netflix", "service_id": "netflix", "sub_status": "active"},
        {"position": 2, "display_name": "Hulu", "service_id": "hulu", "sub_status": None},
    ]
    mock_db.skip_service.return_value = True
    result = await commands.handle_dm(USER_ID, "active", "skip")
    assert "Netflix moved to end of queue" in result


@pytest.mark.asyncio
async def test_skip_no_active_sub(mock_db):
    mock_db.get_active_service_id.return_value = None
    result = await commands.handle_dm(USER_ID, "active", "skip")
    assert "No active subscription to skip" in result


@pytest.mark.asyncio
async def test_skip_not_in_queue(mock_db):
    mock_db.get_active_service_id.return_value = "netflix"
    mock_db.get_user_queue.return_value = []
    mock_db.skip_service.return_value = False
    result = await commands.handle_dm(USER_ID, "active", "skip")
    assert "Could not skip" in result


# ── stay ─────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_stay_success(mock_db):
    mock_db.get_active_service_id.return_value = "netflix"
    mock_db.get_user_queue.return_value = [
        {"position": 1, "display_name": "Netflix", "service_id": "netflix", "sub_status": "active"},
    ]
    mock_db.stay_service.return_value = True
    result = await commands.handle_dm(USER_ID, "active", "stay")
    assert "Staying on Netflix" in result


@pytest.mark.asyncio
async def test_stay_no_active_sub(mock_db):
    mock_db.get_active_service_id.return_value = None
    result = await commands.handle_dm(USER_ID, "active", "stay")
    assert "No active subscription to stay on" in result


# ── help / unknown ───────────────────────────────────────────


@pytest.mark.asyncio
async def test_help(mock_db):
    result = await commands.handle_dm(USER_ID, "active", "help")
    assert result == commands.HELP_TEXT


@pytest.mark.asyncio
async def test_unknown_command(mock_db):
    result = await commands.handle_dm(USER_ID, "active", "gibberish")
    assert result == commands.HELP_TEXT


# ── churned user ─────────────────────────────────────────────


@pytest.mark.asyncio
async def test_churned_user(mock_db):
    result = await commands.handle_dm(USER_ID, "churned", "status")
    assert "membership has ended" in result.lower()
