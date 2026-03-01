"""
HTTP client for the TTS Agent (localhost:8425).

The TTS Bot sends extraction and synthesis requests to the TTS Agent,
which handles Chrome automation and TTS service communication.
"""

from __future__ import annotations

import logging

import httpx

log = logging.getLogger(__name__)


class TTSAgentClient:
    """Client for the TTS Agent HTTP API."""

    def __init__(self, base_url: str = "http://localhost:8425") -> None:
        self._base_url = base_url.rstrip("/")
        self._client: httpx.AsyncClient | None = None

    async def start(self) -> None:
        """Create the persistent httpx.AsyncClient."""
        self._client = httpx.AsyncClient(timeout=60.0)

    async def close(self) -> None:
        """Close the httpx client."""
        if self._client:
            await self._client.aclose()
            self._client = None

    async def extract_text(self, url: str) -> dict:
        """POST /extract: extract text from a tweet URL.

        Returns: {"text": str, "author": str|None, "char_count": int}
        Raises httpx.HTTPStatusError on failure.
        """
        if self._client is None:
            raise RuntimeError("TTSAgentClient not started")

        resp = await self._client.post(
            f"{self._base_url}/extract",
            json={"url": url},
            timeout=30.0,
        )
        resp.raise_for_status()
        return resp.json()

    async def synthesize(
        self,
        text: str,
        voice: str = "af_heart",
        speed: float = 1.0,
    ) -> bytes:
        """POST /synthesize: synthesize text to MP3.

        Returns MP3 bytes.
        Raises httpx.HTTPStatusError on failure.
        """
        if self._client is None:
            raise RuntimeError("TTSAgentClient not started")

        resp = await self._client.post(
            f"{self._base_url}/synthesize",
            json={"text": text, "voice": voice, "speed": speed},
            timeout=600.0,  # TTS can take minutes for long text
        )
        resp.raise_for_status()
        return resp.content

    async def health(self) -> dict:
        """GET /health: check TTS Agent health."""
        if self._client is None:
            raise RuntimeError("TTSAgentClient not started")

        resp = await self._client.get(f"{self._base_url}/health", timeout=5.0)
        resp.raise_for_status()
        return resp.json()
