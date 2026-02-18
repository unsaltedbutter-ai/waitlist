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


# -- create_otp ----------------------------------------------------------------


class TestCreateOtp:
    def setup_method(self):
        api_client.init(base_url="https://example.com", hmac_secret="testsecret")

    @pytest.mark.asyncio
    async def test_create_otp_success(self):
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {"code": "123456789012"}
        mock_resp.raise_for_status = MagicMock()

        with patch("api_client._request", AsyncMock(return_value=mock_resp)) as mock_req:
            result = await api_client.create_otp("aabb")

        assert result == "123456789012"
        mock_req.assert_awaited_once_with("POST", "/api/agent/otp", body='{"npub_hex": "aabb"}')

    @pytest.mark.asyncio
    async def test_create_otp_raises_on_error(self):
        mock_resp = MagicMock()
        mock_resp.status_code = 500
        mock_resp.raise_for_status.side_effect = Exception("server error")

        with patch("api_client._request", AsyncMock(return_value=mock_resp)):
            with pytest.raises(Exception, match="server error"):
                await api_client.create_otp("aabb")


# -- add_to_waitlist -----------------------------------------------------------


class TestAddToWaitlist:
    def setup_method(self):
        api_client.init(base_url="https://example.com", hmac_secret="testsecret")

    @pytest.mark.asyncio
    async def test_add_new(self):
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {"status": "added", "invite_code": None}
        mock_resp.raise_for_status = MagicMock()

        with patch("api_client._request", AsyncMock(return_value=mock_resp)) as mock_req:
            result = await api_client.add_to_waitlist("aabb")

        assert result["status"] == "added"
        assert result["invite_code"] is None
        mock_req.assert_awaited_once_with("POST", "/api/agent/waitlist", body='{"npub_hex": "aabb"}')

    @pytest.mark.asyncio
    async def test_already_invited(self):
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {"status": "already_invited", "invite_code": "ABC123"}
        mock_resp.raise_for_status = MagicMock()

        with patch("api_client._request", AsyncMock(return_value=mock_resp)):
            result = await api_client.add_to_waitlist("aabb")

        assert result["status"] == "already_invited"
        assert result["invite_code"] == "ABC123"


# -- get_pending_invite_dms ---------------------------------------------------


class TestGetPendingInviteDms:
    def setup_method(self):
        api_client.init(base_url="https://example.com", hmac_secret="testsecret")

    @pytest.mark.asyncio
    async def test_returns_pending_list(self):
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {"pending": [
            {"id": "uuid-1", "nostr_npub": "aabb", "invite_code": "CODE1"},
        ]}
        mock_resp.raise_for_status = MagicMock()

        with patch("api_client._request", AsyncMock(return_value=mock_resp)) as mock_req:
            result = await api_client.get_pending_invite_dms()

        assert len(result) == 1
        assert result[0]["id"] == "uuid-1"
        mock_req.assert_awaited_once_with("GET", "/api/agent/waitlist/pending-invites")

    @pytest.mark.asyncio
    async def test_returns_empty_list(self):
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {"pending": []}
        mock_resp.raise_for_status = MagicMock()

        with patch("api_client._request", AsyncMock(return_value=mock_resp)):
            result = await api_client.get_pending_invite_dms()

        assert result == []


# -- mark_invite_dm_sent ------------------------------------------------------


class TestMarkInviteDmSent:
    def setup_method(self):
        api_client.init(base_url="https://example.com", hmac_secret="testsecret")

    @pytest.mark.asyncio
    async def test_success(self):
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.raise_for_status = MagicMock()

        with patch("api_client._request", AsyncMock(return_value=mock_resp)) as mock_req:
            await api_client.mark_invite_dm_sent("uuid-1")

        mock_req.assert_awaited_once_with("POST", "/api/agent/waitlist/uuid-1/dm-sent")

    @pytest.mark.asyncio
    async def test_raises_on_404(self):
        mock_resp = MagicMock()
        mock_resp.status_code = 404
        mock_resp.raise_for_status.side_effect = Exception("not found")

        with patch("api_client._request", AsyncMock(return_value=mock_resp)):
            with pytest.raises(Exception, match="not found"):
                await api_client.mark_invite_dm_sent("nonexistent")


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
