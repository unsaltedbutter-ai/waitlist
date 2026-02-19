"""HTTP callback server for agent results.

The Mac Mini Chrome agent POSTs to this server when it needs an OTP code
or when a job completes (success or failure). Runs on port 8422 by default.
"""

from __future__ import annotations

import logging
from typing import Callable, Awaitable

from aiohttp import web

log = logging.getLogger(__name__)

# Callback type aliases for clarity.
OtpCallback = Callable[[str, str, str | None], Awaitable[None]]
ResultCallback = Callable[[str, bool, str | None, str | None, int], Awaitable[None]]


class AgentCallbackServer:
    """Lightweight HTTP server that receives callbacks from the Chrome agent.

    Two callback endpoints:
      POST /callback/otp-needed: agent needs the user to provide an OTP code
      POST /callback/result:     job finished (success or failure)

    Plus a health endpoint for monitoring:
      GET /health
    """

    def __init__(self, host: str = "0.0.0.0", port: int = 8422) -> None:
        self._host = host
        self._port = port
        self._app = web.Application()
        self._runner: web.AppRunner | None = None
        self._otp_callback: OtpCallback | None = None
        self._result_callback: ResultCallback | None = None

    def set_otp_callback(self, callback: OtpCallback) -> None:
        """Set handler for POST /callback/otp-needed.

        callback(job_id: str, service: str, prompt: str | None)
        Called when the agent encounters a 2FA/OTP screen and needs
        the orchestrator to ask the user for a code.
        """
        self._otp_callback = callback

    def set_result_callback(self, callback: ResultCallback) -> None:
        """Set handler for POST /callback/result.

        callback(job_id: str, success: bool, access_end_date: str | None,
                 error: str | None, duration_seconds: int)
        Called when a cancel/resume job completes on the agent.
        """
        self._result_callback = callback

    async def start(self) -> None:
        """Start the HTTP server."""
        self._app.router.add_post("/callback/otp-needed", self._handle_otp_needed)
        self._app.router.add_post("/callback/result", self._handle_result)
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
                await self._result_callback(
                    job_id,
                    success,
                    data.get("access_end_date"),
                    data.get("error"),
                    data.get("duration_seconds", 0),
                )
            except Exception:
                log.exception("Result callback error for job %s", job_id)
                return web.json_response({"error": "Internal error"}, status=500)

        return web.json_response({"ok": True})

    async def _handle_health(self, request: web.Request) -> web.Response:
        """GET /health"""
        return web.json_response({"ok": True})
