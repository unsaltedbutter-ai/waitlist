"""UnsaltedButter Agent: main entry point.

Runs on Mac Mini. Listens for job dispatches from the orchestrator via HTTP,
executes browser automation via VLM-driven screenshot analysis,
and reports results back to the orchestrator via HTTP callback.

Endpoints (matches what orchestrator's AgentClient sends):
  POST /execute   - accept a cancel/resume job
  POST /otp       - relay an OTP code to a running job
  POST /credential - relay a credential to a running job
  POST /abort     - cancel a running job
  GET  /health    - liveness check

Multi-job execution: up to MAX_CONCURRENT_AGENT_JOBS jobs run concurrently.
GUI actions are serialized via gui_lock; everything else (VLM inference,
screenshots, OTP waits) runs in true parallel across jobs.
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

from agent.config import AGENT_PORT, MAX_CONCURRENT_AGENT_JOBS
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
    """Tracks a currently-running job and its OTP/credential channels."""

    job_id: str
    service: str
    action: str
    plan_id: str = ''
    task: asyncio.Task | None = None
    otp_future: asyncio.Future | None = None
    credential_future: asyncio.Future | None = None
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
        max_jobs: int = MAX_CONCURRENT_AGENT_JOBS,
    ) -> None:
        self._host = host
        self._port = port
        self._orchestrator_url = orchestrator_url.rstrip("/")
        self._profile = PROFILES.get(profile_name, NORMAL)
        self._max_jobs = max_jobs

        self._app = web.Application()
        self._runner: web.AppRunner | None = None
        self._http_client: httpx.AsyncClient | None = None

        self._active_jobs: dict[str, ActiveJob] = {}
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

        # Read VLM config fresh from env (dotenv runs before start(), but
        # after module imports, so module-level constants are stale).
        vlm_url = os.environ.get("VLM_URL", "")
        vlm_key = os.environ.get("VLM_KEY", "")
        vlm_model = os.environ.get("VLM_MODEL", "qwen3-vl-32b")

        # Create VLM client
        if not vlm_url:
            log.warning("VLM_URL not set; jobs will fail until configured")
        self._vlm = VLMClient(
            base_url=vlm_url or "http://localhost:8080",
            api_key=vlm_key,
            model=vlm_model,
        )
        self._vlm_model = vlm_model
        log.info("VLM client: model=%s url=%s", vlm_model, vlm_url or "(not set)")

        # Register routes
        self._app.router.add_post("/execute", self._handle_execute)
        self._app.router.add_post("/otp", self._handle_otp)
        self._app.router.add_post("/credential", self._handle_credential)
        self._app.router.add_post("/abort", self._handle_abort)
        self._app.router.add_get("/health", self._handle_health)

        self._runner = web.AppRunner(self._app)
        await self._runner.setup()
        site = web.TCPSite(self._runner, self._host, self._port)
        await site.start()
        log.info(
            "Agent listening on %s:%d (max_jobs=%d)",
            self._host, self._port, self._max_jobs,
        )

    async def stop(self) -> None:
        """Graceful shutdown: wait for all active jobs, then clean up."""
        self._shutdown.set()

        # Wait for all active jobs to finish (with timeout)
        tasks = [
            aj.task for aj in self._active_jobs.values()
            if aj.task and not aj.task.done()
        ]
        if tasks:
            log.info("Waiting for %d active job(s) to complete...", len(tasks))
            done, pending = await asyncio.wait(tasks, timeout=30.0)
            for t in pending:
                job_name = t.get_name()
                log.warning("Job %s did not finish in 30s, cancelling", job_name)
                t.cancel()
                try:
                    await t
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
        Accepts the job if a slot is available, rejects if at capacity.
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
            if job_id in self._active_jobs:
                return web.json_response(
                    {"error": f"Job {job_id} already running"},
                    status=409,
                )

            if len(self._active_jobs) >= self._max_jobs:
                running = list(self._active_jobs.keys())
                log.warning(
                    "Rejected job %s: at capacity (%d/%d, running: %s)",
                    job_id, len(self._active_jobs), self._max_jobs, running,
                )
                return web.json_response(
                    {"error": f"At capacity ({len(self._active_jobs)}/{self._max_jobs})"},
                    status=409,
                )

            active = ActiveJob(job_id=job_id, service=service, action=action, plan_id=plan_id or '')
            self._active_jobs[job_id] = active
            log.info(
                "Accepted job %s (%s/%s) [%d/%d slots]",
                job_id, service, action,
                len(self._active_jobs), self._max_jobs,
            )

        # Run the job in a background task so we can return 200 immediately
        active.task = asyncio.create_task(
            self._run_job(active, credentials),
            name=f"job-{job_id}",
        )

        return web.json_response({"ok": True, "job_id": job_id})

    async def _handle_otp(self, request: web.Request) -> web.Response:
        """POST /otp

        Body: {"job_id": str, "code": str}
        Delivers an OTP code to the specified running job.
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

        active = self._active_jobs.get(job_id)
        if active is None:
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

    async def _handle_credential(self, request: web.Request) -> web.Response:
        """POST /credential

        Body: {"job_id": str, "credential_name": str, "value": str}
        Delivers a credential value to the specified running job.
        """
        try:
            data = await request.json()
        except Exception:
            return web.json_response({"error": "Invalid JSON"}, status=400)

        job_id = data.get("job_id")
        credential_name = data.get("credential_name")
        value = data.get("value")

        if not job_id or not credential_name or not value:
            return web.json_response(
                {"error": "Missing job_id, credential_name, or value"}, status=400
            )

        active = self._active_jobs.get(job_id)
        if active is None:
            log.warning("Credential for unknown/inactive job %s", job_id)
            return web.json_response(
                {"error": f"No active job with id {job_id}"}, status=404
            )

        if active.credential_future is not None and not active.credential_future.done():
            active.credential_future.set_result(value)
            log.info("Credential '%s' delivered for job %s", credential_name, job_id)
        else:
            log.warning(
                "Credential arrived for job %s but no future is waiting", job_id
            )

        return web.json_response({"ok": True})

    async def _handle_abort(self, request: web.Request) -> web.Response:
        """POST /abort

        Body: {"job_id": str}
        Cancels a specific running job.
        """
        try:
            data = await request.json()
        except Exception:
            return web.json_response({"error": "Invalid JSON"}, status=400)

        job_id = data.get("job_id")
        if not job_id:
            return web.json_response({"error": "Missing job_id"}, status=400)

        active = self._active_jobs.get(job_id)
        if active is None:
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
        active_jobs = []
        for aj in self._active_jobs.values():
            active_jobs.append({
                "job_id": aj.job_id,
                "service": aj.service,
                "action": aj.action,
                "elapsed_seconds": round(time.monotonic() - aj.started_at, 1),
            })

        status: dict = {
            "ok": True,
            "version": GIT_HASH,
            "vlm_model": self._vlm_model,
            "max_jobs": self._max_jobs,
            "active_job_count": len(self._active_jobs),
            "slots_available": self._max_jobs - len(self._active_jobs),
            "active_jobs": active_jobs,
        }
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
                credential_callback=self.request_credential,
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
            # Always report back to orchestrator, then free the slot
            await self._report_result(active, result, error_msg)
            async with self._lock:
                self._active_jobs.pop(active.job_id, None)
            log.info(
                "Slot freed for job %s [%d/%d slots]",
                active.job_id,
                len(self._active_jobs), self._max_jobs,
            )

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

        active = self._active_jobs.get(job_id)
        if active is None:
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

    # ------------------------------------------------------------------
    # Credential support (called from executor thread via the event loop)
    # ------------------------------------------------------------------

    async def request_credential(
        self, job_id: str, service: str, credential_name: str,
    ) -> str | None:
        """Request a credential from the orchestrator and wait for it.

        Called when the executor encounters a field (e.g. CVV) that is not
        in the credentials dict. Posts to the orchestrator's
        /callback/credential-needed endpoint, then blocks until the
        orchestrator relays the value back via POST /credential.

        Returns the credential value, or None if timed out.
        """
        if self._http_client is None:
            log.error("Cannot request credential: HTTP client not initialized")
            return None

        active = self._active_jobs.get(job_id)
        if active is None:
            log.error("Credential request for non-active job %s", job_id)
            return None

        # Create a future that the /credential handler will resolve
        loop = asyncio.get_running_loop()
        active.credential_future = loop.create_future()

        # Notify orchestrator that we need a credential
        url = f"{self._orchestrator_url}/callback/credential-needed"
        payload = {
            "job_id": job_id,
            "service": service,
            "credential_name": credential_name,
        }
        try:
            resp = await self._http_client.post(url, json=payload)
            if resp.status_code != 200:
                log.error(
                    "Orchestrator rejected credential request for job %s: %d",
                    job_id,
                    resp.status_code,
                )
                return None
        except httpx.HTTPError as exc:
            log.error(
                "Failed to request credential for job %s: %s", job_id, exc
            )
            return None

        # Wait for the value (up to 15 minutes, matching OTP timeout)
        cred_timeout = int(os.environ.get("OTP_TIMEOUT_SECONDS", "900"))
        try:
            value = await asyncio.wait_for(
                active.credential_future, timeout=cred_timeout
            )
            log.info("Received credential '%s' for job %s", credential_name, job_id)
            return value
        except asyncio.TimeoutError:
            log.warning(
                "Credential '%s' timed out for job %s after %ds",
                credential_name, job_id, cred_timeout,
            )
            return None
        finally:
            active.credential_future = None


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
        "Agent %s running (port=%d, vlm=%s, profile=%s, max_jobs=%d)",
        GIT_HASH,
        port,
        os.environ.get("VLM_MODEL", "qwen3-vl-32b"),
        profile_name,
        MAX_CONCURRENT_AGENT_JOBS,
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
