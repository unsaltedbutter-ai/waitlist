"""HTTP client for the Mac Mini Chrome automation agent.

The agent runs on the local network at port 8421. No auth required (LAN only).
Orchestrator dispatches jobs, relays OTP codes, and can abort running jobs.
"""

from __future__ import annotations

import logging

import httpx

log = logging.getLogger(__name__)


class AgentClient:
    """Async HTTP client for the Mac Mini Chrome agent."""

    def __init__(self, base_url: str = "http://192.168.1.100:8421") -> None:
        self._base_url = base_url.rstrip("/")
        self._client: httpx.AsyncClient | None = None

    async def start(self) -> None:
        """Create the persistent httpx.AsyncClient."""
        self._client = httpx.AsyncClient(timeout=30.0)

    async def close(self) -> None:
        """Close the httpx client."""
        if self._client:
            await self._client.aclose()
            self._client = None

    def _ensure_started(self) -> httpx.AsyncClient:
        """Return the active client or raise if not started."""
        if self._client is None:
            raise RuntimeError(
                "AgentClient not started. Call await client.start() first."
            )
        return self._client

    # -- Job dispatch ------------------------------------------------------------

    async def execute(
        self,
        job_id: str,
        service: str,
        action: str,
        credentials: dict,
        plan_id: str | None = None,
        plan_display_name: str | None = None,
        user_npub: str | None = None,
    ) -> bool:
        """POST /execute. Dispatch a cancel/resume job to the agent.

        credentials: {"email": ..., "password": ...}
        plan_id: optional service plan id (e.g. "netflix_premium") for resume flows.
        plan_display_name: optional human-readable plan name (e.g. "Disney Bundle Trio Premium").
        user_npub: optional user npub for debug trace metadata.
        Returns True if accepted (200), False otherwise.
        """
        client = self._ensure_started()
        try:
            payload: dict = {
                "job_id": job_id,
                "service": service,
                "action": action,
                "credentials": credentials,
            }
            if plan_id:
                payload["plan_id"] = plan_id
            if plan_display_name:
                payload["plan_display_name"] = plan_display_name
            if user_npub:
                payload["user_npub"] = user_npub
            resp = await client.post(
                f"{self._base_url}/execute",
                json=payload,
            )
            accepted = resp.status_code == 200
            if not accepted:
                log.warning(
                    "Agent rejected execute for job %s: %d %s",
                    job_id, resp.status_code, resp.text,
                )
            return accepted
        except httpx.HTTPError as exc:
            log.error("Agent execute request failed for job %s: %s", job_id, exc)
            return False

    # -- OTP relay ---------------------------------------------------------------

    async def relay_otp(self, job_id: str, code: str) -> bool:
        """POST /otp. Relay an OTP code to the agent mid-session.

        Returns True if accepted (200), False otherwise.
        """
        client = self._ensure_started()
        try:
            resp = await client.post(
                f"{self._base_url}/otp",
                json={"job_id": job_id, "code": code},
            )
            accepted = resp.status_code == 200
            if not accepted:
                log.warning(
                    "Agent rejected OTP relay for job %s: %d",
                    job_id, resp.status_code,
                )
            return accepted
        except httpx.HTTPError as exc:
            log.error("Agent OTP relay failed for job %s: %s", job_id, exc)
            return False

    # -- Credential relay --------------------------------------------------------

    async def relay_credential(
        self, job_id: str, credential_name: str, value: str,
    ) -> bool:
        """POST /credential. Relay a credential value to the agent mid-session.

        Returns True if accepted (200), False otherwise.
        """
        client = self._ensure_started()
        try:
            resp = await client.post(
                f"{self._base_url}/credential",
                json={
                    "job_id": job_id,
                    "credential_name": credential_name,
                    "value": value,
                },
            )
            accepted = resp.status_code == 200
            if not accepted:
                log.warning(
                    "Agent rejected credential relay for job %s: %d",
                    job_id, resp.status_code,
                )
            return accepted
        except httpx.HTTPError as exc:
            log.error(
                "Agent credential relay failed for job %s: %s", job_id, exc
            )
            return False

    # -- Abort -------------------------------------------------------------------

    async def abort(self, job_id: str) -> bool:
        """POST /abort. Cancel a running job on the agent.

        Returns True if accepted (200), False otherwise.
        """
        client = self._ensure_started()
        try:
            resp = await client.post(
                f"{self._base_url}/abort",
                json={"job_id": job_id},
            )
            accepted = resp.status_code == 200
            if not accepted:
                log.warning(
                    "Agent rejected abort for job %s: %d",
                    job_id, resp.status_code,
                )
            return accepted
        except httpx.HTTPError as exc:
            log.error("Agent abort request failed for job %s: %s", job_id, exc)
            return False

    # -- Health ------------------------------------------------------------------

    async def health(self) -> bool:
        """GET /health. Returns True if the agent is alive and responding."""
        client = self._ensure_started()
        try:
            resp = await client.get(f"{self._base_url}/health")
            return resp.status_code == 200
        except httpx.HTTPError:
            return False
