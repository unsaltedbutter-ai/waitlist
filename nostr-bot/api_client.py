"""HMAC-authenticated HTTP client for the VPS agent API.

All agent API endpoints require:
  - X-Agent-Timestamp: unix epoch seconds
  - X-Agent-Nonce: unique random string per request
  - X-Agent-Signature: hmac-sha256(secret, timestamp + nonce + method + path + sha256(body))
"""

import hashlib
import hmac
import json
import logging
import os
import secrets
import time

import httpx

log = logging.getLogger(__name__)

_BASE_URL: str = ""
_HMAC_SECRET: str = ""


def init(base_url: str | None = None, hmac_secret: str | None = None) -> None:
    """Initialize the API client with base URL and HMAC secret."""
    global _BASE_URL, _HMAC_SECRET
    _BASE_URL = (base_url or os.environ.get("API_BASE_URL", "")).rstrip("/")
    _HMAC_SECRET = hmac_secret or os.environ.get("AGENT_HMAC_SECRET", "")
    if not _BASE_URL:
        raise ValueError("API_BASE_URL not set")
    if not _HMAC_SECRET:
        raise ValueError("AGENT_HMAC_SECRET not set")


def _sign(method: str, path: str, body: str) -> dict[str, str]:
    """Generate HMAC auth headers for a request."""
    timestamp = str(int(time.time()))
    nonce = secrets.token_hex(16)
    body_hash = hashlib.sha256(body.encode("utf-8")).hexdigest()
    message = timestamp + nonce + method + path + body_hash
    signature = hmac.new(_HMAC_SECRET.encode("utf-8"), message.encode("utf-8"), hashlib.sha256).hexdigest()
    return {
        "X-Agent-Timestamp": timestamp,
        "X-Agent-Nonce": nonce,
        "X-Agent-Signature": signature,
    }


async def _request(method: str, path: str, body: str = "", timeout: float = 15.0) -> httpx.Response:
    """Make an authenticated request to the agent API."""
    url = _BASE_URL + path
    headers = _sign(method, path, body)
    if body:
        headers["Content-Type"] = "application/json"

    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.request(method, url, content=body, headers=headers)

    return resp


async def get_user(npub_hex: str) -> dict | None:
    """GET /api/agent/users/{npub}. Returns the parsed JSON or None on 404."""
    path = f"/api/agent/users/{npub_hex}"
    resp = await _request("GET", path)
    if resp.status_code == 404:
        return None
    resp.raise_for_status()
    return resp.json()


async def create_otp(npub_hex: str) -> str:
    """POST /api/agent/otp. Returns the 12-digit OTP code string."""
    path = "/api/agent/otp"
    body = json.dumps({"npub_hex": npub_hex})
    resp = await _request("POST", path, body=body)
    resp.raise_for_status()
    return resp.json()["code"]


async def add_to_waitlist(npub_hex: str) -> dict:
    """POST /api/agent/waitlist. Returns {"status": str, "invite_code": str|None}."""
    path = "/api/agent/waitlist"
    body = json.dumps({"npub_hex": npub_hex})
    resp = await _request("POST", path, body=body)
    resp.raise_for_status()
    return resp.json()


async def auto_invite(npub_hex: str) -> dict:
    """POST /api/agent/waitlist/auto-invite.

    Auto-grants an invite (or returns existing one).
    Returns {"status": "invited"|"already_invited"|"at_capacity", "invite_code": str|None}.
    """
    path = "/api/agent/waitlist/auto-invite"
    body = json.dumps({"npub_hex": npub_hex})
    resp = await _request("POST", path, body=body)
    resp.raise_for_status()
    return resp.json()


async def get_pending_invite_dms() -> list[dict]:
    """GET /api/agent/waitlist/pending-invites. Returns list of pending entries."""
    path = "/api/agent/waitlist/pending-invites"
    resp = await _request("GET", path)
    resp.raise_for_status()
    return resp.json()["pending"]


async def mark_invite_dm_sent(waitlist_id: str) -> None:
    """POST /api/agent/waitlist/{id}/dm-sent. Marks invite DM as delivered."""
    path = f"/api/agent/waitlist/{waitlist_id}/dm-sent"
    resp = await _request("POST", path)
    resp.raise_for_status()


async def create_on_demand_job(npub_hex: str, service: str, action: str) -> dict:
    """POST /api/agent/users/{npub}/on-demand.

    Returns the parsed JSON response. Raises httpx.HTTPStatusError on failure.
    The caller should inspect the status code for specific error handling.
    """
    path = f"/api/agent/users/{npub_hex}/on-demand"
    body = json.dumps({"service": service, "action": action})
    resp = await _request("POST", path, body=body)
    return {"status_code": resp.status_code, "data": resp.json()}


async def mark_job_paid(job_id: str, zap_event_id: str | None = None) -> dict:
    """POST /api/agent/jobs/{id}/paid.

    Returns the parsed JSON response with status_code.
    """
    path = f"/api/agent/jobs/{job_id}/paid"
    payload: dict = {}
    if zap_event_id:
        payload["zap_event_id"] = zap_event_id
    body = json.dumps(payload) if payload else ""
    resp = await _request("POST", path, body=body)
    return {"status_code": resp.status_code, "data": resp.json()}
