"""UnsaltedButter Agent: main entry point.

Runs on Mac Mini. Listens for job dispatches from the orchestrator via HTTP,
executes browser automation via VLM-driven screenshot analysis,
and reports results back to the orchestrator via HTTP callback.

Endpoints (matches what orchestrator's AgentClient sends):
  POST /execute   - accept a cancel/resume job
  POST /otp       - relay an OTP code to a running job
  POST /abort     - cancel a running job
  GET  /health    - liveness check

Single-threaded execution: one job at a time.
"""

from __future__ import annotations

import asyncio
import logging
import os
import signal
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path

import httpx
from aiohttp import web
from dotenv import load_dotenv

from agent.config import AGENT_PORT, VLM_KEY, VLM_MODEL, VLM_URL
from agent.playbook import ExecutionResult
from agent.profile import NORMAL, PROFILES
from agent.recording.vlm_client import VLMClient
from agent.vlm_executor import VLMExecutor

log = logging.getLogger(__name__)

# Git hash for version logging (matches orchestrator pattern)
try:
    GIT_HASH = subprocess.run(
        ["git", "rev-parse", "--short", "HEAD"],
        capture_output=True,
        text=True,
        timeout=5,
    ).stdout.strip() or "unknown"
except Exception:
    GIT_HASH = "unknown"


# ---------------------------------------------------------------------------
# Active job state
# ---------------------------------------------------------------------------

@dataclass
class ActiveJob:
    """Tracks a currently-running job and its OTP channel."""

    job_id: str
    service: str
    action: str
    plan_id: str = ''
    task: asyncio.Task | None = None
    otp_future: asyncio.Future | None = None
    started_at: float = field(default_factory=time.monotonic)


# ---------------------------------------------------------------------------
# Agent server
# ---------------------------------------------------------------------------

class Agent:
    """HTTP server that receives jobs from the orchestrator and executes them."""

    def __init__(
        self,
        host: str = "0.0.0.0",
        port: int = AGENT_PORT,
        orchestrator_url: str = "http://192.168.1.101:8422",
        profile_name: str = "normal",
    ) -> None:
        self._host = host
        self._port = port
        self._orchestrator_url = orchestrator_url.rstrip("/")
        self._profile = PROFILES.get(profile_name, NORMAL)

        self._app = web.Application()
        self._runner: web.AppRunner | None = None
        self._http_client: httpx.AsyncClient | None = None

        self._active_job: ActiveJob | None = None
        self._lock = asyncio.Lock()
        self._shutdown = asyncio.Event()
        self._loop: asyncio.AbstractEventLoop | None = None

        # VLM client (created at startup, closed at shutdown)
        self._vlm: VLMClient | None = None

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    async def start(self) -> None:
        """Start the HTTP server and outbound client."""
        self._loop = asyncio.get_running_loop()
        self._http_client = httpx.AsyncClient(timeout=30.0)

        # Create VLM client
        if not VLM_URL:
            log.warning("VLM_URL not set; jobs will fail until configured")
        self._vlm = VLMClient(
            base_url=VLM_URL or "http://localhost:8080",
            api_key=VLM_KEY,
            model=VLM_MODEL,
        )
        log.info("VLM client: model=%s url=%s", VLM_MODEL, VLM_URL or "(not set)")

        # Register routes
        self._app.router.add_post("/execute", self._handle_execute)
        self._app.router.add_post("/otp", self._handle_otp)
        self._app.router.add_post("/abort", self._handle_abort)
        self._app.router.add_get("/health", self._handle_health)

        self._runner = web.AppRunner(self._app)
        await self._runner.setup()
        site = web.TCPSite(self._runner, self._host, self._port)
        await site.start()
        log.info("Agent listening on %s:%d", self._host, self._port)

    async def stop(self) -> None:
        """Graceful shutdown: wait for active job, then clean up."""
        self._shutdown.set()

        # Wait for active job to finish (with timeout)
        if self._active_job and self._active_job.task:
            log.info(
                "Waiting for active job %s to complete...",
                self._active_job.job_id,
            )
            try:
                await asyncio.wait_for(self._active_job.task, timeout=30.0)
            except asyncio.TimeoutError:
                log.warning(
                    "Active job %s did not finish in 30s, cancelling",
                    self._active_job.job_id,
                )
                self._active_job.task.cancel()
                try:
                    await self._active_job.task
                except (asyncio.CancelledError, Exception):
                    pass

        # Close VLM client
        if self._vlm is not None:
            self._vlm.close()

        # Close HTTP client
        if self._http_client:
            await self._http_client.aclose()
            self._http_client = None

        # Stop aiohttp server
        if self._runner:
            await self._runner.cleanup()
            self._runner = None

        log.info("Agent stopped")

    # ------------------------------------------------------------------
    # HTTP handlers
    # ------------------------------------------------------------------

    async def _handle_execute(self, request: web.Request) -> web.Response:
        """POST /execute

        Body: {"job_id": str, "service": str, "action": str, "credentials": dict}
        Accepts the job if idle, rejects if already running one.
        """
        try:
            data = await request.json()
        except Exception:
            return web.json_response({"error": "Invalid JSON"}, status=400)

        job_id = data.get("job_id")
        service = data.get("service")
        action = data.get("action")
        credentials = data.get("credentials")
        plan_id = data.get("plan_id", "")

        if not job_id or not service or not action or not credentials:
            return web.json_response(
                {"error": "Missing required fields (job_id, service, action, credentials)"},
                status=400,
            )

        async with self._lock:
            if self._active_job is not None:
                log.warning(
                    "Rejected job %s: already running %s",
                    job_id,
                    self._active_job.job_id,
                )
                return web.json_response(
                    {"error": f"Busy (running {self._active_job.job_id})"},
                    status=409,
                )

            active = ActiveJob(job_id=job_id, service=service, action=action, plan_id=plan_id or '')
            self._active_job = active
            log.info("Accepted job %s (%s/%s)", job_id, service, action)

        # Run the job in a background task so we can return 200 immediately
        active.task = asyncio.create_task(
            self._run_job(active, credentials),
            name=f"job-{job_id}",
        )

        return web.json_response({"ok": True, "job_id": job_id})

    async def _handle_otp(self, request: web.Request) -> web.Response:
        """POST /otp

        Body: {"job_id": str, "code": str}
        Delivers an OTP code to the currently running job.
        """
        try:
            data = await request.json()
        except Exception:
            return web.json_response({"error": "Invalid JSON"}, status=400)

        job_id = data.get("job_id")
        code = data.get("code")

        if not job_id or not code:
            return web.json_response(
                {"error": "Missing job_id or code"}, status=400
            )

        active = self._active_job
        if active is None or active.job_id != job_id:
            log.warning("OTP for unknown/inactive job %s", job_id)
            return web.json_response(
                {"error": f"No active job with id {job_id}"}, status=404
            )

        if active.otp_future is not None and not active.otp_future.done():
            active.otp_future.set_result(code)
            log.info("OTP delivered for job %s", job_id)
        else:
            log.warning("OTP arrived for job %s but no future is waiting", job_id)

        return web.json_response({"ok": True})

    async def _handle_abort(self, request: web.Request) -> web.Response:
        """POST /abort

        Body: {"job_id": str}
        Cancels a running job.
        """
        try:
            data = await request.json()
        except Exception:
            return web.json_response({"error": "Invalid JSON"}, status=400)

        job_id = data.get("job_id")
        if not job_id:
            return web.json_response({"error": "Missing job_id"}, status=400)

        active = self._active_job
        if active is None or active.job_id != job_id:
            log.warning("Abort for unknown/inactive job %s", job_id)
            return web.json_response(
                {"error": f"No active job with id {job_id}"}, status=404
            )

        if active.task and not active.task.done():
            active.task.cancel()
            log.info("Abort requested for job %s", job_id)

        return web.json_response({"ok": True})

    async def _handle_health(self, request: web.Request) -> web.Response:
        """GET /health"""
        status: dict = {
            "ok": True,
            "version": GIT_HASH,
            "vlm_model": VLM_MODEL,
        }
        if self._active_job:
            status["active_job"] = self._active_job.job_id
            status["active_since"] = round(
                time.monotonic() - self._active_job.started_at, 1
            )
        return web.json_response(status)

    # ------------------------------------------------------------------
    # Job execution
    # ------------------------------------------------------------------

    async def _run_job(self, active: ActiveJob, credentials: dict) -> None:
        """Execute a VLM-driven flow for the given job, then report result.

        Runs the synchronous VLMExecutor in a thread pool so we don't block
        the event loop (Chrome automation, VLM calls, and sleeps are all blocking).
        """
        result: ExecutionResult | None = None
        error_msg = ""

        try:
            # Derive tier from plan_id: "netflix_premium" -> "premium"
            plan_tier = ''
            if active.plan_id:
                prefix = active.service + '_'
                plan_tier = active.plan_id.removeprefix(prefix)

            log.info(
                "Starting execution: job=%s service=%s action=%s",
                active.job_id,
                active.service,
                active.action,
            )

            executor = VLMExecutor(
                vlm=self._vlm,
                profile=self._profile,
                otp_callback=self.request_otp,
                loop=self._loop,
            )

            result = await asyncio.get_running_loop().run_in_executor(
                None,
                executor.run,
                active.service,
                active.action,
                dict(credentials),  # defensive copy
                active.job_id,
                plan_tier,
            )

            if result.success:
                log.info(
                    "Job %s completed successfully in %.1fs (%d steps, %d VLM calls)",
                    active.job_id,
                    result.duration_seconds,
                    result.step_count,
                    result.inference_count,
                )
            else:
                log.warning(
                    "Job %s failed in %.1fs: %s",
                    active.job_id,
                    result.duration_seconds,
                    result.error_message,
                )

        except asyncio.CancelledError:
            error_msg = "Job aborted"
            log.info("Job %s was cancelled", active.job_id)

        except Exception as exc:
            error_msg = f"Unexpected error: {exc}"
            log.exception("Job %s crashed", active.job_id)

        finally:
            # Always report back to orchestrator, then clear active job
            await self._report_result(active, result, error_msg)
            async with self._lock:
                self._active_job = None

    async def _report_result(
        self,
        active: ActiveJob,
        result: ExecutionResult | None,
        fallback_error: str,
    ) -> None:
        """POST job result to the orchestrator's callback server."""
        if self._http_client is None:
            log.error("Cannot report result: HTTP client not initialized")
            return

        # Build the payload the orchestrator expects at POST /callback/result
        if result is not None:
            payload = {
                "job_id": active.job_id,
                "success": result.success,
                "access_end_date": result.billing_date,
                "error": result.error_message or None,
                "duration_seconds": int(result.duration_seconds),
            }
        else:
            payload = {
                "job_id": active.job_id,
                "success": False,
                "access_end_date": None,
                "error": fallback_error or "Unknown error",
                "duration_seconds": int(time.monotonic() - active.started_at),
            }

        url = f"{self._orchestrator_url}/callback/result"
        try:
            resp = await self._http_client.post(url, json=payload)
            if resp.status_code == 200:
                log.info("Reported result for job %s to orchestrator", active.job_id)
            else:
                log.error(
                    "Orchestrator rejected result for job %s: %d %s",
                    active.job_id,
                    resp.status_code,
                    resp.text,
                )
        except httpx.HTTPError as exc:
            log.error(
                "Failed to report result for job %s: %s", active.job_id, exc
            )

    # ------------------------------------------------------------------
    # OTP support (called from executor thread via the event loop)
    # ------------------------------------------------------------------

    async def request_otp(self, job_id: str, service: str, prompt: str | None = None) -> str | None:
        """Request an OTP code from the orchestrator and wait for it.

        Called when the executor detects an OTP screen. Posts to the orchestrator's
        /callback/otp-needed endpoint, then blocks until the orchestrator relays
        the code back via POST /otp.

        Returns the OTP code string, or None if timed out.
        """
        if self._http_client is None:
            log.error("Cannot request OTP: HTTP client not initialized")
            return None

        active = self._active_job
        if active is None or active.job_id != job_id:
            log.error("OTP request for non-active job %s", job_id)
            return None

        # Create a future that the /otp handler will resolve
        loop = asyncio.get_running_loop()
        active.otp_future = loop.create_future()

        # Notify orchestrator that we need an OTP
        url = f"{self._orchestrator_url}/callback/otp-needed"
        payload = {"job_id": job_id, "service": service, "prompt": prompt}
        try:
            resp = await self._http_client.post(url, json=payload)
            if resp.status_code != 200:
                log.error(
                    "Orchestrator rejected OTP request for job %s: %d",
                    job_id,
                    resp.status_code,
                )
                return None
        except httpx.HTTPError as exc:
            log.error("Failed to request OTP for job %s: %s", job_id, exc)
            return None

        # Wait for the code (up to 15 minutes, matching orchestrator's OTP timeout)
        otp_timeout = int(os.environ.get("OTP_TIMEOUT_SECONDS", "900"))
        try:
            code = await asyncio.wait_for(active.otp_future, timeout=otp_timeout)
            log.info("Received OTP for job %s", job_id)
            return code
        except asyncio.TimeoutError:
            log.warning("OTP timed out for job %s after %ds", job_id, otp_timeout)
            return None
        finally:
            active.otp_future = None


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

async def run() -> None:
    """Load config, start the agent, run until shutdown."""
    orchestrator_url = os.environ.get(
        "ORCHESTRATOR_URL", "http://192.168.1.101:8422"
    )
    profile_name = os.environ.get("AGENT_PROFILE", "normal")
    host = os.environ.get("AGENT_HOST", "0.0.0.0")
    port = AGENT_PORT

    agent = Agent(
        host=host,
        port=port,
        orchestrator_url=orchestrator_url,
        profile_name=profile_name,
    )

    await agent.start()

    # Signal handling
    shutdown = asyncio.Event()
    loop = asyncio.get_running_loop()

    def _signal_handler() -> None:
        log.info("Shutdown signal received")
        shutdown.set()

    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, _signal_handler)

    log.info(
        "Agent %s running (port=%d, vlm=%s, profile=%s)",
        GIT_HASH,
        port,
        VLM_MODEL,
        profile_name,
    )

    await shutdown.wait()
    log.info("Shutting down...")
    await agent.stop()
    log.info("Shutdown complete")


def main() -> None:
    """Entry point: load env, configure logging, run the agent."""
    # Load env files from ~/.unsaltedbutter/
    ub_dir = Path.home() / ".unsaltedbutter"
    shared_env = ub_dir / "shared.env"
    component_env = ub_dir / "agent.env"
    if shared_env.exists():
        load_dotenv(str(shared_env))
    if component_env.exists():
        load_dotenv(str(component_env), override=True)

    log_level = os.environ.get("LOG_LEVEL", "INFO").strip().upper()
    logging.basicConfig(
        level=getattr(logging, log_level, logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    try:
        asyncio.run(run())
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
