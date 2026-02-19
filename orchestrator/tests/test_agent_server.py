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
    app.router.add_post("/callback/result", server._handle_result)
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
