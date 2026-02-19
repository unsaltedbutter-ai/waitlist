"""Tests for the orchestrator's HMAC-authenticated API client.

Run: cd orchestrator && python -m pytest tests/test_api_client.py -v
"""

from __future__ import annotations

import hashlib
import hmac
import json
from unittest.mock import patch

import httpx
import pytest
import pytest_asyncio
import respx

from api_client import ApiClient

BASE_URL = "https://test.example.com"
HMAC_SECRET = "test-secret"


@pytest_asyncio.fixture
async def client(respx_mock: respx.MockRouter) -> ApiClient:
    """Create an ApiClient with a respx-mocked transport, yield, then close.

    The respx_mock fixture is function-scoped, so each test gets a clean
    router. We pass it as a transport to the httpx.AsyncClient so that
    all requests hit the mock regardless of creation order.
    """
    c = ApiClient(BASE_URL, HMAC_SECRET)
    await c.start()
    yield c
    await c.close()


# -- Signing -----------------------------------------------------------------


def test_sign_generates_valid_headers() -> None:
    """All three HMAC headers are present with expected formats."""
    c = ApiClient(BASE_URL, HMAC_SECRET)
    headers = c._sign("GET", "/api/agent/heartbeat", "")

    assert "X-Agent-Timestamp" in headers
    assert "X-Agent-Nonce" in headers
    assert "X-Agent-Signature" in headers

    # Timestamp is numeric
    assert headers["X-Agent-Timestamp"].isdigit()
    # Nonce is 32-char hex (16 bytes)
    assert len(headers["X-Agent-Nonce"]) == 32
    int(headers["X-Agent-Nonce"], 16)  # must parse as hex
    # Signature is 64-char hex (sha256)
    assert len(headers["X-Agent-Signature"]) == 64
    int(headers["X-Agent-Signature"], 16)


@patch("api_client.secrets.token_hex", return_value="a" * 32)
@patch("api_client.time.time", return_value=1700000000.0)
def test_sign_deterministic_with_fixed_time(
    _mock_time: object, _mock_token: object
) -> None:
    """With mocked time and nonce, the signature is deterministic."""
    c = ApiClient(BASE_URL, HMAC_SECRET)
    headers = c._sign("POST", "/api/agent/otp", '{"npub_hex":"abc123"}')

    assert headers["X-Agent-Timestamp"] == "1700000000"
    assert headers["X-Agent-Nonce"] == "a" * 32

    # Recompute expected signature
    body_hash = hashlib.sha256(
        '{"npub_hex":"abc123"}'.encode("utf-8")
    ).hexdigest()
    message = "1700000000" + "a" * 32 + "POST" + "/api/agent/otp" + body_hash
    expected_sig = hmac.new(
        HMAC_SECRET.encode("utf-8"),
        message.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()

    assert headers["X-Agent-Signature"] == expected_sig


# -- Client lifecycle --------------------------------------------------------


@pytest.mark.asyncio
async def test_request_without_start_raises() -> None:
    """Calling _request before start() raises RuntimeError."""
    c = ApiClient(BASE_URL, HMAC_SECRET)
    with pytest.raises(RuntimeError, match="not started"):
        await c._request("GET", "/api/agent/heartbeat")


# -- Users -------------------------------------------------------------------


@pytest.mark.asyncio
async def test_get_user_success(
    client: ApiClient, respx_mock: respx.MockRouter
) -> None:
    route = respx_mock.get(f"{BASE_URL}/api/agent/users/abc123").mock(
        return_value=httpx.Response(
            200,
            json={"id": "u1", "nostr_npub": "abc123", "status": "active"},
        )
    )
    result = await client.get_user("abc123")
    assert result is not None
    assert result["id"] == "u1"
    assert route.called


@pytest.mark.asyncio
async def test_get_user_not_found(
    client: ApiClient, respx_mock: respx.MockRouter
) -> None:
    respx_mock.get(f"{BASE_URL}/api/agent/users/missing").mock(
        return_value=httpx.Response(404, json={"error": "Not found"})
    )
    result = await client.get_user("missing")
    assert result is None


# -- OTP ---------------------------------------------------------------------


@pytest.mark.asyncio
async def test_create_otp(
    client: ApiClient, respx_mock: respx.MockRouter
) -> None:
    respx_mock.post(f"{BASE_URL}/api/agent/otp").mock(
        return_value=httpx.Response(200, json={"code": "123456789012"})
    )
    code = await client.create_otp("abc123")
    assert code == "123456789012"


# -- Waitlist ----------------------------------------------------------------


@pytest.mark.asyncio
async def test_add_to_waitlist(
    client: ApiClient, respx_mock: respx.MockRouter
) -> None:
    respx_mock.post(f"{BASE_URL}/api/agent/waitlist").mock(
        return_value=httpx.Response(
            200, json={"status": "waitlisted", "invite_code": None}
        )
    )
    result = await client.add_to_waitlist("abc123")
    assert result["status"] == "waitlisted"
    assert result["invite_code"] is None


@pytest.mark.asyncio
async def test_get_pending_invite_dms(
    client: ApiClient, respx_mock: respx.MockRouter
) -> None:
    respx_mock.get(f"{BASE_URL}/api/agent/waitlist/pending-invites").mock(
        return_value=httpx.Response(
            200, json={"pending": [{"id": "w1", "nostr_npub": "abc"}]}
        )
    )
    result = await client.get_pending_invite_dms()
    assert len(result) == 1
    assert result[0]["id"] == "w1"


@pytest.mark.asyncio
async def test_mark_invite_dm_sent(
    client: ApiClient, respx_mock: respx.MockRouter
) -> None:
    route = respx_mock.post(f"{BASE_URL}/api/agent/waitlist/w1/dm-sent").mock(
        return_value=httpx.Response(200, json={"ok": True})
    )
    await client.mark_invite_dm_sent("w1")
    assert route.called


# -- Jobs --------------------------------------------------------------------


@pytest.mark.asyncio
async def test_get_pending_jobs(
    client: ApiClient, respx_mock: respx.MockRouter
) -> None:
    jobs = [
        {"id": "j1", "service_id": "netflix", "action": "cancel"},
        {"id": "j2", "service_id": "hulu", "action": "resume"},
    ]
    respx_mock.get(f"{BASE_URL}/api/agent/jobs/pending").mock(
        return_value=httpx.Response(200, json={"jobs": jobs})
    )
    result = await client.get_pending_jobs()
    assert len(result) == 2
    assert result[0]["id"] == "j1"


@pytest.mark.asyncio
async def test_claim_jobs(
    client: ApiClient, respx_mock: respx.MockRouter
) -> None:
    respx_mock.post(f"{BASE_URL}/api/agent/jobs/claim").mock(
        return_value=httpx.Response(
            200,
            json={"claimed": [{"id": "j1"}], "blocked": ["j2"]},
        )
    )
    result = await client.claim_jobs(["j1", "j2"])
    assert len(result["claimed"]) == 1
    assert result["blocked"] == ["j2"]


@pytest.mark.asyncio
async def test_update_job_status(
    client: ApiClient, respx_mock: respx.MockRouter
) -> None:
    route = respx_mock.patch(f"{BASE_URL}/api/agent/jobs/j1/status").mock(
        return_value=httpx.Response(
            200, json={"job": {"id": "j1", "status": "active"}}
        )
    )
    result = await client.update_job_status(
        "j1", "active", billing_date="2026-03-15", amount_sats=3000
    )
    assert result["job"]["status"] == "active"

    # Verify kwargs were included in the request body
    sent_body = json.loads(route.calls[0].request.content)
    assert sent_body["status"] == "active"
    assert sent_body["billing_date"] == "2026-03-15"
    assert sent_body["amount_sats"] == 3000


# -- On-demand jobs ----------------------------------------------------------


@pytest.mark.asyncio
async def test_create_on_demand_job_success(
    client: ApiClient, respx_mock: respx.MockRouter
) -> None:
    respx_mock.post(f"{BASE_URL}/api/agent/users/abc123/on-demand").mock(
        return_value=httpx.Response(
            200, json={"job": {"id": "j1", "status": "pending"}}
        )
    )
    result = await client.create_on_demand_job("abc123", "netflix", "cancel")
    assert result["status_code"] == 200
    assert result["data"]["job"]["id"] == "j1"


@pytest.mark.asyncio
async def test_create_on_demand_job_debt(
    client: ApiClient, respx_mock: respx.MockRouter
) -> None:
    respx_mock.post(f"{BASE_URL}/api/agent/users/abc123/on-demand").mock(
        return_value=httpx.Response(
            403, json={"error": "Outstanding debt"}
        )
    )
    result = await client.create_on_demand_job("abc123", "netflix", "cancel")
    assert result["status_code"] == 403
    assert "debt" in result["data"]["error"].lower()


# -- Mark job paid -----------------------------------------------------------


@pytest.mark.asyncio
async def test_mark_job_paid(
    client: ApiClient, respx_mock: respx.MockRouter
) -> None:
    respx_mock.post(f"{BASE_URL}/api/agent/jobs/j1/paid").mock(
        return_value=httpx.Response(200, json={"status": "paid"})
    )
    result = await client.mark_job_paid("j1", zap_event_id="zap123")
    assert result["status_code"] == 200
    assert result["data"]["status"] == "paid"


# -- Credentials -------------------------------------------------------------


@pytest.mark.asyncio
async def test_get_credentials_success(
    client: ApiClient, respx_mock: respx.MockRouter
) -> None:
    respx_mock.get(f"{BASE_URL}/api/agent/credentials/abc123/netflix").mock(
        return_value=httpx.Response(
            200, json={"email": "user@test.com", "password": "s3cret"}
        )
    )
    result = await client.get_credentials("abc123", "netflix")
    assert result is not None
    assert result["email"] == "user@test.com"
    assert result["password"] == "s3cret"


@pytest.mark.asyncio
async def test_get_credentials_no_active_job(
    client: ApiClient, respx_mock: respx.MockRouter
) -> None:
    respx_mock.get(f"{BASE_URL}/api/agent/credentials/abc123/netflix").mock(
        return_value=httpx.Response(
            403, json={"error": "No active job for this user and service"}
        )
    )
    result = await client.get_credentials("abc123", "netflix")
    assert result is None


@pytest.mark.asyncio
async def test_get_credentials_not_found(
    client: ApiClient, respx_mock: respx.MockRouter
) -> None:
    respx_mock.get(f"{BASE_URL}/api/agent/credentials/abc123/netflix").mock(
        return_value=httpx.Response(404, json={"error": "Not found"})
    )
    result = await client.get_credentials("abc123", "netflix")
    assert result is None


@pytest.mark.asyncio
async def test_get_credentials_server_error_raises(
    client: ApiClient, respx_mock: respx.MockRouter
) -> None:
    respx_mock.get(f"{BASE_URL}/api/agent/credentials/abc123/netflix").mock(
        return_value=httpx.Response(500, json={"error": "Internal server error"})
    )
    with pytest.raises(httpx.HTTPStatusError):
        await client.get_credentials("abc123", "netflix")


# -- Invoices ----------------------------------------------------------------


@pytest.mark.asyncio
async def test_create_invoice(
    client: ApiClient, respx_mock: respx.MockRouter
) -> None:
    respx_mock.post(f"{BASE_URL}/api/agent/invoices").mock(
        return_value=httpx.Response(
            200,
            json={
                "invoice_id": "inv1",
                "bolt11": "lnbc3000n1...",
                "amount_sats": 3000,
            },
        )
    )
    result = await client.create_invoice("j1", 3000, "npub1abc")
    assert result["invoice_id"] == "inv1"
    assert result["bolt11"].startswith("lnbc")
    assert result["amount_sats"] == 3000


@pytest.mark.asyncio
async def test_get_invoice(
    client: ApiClient, respx_mock: respx.MockRouter
) -> None:
    respx_mock.get(f"{BASE_URL}/api/agent/invoices/inv1").mock(
        return_value=httpx.Response(
            200,
            json={
                "invoice_id": "inv1",
                "status": "invoice_sent",
                "amount_sats": 3000,
                "paid_at": None,
            },
        )
    )
    result = await client.get_invoice("inv1")
    assert result is not None
    assert result["status"] == "invoice_sent"


@pytest.mark.asyncio
async def test_get_invoice_not_found(
    client: ApiClient, respx_mock: respx.MockRouter
) -> None:
    respx_mock.get(f"{BASE_URL}/api/agent/invoices/missing").mock(
        return_value=httpx.Response(404, json={"error": "Invoice not found"})
    )
    result = await client.get_invoice("missing")
    assert result is None


# -- Heartbeat ---------------------------------------------------------------


@pytest.mark.asyncio
async def test_heartbeat_success(
    client: ApiClient, respx_mock: respx.MockRouter
) -> None:
    respx_mock.get(f"{BASE_URL}/api/agent/heartbeat").mock(
        return_value=httpx.Response(200, json={"ok": True})
    )
    result = await client.heartbeat()
    assert result is True


@pytest.mark.asyncio
async def test_heartbeat_failure(
    client: ApiClient, respx_mock: respx.MockRouter
) -> None:
    respx_mock.get(f"{BASE_URL}/api/agent/heartbeat").mock(
        return_value=httpx.Response(500, json={"error": "down"})
    )
    result = await client.heartbeat()
    assert result is False
