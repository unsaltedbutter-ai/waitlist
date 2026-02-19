"""Class-based HMAC-authenticated HTTP client for the VPS agent API.

Forked from nostr-bot/api_client.py, converted to class-based design
with a persistent httpx.AsyncClient for connection pooling.

All agent API endpoints require:
  - X-Agent-Timestamp: unix epoch seconds
  - X-Agent-Nonce: unique random string per request
  - X-Agent-Signature: hmac-sha256(secret, timestamp + nonce + method + path + sha256(body))
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import secrets
import time

import httpx

log = logging.getLogger(__name__)


class ApiClient:
    """Persistent, HMAC-authenticated HTTP client for the VPS agent API."""

    def __init__(self, base_url: str, hmac_secret: str) -> None:
        self._base_url: str = base_url.rstrip("/")
        self._hmac_secret: str = hmac_secret
        self._client: httpx.AsyncClient | None = None

    async def start(self) -> None:
        """Create the persistent httpx.AsyncClient."""
        self._client = httpx.AsyncClient(timeout=15.0)

    async def close(self) -> None:
        """Close the httpx client."""
        if self._client:
            await self._client.aclose()
            self._client = None

    # -- Auth headers --------------------------------------------------------

    def _sign(self, method: str, path: str, body: str) -> dict[str, str]:
        """Generate HMAC auth headers. Same algorithm as nostr-bot."""
        timestamp = str(int(time.time()))
        nonce = secrets.token_hex(16)
        body_hash = hashlib.sha256(body.encode("utf-8")).hexdigest()
        message = timestamp + nonce + method + path + body_hash
        signature = hmac.new(
            self._hmac_secret.encode("utf-8"),
            message.encode("utf-8"),
            hashlib.sha256,
        ).hexdigest()
        return {
            "X-Agent-Timestamp": timestamp,
            "X-Agent-Nonce": nonce,
            "X-Agent-Signature": signature,
        }

    # -- Internal request helper ---------------------------------------------

    async def _request(
        self,
        method: str,
        path: str,
        body: str = "",
        timeout: float | None = None,
    ) -> httpx.Response:
        """Make an authenticated request. Raises RuntimeError if not started."""
        if self._client is None:
            raise RuntimeError(
                "ApiClient not started. Call await client.start() first."
            )

        url = self._base_url + path
        headers = self._sign(method, path, body)
        if body:
            headers["Content-Type"] = "application/json"

        kwargs: dict = {"method": method, "url": url, "content": body, "headers": headers}
        if timeout is not None:
            kwargs["timeout"] = timeout

        return await self._client.request(**kwargs)

    # -- Users ---------------------------------------------------------------

    async def get_user(self, npub_hex: str) -> dict | None:
        """GET /api/agent/users/{npub}. Returns parsed JSON or None on 404."""
        path = f"/api/agent/users/{npub_hex}"
        resp = await self._request("GET", path)
        if resp.status_code == 404:
            return None
        resp.raise_for_status()
        return resp.json()

    # -- OTP -----------------------------------------------------------------

    async def create_otp(self, npub_hex: str) -> str:
        """POST /api/agent/otp. Returns the 12-digit OTP code string."""
        path = "/api/agent/otp"
        body = json.dumps({"npub_hex": npub_hex})
        resp = await self._request("POST", path, body=body)
        resp.raise_for_status()
        return resp.json()["code"]

    # -- Waitlist ------------------------------------------------------------

    async def add_to_waitlist(self, npub_hex: str) -> dict:
        """POST /api/agent/waitlist. Returns {"status": str, "invite_code": str|None}."""
        path = "/api/agent/waitlist"
        body = json.dumps({"npub_hex": npub_hex})
        resp = await self._request("POST", path, body=body)
        resp.raise_for_status()
        return resp.json()

    async def get_pending_invite_dms(self) -> list[dict]:
        """GET /api/agent/waitlist/pending-invites. Returns list."""
        path = "/api/agent/waitlist/pending-invites"
        resp = await self._request("GET", path)
        resp.raise_for_status()
        return resp.json()["pending"]

    async def mark_invite_dm_sent(self, waitlist_id: str) -> None:
        """POST /api/agent/waitlist/{id}/dm-sent."""
        path = f"/api/agent/waitlist/{waitlist_id}/dm-sent"
        resp = await self._request("POST", path)
        resp.raise_for_status()

    # -- Jobs ----------------------------------------------------------------

    async def get_pending_jobs(self) -> list[dict]:
        """GET /api/agent/jobs/pending. Returns list of pending jobs."""
        path = "/api/agent/jobs/pending"
        resp = await self._request("GET", path)
        resp.raise_for_status()
        return resp.json()["jobs"]

    async def claim_jobs(self, job_ids: list[str]) -> dict:
        """POST /api/agent/jobs/claim. Returns {"claimed": [...], "blocked": [...]}."""
        path = "/api/agent/jobs/claim"
        body = json.dumps({"job_ids": job_ids})
        resp = await self._request("POST", path, body=body)
        resp.raise_for_status()
        return resp.json()

    async def update_job_status(self, job_id: str, status: str, **kwargs: object) -> dict:
        """PATCH /api/agent/jobs/{id}/status. Returns {"job": {...}}.

        Extra kwargs (next_outreach_at, outreach_count, access_end_date,
        amount_sats, billing_date) are included in the request body.
        """
        path = f"/api/agent/jobs/{job_id}/status"
        payload: dict = {"status": status, **kwargs}
        body = json.dumps(payload)
        resp = await self._request("PATCH", path, body=body)
        resp.raise_for_status()
        return resp.json()

    async def create_on_demand_job(
        self, npub_hex: str, service: str, action: str
    ) -> dict:
        """POST /api/agent/users/{npub}/on-demand.

        Returns {"status_code": int, "data": dict} to let callers
        handle different status codes.
        """
        path = f"/api/agent/users/{npub_hex}/on-demand"
        body = json.dumps({"service": service, "action": action})
        resp = await self._request("POST", path, body=body)
        return {"status_code": resp.status_code, "data": resp.json()}

    async def mark_job_paid(
        self, job_id: str, zap_event_id: str | None = None
    ) -> dict:
        """POST /api/agent/jobs/{id}/paid.

        Returns {"status_code": int, "data": dict}.
        """
        path = f"/api/agent/jobs/{job_id}/paid"
        payload: dict = {}
        if zap_event_id:
            payload["zap_event_id"] = zap_event_id
        body = json.dumps(payload) if payload else ""
        resp = await self._request("POST", path, body=body)
        return {"status_code": resp.status_code, "data": resp.json()}

    # -- Credentials ---------------------------------------------------------

    async def get_credentials(
        self, npub_hex: str, service_id: str
    ) -> dict | None:
        """GET /api/agent/credentials/{npub}/{service}.

        Returns {"email": ..., "password": ...} or None on 403/404.
        Raises on other HTTP errors.
        """
        path = f"/api/agent/credentials/{npub_hex}/{service_id}"
        resp = await self._request("GET", path)
        if resp.status_code in (403, 404):
            return None
        resp.raise_for_status()
        return resp.json()

    # -- Invoices ------------------------------------------------------------

    async def create_invoice(
        self, job_id: str, amount_sats: int, user_npub: str
    ) -> dict:
        """POST /api/agent/invoices.

        Returns {"invoice_id": ..., "bolt11": ..., "amount_sats": ...}.
        """
        path = "/api/agent/invoices"
        body = json.dumps({
            "job_id": job_id,
            "amount_sats": amount_sats,
            "user_npub": user_npub,
        })
        resp = await self._request("POST", path, body=body)
        resp.raise_for_status()
        return resp.json()

    async def get_invoice(self, invoice_id: str) -> dict | None:
        """GET /api/agent/invoices/{id}. Returns invoice status or None on 404."""
        path = f"/api/agent/invoices/{invoice_id}"
        resp = await self._request("GET", path)
        if resp.status_code == 404:
            return None
        resp.raise_for_status()
        return resp.json()

    # -- Heartbeat -----------------------------------------------------------

    async def heartbeat(self, payload: dict | None = None) -> bool:
        """POST /api/agent/heartbeat. Returns True if 200, False otherwise."""
        path = "/api/agent/heartbeat"
        data: dict = {"component": "orchestrator"}
        if payload is not None:
            data["payload"] = payload
        body = json.dumps(data)
        try:
            resp = await self._request("POST", path, body=body)
            return resp.status_code == 200
        except httpx.HTTPError:
            return False
