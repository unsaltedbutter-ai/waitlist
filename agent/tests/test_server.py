"""Tests for the Agent server: multi-job support, routing, health, shutdown."""

from __future__ import annotations

import asyncio
import json
import time
from dataclasses import dataclass, field
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

# aiohttp.web is mocked in conftest. Provide a lightweight json_response
# replacement so handlers return objects with real .status and .body.


@dataclass
class FakeResponse:
    status: int
    body: bytes = b''


def _fake_json_response(data, *, status=200):
    return FakeResponse(status=status, body=json.dumps(data).encode())


# Patch the mock aiohttp.web.json_response before importing Agent
from aiohttp import web  # this is actually a MagicMock from conftest
web.json_response = _fake_json_response

from agent.playbook import ExecutionResult
from agent.server import ActiveJob, Agent


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_agent(max_jobs: int = 3) -> Agent:
    """Create an Agent without starting the HTTP server."""
    agent = Agent(
        host="127.0.0.1",
        port=0,  # unused in tests
        orchestrator_url="http://localhost:9999",
        max_jobs=max_jobs,
    )
    agent._http_client = AsyncMock()
    agent._vlm = MagicMock()
    agent._vlm_model = "test-model"
    return agent


def _make_request(data: dict) -> MagicMock:
    """Create a mock aiohttp request with JSON body."""
    request = MagicMock()
    request.json = AsyncMock(return_value=data)
    return request


def _valid_execute_body(job_id: str = "job-1") -> dict:
    return {
        "job_id": job_id,
        "service": "netflix",
        "action": "cancel",
        "credentials": {"email": "a@b.com", "pass": "x"},
    }


def _run(coro):
    """Run an async coroutine in a fresh event loop."""
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


# ---------------------------------------------------------------------------
# Execute handler tests
# ---------------------------------------------------------------------------

class TestHandleExecute:
    def test_accepts_job_when_idle(self):
        async def go():
            agent = _make_agent()
            agent._loop = asyncio.get_event_loop()
            agent._run_job = AsyncMock()

            req = _make_request(_valid_execute_body("job-1"))
            resp = await agent._handle_execute(req)
            assert resp.status == 200
            assert "job-1" in agent._active_jobs

        _run(go())

    def test_rejects_duplicate_job_id(self):
        async def go():
            agent = _make_agent()
            agent._loop = asyncio.get_event_loop()
            agent._active_jobs["job-1"] = ActiveJob(
                job_id="job-1", service="netflix", action="cancel",
            )

            req = _make_request(_valid_execute_body("job-1"))
            resp = await agent._handle_execute(req)
            assert resp.status == 409

        _run(go())

    def test_rejects_when_at_capacity(self):
        async def go():
            agent = _make_agent(max_jobs=2)
            agent._loop = asyncio.get_event_loop()
            agent._run_job = AsyncMock()

            for i in range(2):
                req = _make_request(_valid_execute_body(f"job-{i}"))
                resp = await agent._handle_execute(req)
                assert resp.status == 200

            req = _make_request(_valid_execute_body("job-overflow"))
            resp = await agent._handle_execute(req)
            assert resp.status == 409
            assert "job-overflow" not in agent._active_jobs

        _run(go())

    def test_accepts_up_to_max_concurrent(self):
        async def go():
            agent = _make_agent(max_jobs=3)
            agent._loop = asyncio.get_event_loop()
            agent._run_job = AsyncMock()

            for i in range(3):
                req = _make_request(_valid_execute_body(f"job-{i}"))
                resp = await agent._handle_execute(req)
                assert resp.status == 200

            assert len(agent._active_jobs) == 3

        _run(go())

    def test_rejects_missing_fields(self):
        async def go():
            agent = _make_agent()
            agent._loop = asyncio.get_event_loop()
            req = _make_request({"job_id": "j1"})
            resp = await agent._handle_execute(req)
            assert resp.status == 400

        _run(go())

    def test_rejects_invalid_json(self):
        async def go():
            agent = _make_agent()
            agent._loop = asyncio.get_event_loop()
            req = MagicMock()
            req.json = AsyncMock(side_effect=ValueError("bad json"))
            resp = await agent._handle_execute(req)
            assert resp.status == 400

        _run(go())


# ---------------------------------------------------------------------------
# OTP handler tests
# ---------------------------------------------------------------------------

class TestHandleOtp:
    def test_otp_routes_to_correct_job(self):
        async def go():
            agent = _make_agent()
            loop = asyncio.get_event_loop()

            aj1 = ActiveJob(job_id="job-1", service="netflix", action="cancel")
            aj1.otp_future = loop.create_future()
            aj2 = ActiveJob(job_id="job-2", service="hulu", action="cancel")
            aj2.otp_future = loop.create_future()
            agent._active_jobs["job-1"] = aj1
            agent._active_jobs["job-2"] = aj2

            req = _make_request({"job_id": "job-2", "code": "123456"})
            resp = await agent._handle_otp(req)
            assert resp.status == 200

            assert aj2.otp_future.result() == "123456"
            assert not aj1.otp_future.done()

        _run(go())

    def test_otp_unknown_job_returns_404(self):
        async def go():
            agent = _make_agent()
            req = _make_request({"job_id": "nonexistent", "code": "111"})
            resp = await agent._handle_otp(req)
            assert resp.status == 404

        _run(go())

    def test_otp_missing_fields_returns_400(self):
        async def go():
            agent = _make_agent()
            req = _make_request({"job_id": "job-1"})
            resp = await agent._handle_otp(req)
            assert resp.status == 400

        _run(go())


# ---------------------------------------------------------------------------
# Credential handler tests
# ---------------------------------------------------------------------------

class TestHandleCredential:
    def test_credential_routes_to_correct_job(self):
        async def go():
            agent = _make_agent()
            loop = asyncio.get_event_loop()

            aj1 = ActiveJob(job_id="job-1", service="netflix", action="cancel")
            aj1.credential_future = loop.create_future()
            aj2 = ActiveJob(job_id="job-2", service="hulu", action="cancel")
            aj2.credential_future = loop.create_future()
            agent._active_jobs["job-1"] = aj1
            agent._active_jobs["job-2"] = aj2

            req = _make_request({
                "job_id": "job-1",
                "credential_name": "cvv",
                "value": "321",
            })
            resp = await agent._handle_credential(req)
            assert resp.status == 200
            assert aj1.credential_future.result() == "321"
            assert not aj2.credential_future.done()

        _run(go())

    def test_credential_unknown_job_returns_404(self):
        async def go():
            agent = _make_agent()
            req = _make_request({
                "job_id": "ghost",
                "credential_name": "cvv",
                "value": "999",
            })
            resp = await agent._handle_credential(req)
            assert resp.status == 404

        _run(go())


# ---------------------------------------------------------------------------
# Abort handler tests
# ---------------------------------------------------------------------------

class TestHandleAbort:
    def test_abort_targets_specific_job(self):
        async def go():
            agent = _make_agent()

            task1 = MagicMock()
            task1.done.return_value = False
            task2 = MagicMock()
            task2.done.return_value = False

            aj1 = ActiveJob(job_id="job-1", service="netflix", action="cancel")
            aj1.task = task1
            aj2 = ActiveJob(job_id="job-2", service="hulu", action="cancel")
            aj2.task = task2
            agent._active_jobs["job-1"] = aj1
            agent._active_jobs["job-2"] = aj2

            req = _make_request({"job_id": "job-1"})
            resp = await agent._handle_abort(req)
            assert resp.status == 200

            task1.cancel.assert_called_once()
            task2.cancel.assert_not_called()

        _run(go())

    def test_abort_unknown_job_returns_404(self):
        async def go():
            agent = _make_agent()
            req = _make_request({"job_id": "nonexistent"})
            resp = await agent._handle_abort(req)
            assert resp.status == 404

        _run(go())


# ---------------------------------------------------------------------------
# Health handler tests
# ---------------------------------------------------------------------------

class TestHandleHealth:
    def test_health_shows_all_active_jobs(self):
        async def go():
            agent = _make_agent(max_jobs=3)
            agent._active_jobs["job-1"] = ActiveJob(
                job_id="job-1", service="netflix", action="cancel",
            )
            agent._active_jobs["job-2"] = ActiveJob(
                job_id="job-2", service="hulu", action="resume",
            )

            req = _make_request({})
            resp = await agent._handle_health(req)
            assert resp.status == 200

            body = json.loads(resp.body)
            assert body["max_jobs"] == 3
            assert body["active_job_count"] == 2
            assert body["slots_available"] == 1
            assert len(body["active_jobs"]) == 2

            job_ids = {j["job_id"] for j in body["active_jobs"]}
            assert job_ids == {"job-1", "job-2"}

        _run(go())

    def test_health_empty(self):
        async def go():
            agent = _make_agent(max_jobs=3)
            req = _make_request({})
            resp = await agent._handle_health(req)

            body = json.loads(resp.body)
            assert body["active_job_count"] == 0
            assert body["slots_available"] == 3
            assert body["active_jobs"] == []

        _run(go())


# ---------------------------------------------------------------------------
# Slot lifecycle tests
# ---------------------------------------------------------------------------

class TestSlotLifecycle:
    def test_slot_freed_after_job_completes(self):
        async def go():
            agent = _make_agent(max_jobs=1)
            agent._loop = asyncio.get_event_loop()

            async def fake_run_job(active, credentials):
                async with agent._lock:
                    agent._active_jobs.pop(active.job_id, None)

            agent._run_job = fake_run_job

            req = _make_request(_valid_execute_body("job-1"))
            resp = await agent._handle_execute(req)
            assert resp.status == 200

            # Wait for the background task
            aj = agent._active_jobs.get("job-1")
            if aj and aj.task:
                await aj.task

            assert len(agent._active_jobs) == 0

            # Can accept another job
            req2 = _make_request(_valid_execute_body("job-2"))
            resp2 = await agent._handle_execute(req2)
            assert resp2.status == 200

        _run(go())

    def test_multiple_jobs_run_concurrently(self):
        """Verify multiple jobs are in _active_jobs simultaneously."""
        async def go():
            agent = _make_agent(max_jobs=3)
            agent._loop = asyncio.get_event_loop()

            started = []
            gates = {}

            async def blocking_run(active, credentials):
                started.append(active.job_id)
                gate = asyncio.Event()
                gates[active.job_id] = gate
                await gate.wait()
                async with agent._lock:
                    agent._active_jobs.pop(active.job_id, None)

            agent._run_job = blocking_run

            for i in range(3):
                req = _make_request(_valid_execute_body(f"job-{i}"))
                resp = await agent._handle_execute(req)
                assert resp.status == 200

            await asyncio.sleep(0.01)

            assert len(agent._active_jobs) == 3
            assert set(started) == {"job-0", "job-1", "job-2"}

            for g in gates.values():
                g.set()
            await asyncio.sleep(0.01)
            assert len(agent._active_jobs) == 0

        _run(go())


# ---------------------------------------------------------------------------
# Shutdown tests
# ---------------------------------------------------------------------------

class TestShutdown:
    def test_stop_waits_for_active_jobs(self):
        async def go():
            agent = _make_agent(max_jobs=2)
            agent._loop = asyncio.get_event_loop()
            agent._runner = MagicMock()
            agent._runner.cleanup = AsyncMock()

            completed = []

            async def slow_job(active, credentials):
                await asyncio.sleep(0.05)
                completed.append(active.job_id)
                async with agent._lock:
                    agent._active_jobs.pop(active.job_id, None)

            agent._run_job = slow_job

            for i in range(2):
                req = _make_request(_valid_execute_body(f"job-{i}"))
                await agent._handle_execute(req)

            await agent.stop()
            assert set(completed) == {"job-0", "job-1"}

        _run(go())


# ---------------------------------------------------------------------------
# Report result tests
# ---------------------------------------------------------------------------

class TestReportResult:
    def test_report_result_includes_error_code(self):
        """_report_result should include error_code in the POST payload."""
        async def go():
            agent = _make_agent()
            agent._http_client = AsyncMock()
            mock_resp = MagicMock()
            mock_resp.status_code = 200
            agent._http_client.post.return_value = mock_resp

            active = ActiveJob(job_id="job-ec", service="netflix", action="cancel")
            result = ExecutionResult(
                job_id="job-ec",
                service="netflix",
                flow="cancel",
                success=False,
                duration_seconds=42.0,
                step_count=5,
                inference_count=3,
                playbook_version=0,
                error_message="Sign-in failed: credentials rejected by service",
                error_code="credential_invalid",
            )

            await agent._report_result(active, result, "")

            agent._http_client.post.assert_awaited_once()
            call_kwargs = agent._http_client.post.call_args
            payload = call_kwargs.kwargs.get("json") or call_kwargs[1].get("json")
            assert payload["error_code"] == "credential_invalid"
            assert payload["success"] is False

        _run(go())

    def test_report_result_null_error_code_when_no_error(self):
        """_report_result should send error_code=null for normal failures."""
        async def go():
            agent = _make_agent()
            agent._http_client = AsyncMock()
            mock_resp = MagicMock()
            mock_resp.status_code = 200
            agent._http_client.post.return_value = mock_resp

            active = ActiveJob(job_id="job-ok", service="netflix", action="cancel")
            result = ExecutionResult(
                job_id="job-ok",
                service="netflix",
                flow="cancel",
                success=False,
                duration_seconds=10.0,
                step_count=2,
                inference_count=1,
                playbook_version=0,
                error_message="Max steps reached",
            )

            await agent._report_result(active, result, "")

            call_kwargs = agent._http_client.post.call_args
            payload = call_kwargs.kwargs.get("json") or call_kwargs[1].get("json")
            assert payload["error_code"] is None

        _run(go())

    def test_report_result_fallback_has_null_error_code(self):
        """When result is None (crash), error_code should be null."""
        async def go():
            agent = _make_agent()
            agent._http_client = AsyncMock()
            mock_resp = MagicMock()
            mock_resp.status_code = 200
            agent._http_client.post.return_value = mock_resp

            active = ActiveJob(job_id="job-crash", service="netflix", action="cancel")

            await agent._report_result(active, None, "Unexpected error")

            call_kwargs = agent._http_client.post.call_args
            payload = call_kwargs.kwargs.get("json") or call_kwargs[1].get("json")
            assert payload["error_code"] is None

        _run(go())
