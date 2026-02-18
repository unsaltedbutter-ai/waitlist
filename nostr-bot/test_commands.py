"""Tests for DM command handlers (pay-per-action concierge model).

Uses the same mock pattern: real logic, mocked API client.

Run: cd nostr-bot && python -m pytest test_commands.py -v
"""

from unittest.mock import AsyncMock, patch

import pytest

import commands


NPUB_HEX = "aabbccdd" * 8


@pytest.fixture
def mock_api():
    with patch("commands.api_client") as m:
        m.create_on_demand_job = AsyncMock()
        m.get_user = AsyncMock()
        yield m


# -- cancel/resume (action commands) ------------------------------------------


@pytest.mark.asyncio
async def test_cancel_success(mock_api):
    mock_api.create_on_demand_job.return_value = {
        "status_code": 200,
        "data": {"job_id": "job-123", "status": "pending"},
    }
    result = await commands.handle_dm(NPUB_HEX, "cancel netflix")
    assert "Netflix cancel is queued" in result
    mock_api.create_on_demand_job.assert_awaited_once_with(NPUB_HEX, "netflix", "cancel")


@pytest.mark.asyncio
async def test_resume_success(mock_api):
    mock_api.create_on_demand_job.return_value = {
        "status_code": 200,
        "data": {"job_id": "job-456", "status": "pending"},
    }
    result = await commands.handle_dm(NPUB_HEX, "resume hulu")
    assert "Hulu resume is queued" in result
    mock_api.create_on_demand_job.assert_awaited_once_with(NPUB_HEX, "hulu", "resume")


@pytest.mark.asyncio
async def test_cancel_unknown_service(mock_api):
    result = await commands.handle_dm(NPUB_HEX, "cancel foobar")
    assert "Unknown service" in result
    mock_api.create_on_demand_job.assert_not_awaited()


@pytest.mark.asyncio
async def test_cancel_debt_blocked(mock_api):
    mock_api.create_on_demand_job.return_value = {
        "status_code": 403,
        "data": {"error": "Outstanding debt", "debt_sats": 3000},
    }
    result = await commands.handle_dm(NPUB_HEX, "cancel netflix")
    assert "outstanding balance" in result.lower()
    assert "3,000 sats" in result


@pytest.mark.asyncio
async def test_cancel_already_pending(mock_api):
    mock_api.create_on_demand_job.return_value = {
        "status_code": 409,
        "data": {"error": "A non-terminal job already exists"},
    }
    result = await commands.handle_dm(NPUB_HEX, "cancel netflix")
    assert "pending job" in result.lower()


@pytest.mark.asyncio
async def test_cancel_no_credentials(mock_api):
    mock_api.create_on_demand_job.return_value = {
        "status_code": 400,
        "data": {"error": "No credentials for service: netflix"},
    }
    result = await commands.handle_dm(NPUB_HEX, "cancel netflix")
    assert "credentials" in result.lower()


@pytest.mark.asyncio
async def test_cancel_user_not_found(mock_api):
    mock_api.create_on_demand_job.return_value = {
        "status_code": 404,
        "data": {"error": "User not found"},
    }
    result = await commands.handle_dm(NPUB_HEX, "cancel netflix")
    assert "not found" in result.lower()


@pytest.mark.asyncio
async def test_cancel_api_error(mock_api):
    mock_api.create_on_demand_job.side_effect = Exception("connection refused")
    result = await commands.handle_dm(NPUB_HEX, "cancel netflix")
    assert "something went wrong" in result.lower()


# -- service alias parsing -----------------------------------------------------


@pytest.mark.asyncio
async def test_service_aliases(mock_api):
    mock_api.create_on_demand_job.return_value = {
        "status_code": 200,
        "data": {"job_id": "job-1", "status": "pending"},
    }

    aliases = {
        "disney+": "disney_plus",
        "disney plus": "disney_plus",
        "apple tv+": "apple_tv",
        "appletv": "apple_tv",
        "paramount+": "paramount",
        "paramount plus": "paramount",
        "hbo": "max",
        "hbo max": "max",
        "max": "max",
        "peacock": "peacock",
    }

    for alias, expected_id in aliases.items():
        mock_api.create_on_demand_job.reset_mock()
        await commands.handle_dm(NPUB_HEX, f"cancel {alias}")
        mock_api.create_on_demand_job.assert_awaited_once_with(NPUB_HEX, expected_id, "cancel")


# -- status command ------------------------------------------------------------


@pytest.mark.asyncio
async def test_status_with_jobs_and_debt(mock_api):
    mock_api.get_user.return_value = {
        "user": {"id": "user-1", "nostr_npub": NPUB_HEX, "debt_sats": 3000, "onboarded_at": "2026-01-01", "created_at": "2026-01-01"},
        "services": [{"service_id": "netflix", "display_name": "Netflix"}],
        "queue": [
            {"service_id": "netflix", "position": 1, "plan_id": None},
            {"service_id": "hulu", "position": 2, "plan_id": None},
        ],
        "active_jobs": [
            {"id": "job-1", "service_id": "netflix", "action": "cancel", "status": "in_progress"},
        ],
    }
    result = await commands.handle_dm(NPUB_HEX, "status")
    assert "3,000 sats" in result
    assert "Netflix cancel: in_progress" in result
    assert "Queue: Netflix, Hulu" in result


@pytest.mark.asyncio
async def test_status_no_jobs(mock_api):
    mock_api.get_user.return_value = {
        "user": {"id": "user-1", "nostr_npub": NPUB_HEX, "debt_sats": 0, "onboarded_at": "2026-01-01", "created_at": "2026-01-01"},
        "services": [],
        "queue": [],
        "active_jobs": [],
    }
    result = await commands.handle_dm(NPUB_HEX, "status")
    assert "No active jobs" in result
    assert "outstanding" not in result.lower()


@pytest.mark.asyncio
async def test_status_user_not_found(mock_api):
    mock_api.get_user.return_value = None
    result = await commands.handle_dm(NPUB_HEX, "status")
    assert "not found" in result.lower()


@pytest.mark.asyncio
async def test_status_api_error(mock_api):
    mock_api.get_user.side_effect = Exception("timeout")
    result = await commands.handle_dm(NPUB_HEX, "status")
    assert "something went wrong" in result.lower()


# -- queue command -------------------------------------------------------------


@pytest.mark.asyncio
async def test_queue_populated(mock_api):
    mock_api.get_user.return_value = {
        "user": {"id": "user-1", "nostr_npub": NPUB_HEX, "debt_sats": 0, "onboarded_at": "2026-01-01", "created_at": "2026-01-01"},
        "services": [],
        "queue": [
            {"service_id": "netflix", "position": 1, "plan_id": None},
            {"service_id": "hulu", "position": 2, "plan_id": None},
        ],
        "active_jobs": [],
    }
    result = await commands.handle_dm(NPUB_HEX, "queue")
    assert "1. Netflix" in result
    assert "2. Hulu" in result


@pytest.mark.asyncio
async def test_queue_empty(mock_api):
    mock_api.get_user.return_value = {
        "user": {"id": "user-1", "nostr_npub": NPUB_HEX, "debt_sats": 0, "onboarded_at": "2026-01-01", "created_at": "2026-01-01"},
        "services": [],
        "queue": [],
        "active_jobs": [],
    }
    result = await commands.handle_dm(NPUB_HEX, "queue")
    assert "empty" in result.lower()


@pytest.mark.asyncio
async def test_queue_user_not_found(mock_api):
    mock_api.get_user.return_value = None
    result = await commands.handle_dm(NPUB_HEX, "queue")
    assert "not found" in result.lower()


# -- help / unknown commands ---------------------------------------------------


@pytest.mark.asyncio
async def test_help(mock_api):
    result = await commands.handle_dm(NPUB_HEX, "help")
    assert result == commands.HELP_TEXT


@pytest.mark.asyncio
async def test_unknown_command_returns_help(mock_api):
    result = await commands.handle_dm(NPUB_HEX, "gibberish")
    assert result == commands.HELP_TEXT


@pytest.mark.asyncio
async def test_help_mentions_cancel_resume():
    assert "cancel" in commands.HELP_TEXT
    assert "resume" in commands.HELP_TEXT
    assert "3,000 sats" in commands.HELP_TEXT


# -- HELP_TEXT does not contain old model terms --------------------------------


@pytest.mark.asyncio
async def test_help_no_old_model_references():
    old_terms = ["credit", "balance", "gift card", "skip", "stay", "pause", "zap me"]
    for term in old_terms:
        assert term not in commands.HELP_TEXT.lower(), f"HELP_TEXT still contains old model term: {term}"
