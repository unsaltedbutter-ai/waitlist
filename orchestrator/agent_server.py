"""HTTP callback server for agent results.

The Mac Mini Chrome agent POSTs to this server when it needs an OTP code,
a credential (CVV, ZIP, etc.), or when a job completes (success or failure).
Runs on port 8422 by default.
"""

from __future__ import annotations

import logging
from typing import Callable, Awaitable

from aiohttp import web

log = logging.getLogger(__name__)

# Callback type aliases for clarity.
OtpCallback = Callable[[str, str, str | None], Awaitable[None]]
CredentialCallback = Callable[[str, str, str], Awaitable[None]]
ResultCallback = Callable[[str, bool, str | None, str | None, int, str | None, dict | None], Awaitable[None]]
CliDispatchCallback = Callable[[str, str, str, dict, str], Awaitable[str]]


class AgentCallbackServer:
    """Lightweight HTTP server that receives callbacks from the Chrome agent.

    Callback endpoints:
      POST /callback/otp-needed:        agent needs the user to provide an OTP code
      POST /callback/credential-needed: agent needs a credential (CVV, ZIP, etc.)
      POST /callback/result:            job finished (success or failure)

    CLI dispatch endpoints:
      POST /cli-dispatch:   accept a CLI-originated job
      GET  /cli-job/{id}:   poll for CLI job status

    Plus a health endpoint for monitoring:
      GET /health
    """

    def __init__(self, host: str = "0.0.0.0", port: int = 8422) -> None:
        self._host = host
        self._port = port
        self._app = web.Application()
        self._runner: web.AppRunner | None = None
        self._otp_callback: OtpCallback | None = None
        self._credential_callback: CredentialCallback | None = None
        self._result_callback: ResultCallback | None = None
        self._cli_dispatch_callback: CliDispatchCallback | None = None
        self._cli_results: dict[str, dict] = {}

    def set_otp_callback(self, callback: OtpCallback) -> None:
        """Set handler for POST /callback/otp-needed.

        callback(job_id: str, service: str, prompt: str | None)
        Called when the agent encounters a 2FA/OTP screen and needs
        the orchestrator to ask the user for a code.
        """
        self._otp_callback = callback

    def set_credential_callback(self, callback: CredentialCallback) -> None:
        """Set handler for POST /callback/credential-needed.

        callback(job_id: str, service: str, credential_name: str)
        Called when the agent encounters a field (CVV, ZIP, etc.) that
        is not in the credentials dict.
        """
        self._credential_callback = callback

    def set_result_callback(self, callback: ResultCallback) -> None:
        """Set handler for POST /callback/result.

        callback(job_id: str, success: bool, access_end_date: str | None,
                 error: str | None, duration_seconds: int,
                 error_code: str | None, stats: dict | None)
        Called when a cancel/resume job completes on the agent.
        """
        self._result_callback = callback

    def set_cli_dispatch_callback(self, callback: CliDispatchCallback) -> None:
        """Set handler for POST /cli-dispatch.

        callback(npub: str, service: str, action: str, credentials: dict,
                 plan_id: str) -> job_id: str
        """
        self._cli_dispatch_callback = callback

    def store_cli_result(self, job_id: str, result: dict) -> None:
        """Store a completed CLI job result for polling."""
        self._cli_results[job_id] = result

    async def start(self) -> None:
        """Start the HTTP server."""
        self._app.router.add_post("/callback/otp-needed", self._handle_otp_needed)
        self._app.router.add_post(
            "/callback/credential-needed", self._handle_credential_needed
        )
        self._app.router.add_post("/callback/result", self._handle_result)
        self._app.router.add_post("/cli-dispatch", self._handle_cli_dispatch)
        self._app.router.add_get("/cli-job/{job_id}", self._handle_cli_job)
        self._app.router.add_get("/health", self._handle_health)

        self._runner = web.AppRunner(self._app)
        await self._runner.setup()
        site = web.TCPSite(self._runner, self._host, self._port)
        await site.start()
        log.info("Agent callback server listening on %s:%d", self._host, self._port)

    async def stop(self) -> None:
        """Stop the HTTP server and release resources."""
        if self._runner:
            await self._runner.cleanup()
            self._runner = None

    # -- Handlers ----------------------------------------------------------------

    async def _handle_otp_needed(self, request: web.Request) -> web.Response:
        """POST /callback/otp-needed

        Body: {"job_id": str, "service": str, "prompt": str | null}
        """
        try:
            data = await request.json()
        except Exception:
            return web.json_response({"error": "Invalid JSON"}, status=400)

        job_id = data.get("job_id")
        service = data.get("service")
        prompt = data.get("prompt")

        if not job_id or not service:
            return web.json_response(
                {"error": "Missing job_id or service"}, status=400
            )

        if self._otp_callback:
            try:
                await self._otp_callback(job_id, service, prompt)
            except Exception:
                log.exception("OTP callback error for job %s", job_id)
                return web.json_response({"error": "Internal error"}, status=500)

        return web.json_response({"ok": True})

    async def _handle_result(self, request: web.Request) -> web.Response:
        """POST /callback/result

        Body: {
            "job_id": str,
            "success": bool,
            "access_end_date": str | null,
            "error": str | null,
            "duration_seconds": int
        }
        """
        try:
            data = await request.json()
        except Exception:
            return web.json_response({"error": "Invalid JSON"}, status=400)

        job_id = data.get("job_id")
        success = data.get("success")

        if not job_id or success is None:
            return web.json_response(
                {"error": "Missing job_id or success"}, status=400
            )

        if self._result_callback:
            try:
                stats = {
                    "step_count": data.get("step_count", 0),
                    "inference_count": data.get("inference_count", 0),
                    "playbook_version": data.get("playbook_version", 0),
                    "otp_required": data.get("otp_required", False),
                }
                await self._result_callback(
                    job_id,
                    success,
                    data.get("access_end_date"),
                    data.get("error"),
                    data.get("duration_seconds", 0),
                    data.get("error_code"),
                    stats,
                )
            except Exception:
                log.exception("Result callback error for job %s", job_id)
                return web.json_response({"error": "Internal error"}, status=500)

        return web.json_response({"ok": True})

    async def _handle_credential_needed(self, request: web.Request) -> web.Response:
        """POST /callback/credential-needed

        Body: {"job_id": str, "service": str, "credential_name": str}
        """
        try:
            data = await request.json()
        except Exception:
            return web.json_response({"error": "Invalid JSON"}, status=400)

        job_id = data.get("job_id")
        service = data.get("service")
        credential_name = data.get("credential_name")

        if not job_id or not service or not credential_name:
            return web.json_response(
                {"error": "Missing job_id, service, or credential_name"}, status=400
            )

        if self._credential_callback:
            try:
                await self._credential_callback(job_id, service, credential_name)
            except Exception:
                log.exception(
                    "Credential callback error for job %s", job_id
                )
                return web.json_response({"error": "Internal error"}, status=500)

        return web.json_response({"ok": True})

    async def _handle_cli_dispatch(self, request: web.Request) -> web.Response:
        """POST /cli-dispatch

        Body: {"npub": str, "service": str, "action": str,
               "credentials": dict, "plan_id": str}
        """
        try:
            data = await request.json()
        except Exception:
            return web.json_response({"error": "Invalid JSON"}, status=400)

        npub = data.get("npub")
        service = data.get("service")
        action = data.get("action")
        credentials = data.get("credentials")
        plan_id = data.get("plan_id", "")

        if not npub or not service or not action or not credentials:
            return web.json_response(
                {"error": "Missing required fields"}, status=400
            )

        if not self._cli_dispatch_callback:
            return web.json_response(
                {"error": "CLI dispatch not configured"}, status=503
            )

        try:
            job_id = await self._cli_dispatch_callback(
                npub, service, action, credentials, plan_id
            )
        except Exception:
            log.exception("CLI dispatch error")
            return web.json_response({"error": "Internal error"}, status=500)

        return web.json_response({"ok": True, "job_id": job_id})

    async def _handle_cli_job(self, request: web.Request) -> web.Response:
        """GET /cli-job/{job_id}

        Returns job status for CLI polling.
        """
        job_id = request.match_info["job_id"]

        if job_id in self._cli_results:
            result = self._cli_results[job_id]
            return web.json_response({
                "status": "completed" if result.get("success") else "failed",
                "result": result,
            })

        return web.json_response({"status": "running"})

    async def _handle_health(self, request: web.Request) -> web.Response:
        """GET /health"""
        return web.json_response({"ok": True})
