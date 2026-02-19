"""Tests for the AgentClient (HTTP client for Mac Mini Chrome agent).

Run: cd orchestrator && python -m pytest tests/test_agent_client.py -v
"""

from __future__ import annotations

import httpx
import pytest
import pytest_asyncio
import respx

from agent_client import AgentClient

AGENT_URL = "http://192.168.1.100:8421"


@pytest_asyncio.fixture
async def client() -> AgentClient:
    """Create an AgentClient, yield it, then close."""
    c = AgentClient(AGENT_URL)
    await c.start()
    yield c
    await c.close()


# -- execute -------------------------------------------------------------------


@pytest.mark.asyncio
@respx.mock
async def test_execute_success(client: AgentClient) -> None:
    route = respx.post(f"{AGENT_URL}/execute").mock(
        return_value=httpx.Response(200, json={"ok": True})
    )
    result = await client.execute(
        "j1", "netflix", "cancel", {"email": "a@b.com", "password": "secret"}
    )
    assert result is True
    assert route.called


@pytest.mark.asyncio
@respx.mock
async def test_execute_failure(client: AgentClient) -> None:
    respx.post(f"{AGENT_URL}/execute").mock(
        return_value=httpx.Response(500, json={"error": "busy"})
    )
    result = await client.execute(
        "j1", "netflix", "cancel", {"email": "a@b.com", "password": "secret"}
    )
    assert result is False


@pytest.mark.asyncio
@respx.mock
async def test_execute_sends_correct_body(client: AgentClient) -> None:
    route = respx.post(f"{AGENT_URL}/execute").mock(
        return_value=httpx.Response(200, json={"ok": True})
    )
    await client.execute(
        "j42", "hulu", "resume", {"email": "u@x.com", "password": "pw"}
    )
    sent = route.calls[0].request
    import json

    body = json.loads(sent.content)
    assert body["job_id"] == "j42"
    assert body["service"] == "hulu"
    assert body["action"] == "resume"
    assert body["credentials"]["email"] == "u@x.com"
    assert body["credentials"]["password"] == "pw"
    assert "plan_id" not in body  # omitted when None


@pytest.mark.asyncio
@respx.mock
async def test_execute_sends_plan_id(client: AgentClient) -> None:
    route = respx.post(f"{AGENT_URL}/execute").mock(
        return_value=httpx.Response(200, json={"ok": True})
    )
    await client.execute(
        "j50", "netflix", "resume", {"email": "u@x.com", "password": "pw"},
        plan_id="netflix_premium",
    )
    import json

    body = json.loads(route.calls[0].request.content)
    assert body["plan_id"] == "netflix_premium"


@pytest.mark.asyncio
@respx.mock
async def test_execute_connection_error(client: AgentClient) -> None:
    respx.post(f"{AGENT_URL}/execute").mock(side_effect=httpx.ConnectError("refused"))
    result = await client.execute(
        "j1", "netflix", "cancel", {"email": "a@b.com", "password": "secret"}
    )
    assert result is False


# -- relay_otp -----------------------------------------------------------------


@pytest.mark.asyncio
@respx.mock
async def test_relay_otp_success(client: AgentClient) -> None:
    route = respx.post(f"{AGENT_URL}/otp").mock(
        return_value=httpx.Response(200, json={"ok": True})
    )
    result = await client.relay_otp("j1", "123456")
    assert result is True
    assert route.called


@pytest.mark.asyncio
@respx.mock
async def test_relay_otp_sends_code(client: AgentClient) -> None:
    route = respx.post(f"{AGENT_URL}/otp").mock(
        return_value=httpx.Response(200, json={"ok": True})
    )
    await client.relay_otp("j99", "654321")
    import json

    body = json.loads(route.calls[0].request.content)
    assert body["job_id"] == "j99"
    assert body["code"] == "654321"


# -- abort ---------------------------------------------------------------------


@pytest.mark.asyncio
@respx.mock
async def test_abort_success(client: AgentClient) -> None:
    route = respx.post(f"{AGENT_URL}/abort").mock(
        return_value=httpx.Response(200, json={"ok": True})
    )
    result = await client.abort("j1")
    assert result is True
    assert route.called


@pytest.mark.asyncio
@respx.mock
async def test_abort_rejected(client: AgentClient) -> None:
    respx.post(f"{AGENT_URL}/abort").mock(
        return_value=httpx.Response(404, json={"error": "No such job"})
    )
    result = await client.abort("j_missing")
    assert result is False


# -- health --------------------------------------------------------------------


@pytest.mark.asyncio
@respx.mock
async def test_health_success(client: AgentClient) -> None:
    respx.get(f"{AGENT_URL}/health").mock(
        return_value=httpx.Response(200, json={"ok": True})
    )
    result = await client.health()
    assert result is True


@pytest.mark.asyncio
@respx.mock
async def test_health_failure(client: AgentClient) -> None:
    respx.get(f"{AGENT_URL}/health").mock(side_effect=httpx.ConnectError("refused"))
    result = await client.health()
    assert result is False


# -- lifecycle -----------------------------------------------------------------


@pytest.mark.asyncio
async def test_request_without_start_raises() -> None:
    c = AgentClient(AGENT_URL)
    with pytest.raises(RuntimeError, match="not started"):
        await c.execute("j1", "netflix", "cancel", {"email": "a", "password": "b"})
