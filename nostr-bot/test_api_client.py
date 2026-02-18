"""Tests for the HMAC-authenticated API client.

Run: cd nostr-bot && python -m pytest test_api_client.py -v
"""

import hashlib
import hmac
import json
import time
from unittest.mock import AsyncMock, patch, MagicMock

import pytest

import api_client


# -- init ----------------------------------------------------------------------


class TestInit:
    def test_init_with_args(self):
        api_client.init(base_url="https://example.com", hmac_secret="testsecret")
        assert api_client._BASE_URL == "https://example.com"
        assert api_client._HMAC_SECRET == "testsecret"

    def test_init_strips_trailing_slash(self):
        api_client.init(base_url="https://example.com/", hmac_secret="testsecret")
        assert api_client._BASE_URL == "https://example.com"

    def test_init_missing_base_url(self):
        with patch.dict("os.environ", {}, clear=True):
            with pytest.raises(ValueError, match="API_BASE_URL"):
                api_client.init(base_url="", hmac_secret="secret")

    def test_init_missing_secret(self):
        with patch.dict("os.environ", {}, clear=True):
            with pytest.raises(ValueError, match="AGENT_HMAC_SECRET"):
                api_client.init(base_url="https://example.com", hmac_secret="")

    def test_init_from_env(self):
        with patch.dict("os.environ", {"API_BASE_URL": "https://env.example.com", "AGENT_HMAC_SECRET": "envsecret"}):
            api_client.init()
            assert api_client._BASE_URL == "https://env.example.com"
            assert api_client._HMAC_SECRET == "envsecret"


# -- _sign ---------------------------------------------------------------------


class TestSign:
    def setup_method(self):
        api_client.init(base_url="https://example.com", hmac_secret="testsecret123")

    def test_sign_returns_required_headers(self):
        headers = api_client._sign("GET", "/api/test", "")
        assert "X-Agent-Timestamp" in headers
        assert "X-Agent-Nonce" in headers
        assert "X-Agent-Signature" in headers

    def test_sign_timestamp_is_recent(self):
        headers = api_client._sign("GET", "/api/test", "")
        ts = int(headers["X-Agent-Timestamp"])
        assert abs(ts - int(time.time())) <= 2

    def test_sign_nonce_is_unique(self):
        h1 = api_client._sign("GET", "/api/test", "")
        h2 = api_client._sign("GET", "/api/test", "")
        assert h1["X-Agent-Nonce"] != h2["X-Agent-Nonce"]

    def test_sign_produces_valid_hmac(self):
        body = '{"foo": "bar"}'
        headers = api_client._sign("POST", "/api/test", body)
        timestamp = headers["X-Agent-Timestamp"]
        nonce = headers["X-Agent-Nonce"]
        signature = headers["X-Agent-Signature"]

        body_hash = hashlib.sha256(body.encode("utf-8")).hexdigest()
        message = timestamp + nonce + "POST" + "/api/test" + body_hash
        expected = hmac.new("testsecret123".encode("utf-8"), message.encode("utf-8"), hashlib.sha256).hexdigest()
        assert signature == expected

    def test_sign_empty_body(self):
        headers = api_client._sign("GET", "/api/test", "")
        # Should still produce a valid signature (empty body hashes to sha256 of "")
        assert len(headers["X-Agent-Signature"]) == 64


# -- get_user ------------------------------------------------------------------


class TestGetUser:
    def setup_method(self):
        api_client.init(base_url="https://example.com", hmac_secret="testsecret")

    @pytest.mark.asyncio
    async def test_get_user_success(self):
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {"user": {"id": "123"}, "services": [], "queue": [], "active_jobs": []}
        mock_resp.raise_for_status = MagicMock()

        with patch("api_client._request", AsyncMock(return_value=mock_resp)):
            result = await api_client.get_user("abc123")

        assert result is not None
        assert result["user"]["id"] == "123"

    @pytest.mark.asyncio
    async def test_get_user_not_found(self):
        mock_resp = MagicMock()
        mock_resp.status_code = 404

        with patch("api_client._request", AsyncMock(return_value=mock_resp)):
            result = await api_client.get_user("nonexistent")

        assert result is None

    @pytest.mark.asyncio
    async def test_get_user_uses_correct_path(self):
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {"user": {}}
        mock_resp.raise_for_status = MagicMock()

        with patch("api_client._request", AsyncMock(return_value=mock_resp)) as mock_req:
            await api_client.get_user("abc123hex")
            mock_req.assert_awaited_once_with("GET", "/api/agent/users/abc123hex")


# -- create_on_demand_job ------------------------------------------------------


class TestCreateOnDemandJob:
    def setup_method(self):
        api_client.init(base_url="https://example.com", hmac_secret="testsecret")

    @pytest.mark.asyncio
    async def test_create_job_success(self):
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {"job_id": "job-1", "status": "pending"}

        with patch("api_client._request", AsyncMock(return_value=mock_resp)) as mock_req:
            result = await api_client.create_on_demand_job("npub123", "netflix", "cancel")

        assert result["status_code"] == 200
        assert result["data"]["job_id"] == "job-1"

        # Verify correct path and body
        call_args = mock_req.call_args
        assert call_args[0][0] == "POST"
        assert call_args[0][1] == "/api/agent/users/npub123/on-demand"
        body = json.loads(call_args[1]["body"])
        assert body["service"] == "netflix"
        assert body["action"] == "cancel"

    @pytest.mark.asyncio
    async def test_create_job_debt_blocked(self):
        mock_resp = MagicMock()
        mock_resp.status_code = 403
        mock_resp.json.return_value = {"error": "Outstanding debt", "debt_sats": 3000}

        with patch("api_client._request", AsyncMock(return_value=mock_resp)):
            result = await api_client.create_on_demand_job("npub123", "netflix", "cancel")

        assert result["status_code"] == 403
        assert result["data"]["debt_sats"] == 3000


# -- mark_job_paid -------------------------------------------------------------


class TestMarkJobPaid:
    def setup_method(self):
        api_client.init(base_url="https://example.com", hmac_secret="testsecret")

    @pytest.mark.asyncio
    async def test_mark_paid_success(self):
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {"success": True}

        with patch("api_client._request", AsyncMock(return_value=mock_resp)):
            result = await api_client.mark_job_paid("job-123", zap_event_id="evt-abc")

        assert result["status_code"] == 200

    @pytest.mark.asyncio
    async def test_mark_paid_without_zap_event_id(self):
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {"success": True}

        with patch("api_client._request", AsyncMock(return_value=mock_resp)) as mock_req:
            await api_client.mark_job_paid("job-123")

        call_args = mock_req.call_args
        body = call_args[1]["body"]
        assert body == ""  # empty body when no zap_event_id

    @pytest.mark.asyncio
    async def test_mark_paid_with_zap_event_id(self):
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {"success": True}

        with patch("api_client._request", AsyncMock(return_value=mock_resp)) as mock_req:
            await api_client.mark_job_paid("job-123", zap_event_id="evt-abc")

        call_args = mock_req.call_args
        body = json.loads(call_args[1]["body"])
        assert body["zap_event_id"] == "evt-abc"
