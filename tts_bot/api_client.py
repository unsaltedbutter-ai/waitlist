"""
HMAC-authenticated HTTP client for the VPS audio API.

Same signing algorithm as orchestrator/api_client.py.
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


class AudioApiClient:
    """HMAC-authenticated client for VPS /api/audio/* endpoints."""

    def __init__(self, base_url: str, hmac_secret: str) -> None:
        self._base_url = base_url.rstrip("/")
        self._hmac_secret = hmac_secret
        self._client: httpx.AsyncClient | None = None

    async def start(self) -> None:
        """Create the persistent httpx.AsyncClient."""
        self._client = httpx.AsyncClient(timeout=30.0)

    async def close(self) -> None:
        """Close the httpx client."""
        if self._client:
            await self._client.aclose()
            self._client = None

    def _sign(self, method: str, path: str, body: str) -> dict[str, str]:
        """Generate HMAC auth headers."""
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

    async def _request(
        self,
        method: str,
        path: str,
        body: str = "",
        timeout: float | None = None,
    ) -> httpx.Response:
        """Make an authenticated request."""
        if self._client is None:
            raise RuntimeError("AudioApiClient not started")

        url = self._base_url + path
        headers = self._sign(method, path, body)
        if body:
            headers["Content-Type"] = "application/json"

        kwargs: dict = {
            "method": method,
            "url": url,
            "content": body,
            "headers": headers,
        }
        if timeout is not None:
            kwargs["timeout"] = timeout

        return await self._client.request(**kwargs)

    # -- Cache ---------------------------------------------------------------

    async def check_cache(self, tweet_id: str) -> dict | None:
        """GET /api/audio/cache/{tweetId}. Returns cache entry or None."""
        path = f"/api/audio/cache/{tweet_id}"
        resp = await self._request("GET", path)
        if resp.status_code == 404:
            return None
        resp.raise_for_status()
        return resp.json()

    # -- Jobs ----------------------------------------------------------------

    async def create_audio_job(
        self,
        requester_npub: str,
        tweet_id: str,
        tweet_url: str,
        tweet_text: str,
        tweet_author: str | None,
        char_count: int,
        amount_sats: int,
        was_cached: bool,
        audio_cache_id: str | None = None,
        voice: str = "af_heart",
    ) -> dict:
        """POST /api/audio/jobs. Creates audio_job + BTCPay invoice.

        Returns {"job_id": str, "invoice_id": str, "bolt11": str, "audio_cache_id": str}.
        """
        path = "/api/audio/jobs"
        payload = {
            "requester_npub": requester_npub,
            "tweet_id": tweet_id,
            "tweet_url": tweet_url,
            "tweet_text": tweet_text,
            "tweet_author": tweet_author,
            "char_count": char_count,
            "amount_sats": amount_sats,
            "was_cached": was_cached,
            "audio_cache_id": audio_cache_id,
            "voice": voice,
        }
        body = json.dumps(payload)
        resp = await self._request("POST", path, body=body)
        resp.raise_for_status()
        return resp.json()

    async def update_audio_job_status(
        self, job_id: str, status: str, error_message: str | None = None,
    ) -> dict:
        """PATCH /api/audio/jobs/{id}/status. Updates job status."""
        path = f"/api/audio/jobs/{job_id}/status"
        payload: dict = {"status": status}
        if error_message:
            payload["error_message"] = error_message
        body = json.dumps(payload)
        resp = await self._request("PATCH", path, body=body)
        resp.raise_for_status()
        return resp.json()

    # -- Upload --------------------------------------------------------------

    async def upload_audio(
        self,
        audio_cache_id: str,
        audio_job_id: str,
        mp3_bytes: bytes,
        duration_seconds: int,
        tts_model: str,
        tts_voice: str,
        max_plays: int,
    ) -> dict:
        """POST /api/audio/upload. Upload MP3 and create purchase token.

        Returns {"token": str, "file_path": str}.
        """
        if self._client is None:
            raise RuntimeError("AudioApiClient not started")

        path = "/api/audio/upload"
        headers = self._sign("POST", path, "")

        # Multipart upload
        resp = await self._client.post(
            self._base_url + path,
            headers=headers,
            data={
                "audio_cache_id": audio_cache_id,
                "audio_job_id": audio_job_id,
                "duration_seconds": str(duration_seconds),
                "tts_model": tts_model,
                "tts_voice": tts_voice,
                "max_plays": str(max_plays),
            },
            files={"file": ("audio.mp3", mp3_bytes, "audio/mpeg")},
            timeout=120.0,
        )
        resp.raise_for_status()
        return resp.json()

    # -- In-flight check -----------------------------------------------------

    async def has_active_job(self, requester_npub: str) -> bool:
        """Check if a user has an in-flight audio job."""
        path = f"/api/audio/jobs/active/{requester_npub}"
        resp = await self._request("GET", path)
        if resp.status_code == 404:
            return False
        resp.raise_for_status()
        data = resp.json()
        return data.get("has_active", False)
