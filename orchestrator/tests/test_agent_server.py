"""Tests for the AgentCallbackServer (HTTP server for agent callbacks).

Run: cd orchestrator && python -m pytest tests/test_agent_server.py -v

Uses aiohttp's TestServer/TestClient to avoid binding real ports.
"""

from __future__ import annotations

import pytest
import pytest_asyncio
from aiohttp import web
from aiohttp.test_utils import TestClient as AioTestClient, TestServer

from agent_server import AgentCallbackServer

_server_key = web.AppKey("server", AgentCallbackServer)


def _build_app(server: AgentCallbackServer) -> web.Application:
    """Build the aiohttp app with routes, without starting a TCP listener.

    We reach into the server to register routes on a fresh Application,
    then hand it to aiohttp's TestServer which handles port binding.
    """
    app = web.Application()
    app.router.add_post("/callback/otp-needed", server._handle_otp_needed)
    app.router.add_post(
        "/callback/credential-needed", server._handle_credential_needed
    )
    app.router.add_post("/callback/result", server._handle_result)
    app.router.add_post("/cli-dispatch", server._handle_cli_dispatch)
    app.router.add_get("/cli-job/{job_id}", server._handle_cli_job)
    app.router.add_get("/health", server._handle_health)
    return app


@pytest_asyncio.fixture
async def aio_client() -> AioTestClient:
    """Yield an aiohttp test client wired to the callback server's routes."""
    server = AgentCallbackServer()
    app = _build_app(server)
    # Stash the server on the app so tests can register callbacks.
    app[_server_key] = server
    test_server = TestServer(app)
    client = AioTestClient(test_server)
    await client.start_server()
    yield client
    await client.close()


# -- OTP needed ----------------------------------------------------------------


@pytest.mark.asyncio
async def test_otp_needed_callback(aio_client: AioTestClient) -> None:
    """POST /callback/otp-needed fires the registered callback with correct args."""
    received = []

    async def on_otp(job_id: str, service: str, prompt: str | None) -> None:
        received.append((job_id, service, prompt))

    aio_client.app[_server_key].set_otp_callback(on_otp)

    resp = await aio_client.post(
        "/callback/otp-needed",
        json={"job_id": "j1", "service": "netflix", "prompt": "Enter the code"},
    )
    assert resp.status == 200
    body = await resp.json()
    assert body == {"ok": True}

    assert len(received) == 1
    assert received[0] == ("j1", "netflix", "Enter the code")


@pytest.mark.asyncio
async def test_otp_needed_missing_fields(aio_client: AioTestClient) -> None:
    """POST /callback/otp-needed with missing job_id returns 400."""
    resp = await aio_client.post(
        "/callback/otp-needed",
        json={"service": "hulu"},
    )
    assert resp.status == 400
    body = await resp.json()
    assert "job_id" in body["error"].lower() or "missing" in body["error"].lower()


@pytest.mark.asyncio
async def test_otp_needed_missing_service(aio_client: AioTestClient) -> None:
    """POST /callback/otp-needed with missing service returns 400."""
    resp = await aio_client.post(
        "/callback/otp-needed",
        json={"job_id": "j1"},
    )
    assert resp.status == 400


@pytest.mark.asyncio
async def test_otp_needed_invalid_json(aio_client: AioTestClient) -> None:
    """POST /callback/otp-needed with non-JSON body returns 400."""
    resp = await aio_client.post(
        "/callback/otp-needed",
        data=b"not json",
        headers={"Content-Type": "application/json"},
    )
    assert resp.status == 400


@pytest.mark.asyncio
async def test_no_otp_callback_set(aio_client: AioTestClient) -> None:
    """POST /callback/otp-needed without a callback registered still returns 200."""
    # No callback set on purpose.
    resp = await aio_client.post(
        "/callback/otp-needed",
        json={"job_id": "j1", "service": "netflix"},
    )
    assert resp.status == 200


@pytest.mark.asyncio
async def test_otp_callback_error_returns_500(aio_client: AioTestClient) -> None:
    """If the OTP callback raises, the server returns 500."""

    async def bad_callback(job_id: str, service: str, prompt: str | None) -> None:
        raise ValueError("boom")

    aio_client.app[_server_key].set_otp_callback(bad_callback)

    resp = await aio_client.post(
        "/callback/otp-needed",
        json={"job_id": "j1", "service": "netflix"},
    )
    assert resp.status == 500


# -- Result --------------------------------------------------------------------


@pytest.mark.asyncio
async def test_result_callback_success(aio_client: AioTestClient) -> None:
    """POST /callback/result with success=true fires the result callback."""
    received = []

    async def on_result(
        job_id: str,
        success: bool,
        access_end_date: str | None,
        error: str | None,
        duration_seconds: int,
        error_code: str | None = None,
        stats: dict | None = None,
    ) -> None:
        received.append((job_id, success, access_end_date, error, duration_seconds))

    aio_client.app[_server_key].set_result_callback(on_result)

    resp = await aio_client.post(
        "/callback/result",
        json={
            "job_id": "j1",
            "success": True,
            "access_end_date": "2026-03-15",
            "error": None,
            "duration_seconds": 42,
        },
    )
    assert resp.status == 200
    body = await resp.json()
    assert body == {"ok": True}

    assert len(received) == 1
    assert received[0] == ("j1", True, "2026-03-15", None, 42)


@pytest.mark.asyncio
async def test_result_callback_failure(aio_client: AioTestClient) -> None:
    """POST /callback/result with success=false and error populates correctly."""
    received = []

    async def on_result(
        job_id: str,
        success: bool,
        access_end_date: str | None,
        error: str | None,
        duration_seconds: int,
        error_code: str | None = None,
        stats: dict | None = None,
    ) -> None:
        received.append((job_id, success, access_end_date, error, duration_seconds))

    aio_client.app[_server_key].set_result_callback(on_result)

    resp = await aio_client.post(
        "/callback/result",
        json={
            "job_id": "j2",
            "success": False,
            "access_end_date": None,
            "error": "Login failed",
            "duration_seconds": 15,
        },
    )
    assert resp.status == 200

    assert len(received) == 1
    assert received[0] == ("j2", False, None, "Login failed", 15)


@pytest.mark.asyncio
async def test_result_callback_passes_error_code(aio_client: AioTestClient) -> None:
    """POST /callback/result with error_code passes it through to the callback."""
    received = []

    async def on_result(
        job_id: str,
        success: bool,
        access_end_date: str | None,
        error: str | None,
        duration_seconds: int,
        error_code: str | None,
        stats: dict | None = None,
    ) -> None:
        received.append((job_id, success, error, error_code))

    aio_client.app[_server_key].set_result_callback(on_result)

    resp = await aio_client.post(
        "/callback/result",
        json={
            "job_id": "j-cred",
            "success": False,
            "access_end_date": None,
            "error": "Sign-in failed: credentials rejected",
            "error_code": "credential_invalid",
            "duration_seconds": 30,
        },
    )
    assert resp.status == 200

    assert len(received) == 1
    assert received[0] == (
        "j-cred", False, "Sign-in failed: credentials rejected", "credential_invalid"
    )


@pytest.mark.asyncio
async def test_result_callback_null_error_code(aio_client: AioTestClient) -> None:
    """POST /callback/result without error_code passes None to the callback."""
    received = []

    async def on_result(
        job_id: str,
        success: bool,
        access_end_date: str | None,
        error: str | None,
        duration_seconds: int,
        error_code: str | None,
        stats: dict | None = None,
    ) -> None:
        received.append(error_code)

    aio_client.app[_server_key].set_result_callback(on_result)

    resp = await aio_client.post(
        "/callback/result",
        json={
            "job_id": "j1",
            "success": True,
            "duration_seconds": 10,
        },
    )
    assert resp.status == 200
    assert received == [None]


@pytest.mark.asyncio
async def test_result_missing_fields(aio_client: AioTestClient) -> None:
    """POST /callback/result with missing job_id returns 400."""
    resp = await aio_client.post(
        "/callback/result",
        json={"success": True},
    )
    assert resp.status == 400


@pytest.mark.asyncio
async def test_result_missing_success(aio_client: AioTestClient) -> None:
    """POST /callback/result with missing success returns 400."""
    resp = await aio_client.post(
        "/callback/result",
        json={"job_id": "j1"},
    )
    assert resp.status == 400


@pytest.mark.asyncio
async def test_result_duration_defaults_to_zero(aio_client: AioTestClient) -> None:
    """If duration_seconds is omitted, it defaults to 0."""
    received = []

    async def on_result(
        job_id: str,
        success: bool,
        access_end_date: str | None,
        error: str | None,
        duration_seconds: int,
        error_code: str | None = None,
        stats: dict | None = None,
    ) -> None:
        received.append(duration_seconds)

    aio_client.app[_server_key].set_result_callback(on_result)

    resp = await aio_client.post(
        "/callback/result",
        json={"job_id": "j1", "success": True},
    )
    assert resp.status == 200
    assert received == [0]


@pytest.mark.asyncio
async def test_no_result_callback_set(aio_client: AioTestClient) -> None:
    """POST /callback/result without a callback registered still returns 200."""
    resp = await aio_client.post(
        "/callback/result",
        json={"job_id": "j1", "success": True, "duration_seconds": 10},
    )
    assert resp.status == 200


@pytest.mark.asyncio
async def test_result_callback_error_returns_500(aio_client: AioTestClient) -> None:
    """If the result callback raises, the server returns 500."""

    async def bad_callback(
        job_id: str,
        success: bool,
        access_end_date: str | None,
        error: str | None,
        duration_seconds: int,
        error_code: str | None = None,
        stats: dict | None = None,
    ) -> None:
        raise RuntimeError("db down")

    aio_client.app[_server_key].set_result_callback(bad_callback)

    resp = await aio_client.post(
        "/callback/result",
        json={"job_id": "j1", "success": True},
    )
    assert resp.status == 500


# -- Health --------------------------------------------------------------------


@pytest.mark.asyncio
async def test_health(aio_client: AioTestClient) -> None:
    """GET /health returns 200."""
    resp = await aio_client.get("/health")
    assert resp.status == 200
    body = await resp.json()
    assert body == {"ok": True}


# -- Credential needed ---------------------------------------------------------


@pytest.mark.asyncio
async def test_credential_needed_callback(aio_client: AioTestClient) -> None:
    """POST /callback/credential-needed fires the registered callback."""
    received = []

    async def on_credential(job_id: str, service: str, credential_name: str) -> None:
        received.append((job_id, service, credential_name))

    aio_client.app[_server_key].set_credential_callback(on_credential)

    resp = await aio_client.post(
        "/callback/credential-needed",
        json={"job_id": "j1", "service": "disney_plus", "credential_name": "cvv"},
    )
    assert resp.status == 200
    body = await resp.json()
    assert body == {"ok": True}

    assert len(received) == 1
    assert received[0] == ("j1", "disney_plus", "cvv")


@pytest.mark.asyncio
async def test_credential_needed_missing_fields(aio_client: AioTestClient) -> None:
    """POST /callback/credential-needed with missing fields returns 400."""
    resp = await aio_client.post(
        "/callback/credential-needed",
        json={"job_id": "j1", "service": "netflix"},
    )
    assert resp.status == 400


@pytest.mark.asyncio
async def test_credential_needed_no_callback(aio_client: AioTestClient) -> None:
    """POST /callback/credential-needed without a callback returns 200."""
    resp = await aio_client.post(
        "/callback/credential-needed",
        json={"job_id": "j1", "service": "netflix", "credential_name": "cvv"},
    )
    assert resp.status == 200


@pytest.mark.asyncio
async def test_credential_callback_error_returns_500(aio_client: AioTestClient) -> None:
    """If the credential callback raises, the server returns 500."""

    async def bad_callback(job_id: str, service: str, credential_name: str) -> None:
        raise ValueError("boom")

    aio_client.app[_server_key].set_credential_callback(bad_callback)

    resp = await aio_client.post(
        "/callback/credential-needed",
        json={"job_id": "j1", "service": "netflix", "credential_name": "cvv"},
    )
    assert resp.status == 500


# -- CLI dispatch --------------------------------------------------------------


@pytest.mark.asyncio
async def test_cli_dispatch_success(aio_client: AioTestClient) -> None:
    """POST /cli-dispatch with callback returns job_id."""

    async def on_dispatch(npub, service, action, credentials, plan_id):
        return "cli-12345"

    aio_client.app[_server_key].set_cli_dispatch_callback(on_dispatch)

    resp = await aio_client.post(
        "/cli-dispatch",
        json={
            "npub": "npub1abc",
            "service": "disney",
            "action": "resume",
            "credentials": {"email": "a@b.com", "pass": "x"},
            "plan_id": "premium",
        },
    )
    assert resp.status == 200
    body = await resp.json()
    assert body["ok"] is True
    assert body["job_id"] == "cli-12345"


@pytest.mark.asyncio
async def test_cli_dispatch_missing_fields(aio_client: AioTestClient) -> None:
    """POST /cli-dispatch with missing required fields returns 400."""
    resp = await aio_client.post(
        "/cli-dispatch",
        json={"npub": "npub1abc"},
    )
    assert resp.status == 400


@pytest.mark.asyncio
async def test_cli_dispatch_no_callback(aio_client: AioTestClient) -> None:
    """POST /cli-dispatch without callback returns 503."""
    resp = await aio_client.post(
        "/cli-dispatch",
        json={
            "npub": "npub1abc",
            "service": "disney",
            "action": "resume",
            "credentials": {"email": "a", "pass": "b"},
        },
    )
    assert resp.status == 503


# -- CLI job poll --------------------------------------------------------------


@pytest.mark.asyncio
async def test_cli_job_running(aio_client: AioTestClient) -> None:
    """GET /cli-job/{id} returns running when no result stored."""
    resp = await aio_client.get("/cli-job/cli-12345")
    assert resp.status == 200
    body = await resp.json()
    assert body["status"] == "running"


@pytest.mark.asyncio
async def test_cli_job_completed(aio_client: AioTestClient) -> None:
    """GET /cli-job/{id} returns completed when result is stored."""
    aio_client.app[_server_key].store_cli_result(
        "cli-99", {"success": True, "access_end_date": "2026-04-01"}
    )
    resp = await aio_client.get("/cli-job/cli-99")
    assert resp.status == 200
    body = await resp.json()
    assert body["status"] == "completed"
    assert body["result"]["access_end_date"] == "2026-04-01"


@pytest.mark.asyncio
async def test_cli_job_failed(aio_client: AioTestClient) -> None:
    """GET /cli-job/{id} returns failed when result has success=false."""
    aio_client.app[_server_key].store_cli_result(
        "cli-fail", {"success": False, "error": "Login failed"}
    )
    resp = await aio_client.get("/cli-job/cli-fail")
    assert resp.status == 200
    body = await resp.json()
    assert body["status"] == "failed"
