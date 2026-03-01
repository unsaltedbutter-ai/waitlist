"""
Client for the Kokoro TTS service (localhost:8424).

Sends text to the TTS service, receives MP3 bytes back.
"""

from __future__ import annotations

import logging

import httpx

log = logging.getLogger(__name__)


async def synthesize(
    text: str,
    tts_url: str = "http://localhost:8424",
    voice: str = "af_heart",
    speed: float = 1.0,
    timeout: float = 600.0,
) -> bytes:
    """Send text to TTS service, return MP3 bytes.

    Args:
        text: The text to synthesize.
        tts_url: Base URL of the TTS service.
        voice: Kokoro voice ID.
        speed: Playback speed multiplier (1.0 = normal).
        timeout: Request timeout in seconds (TTS can take minutes for long text).

    Returns:
        MP3 bytes.

    Raises:
        httpx.HTTPStatusError: If the TTS service returns an error.
        httpx.TimeoutException: If the request times out.
    """
    async with httpx.AsyncClient(timeout=timeout) as client:
        log.info(
            "Synthesizing %d chars with voice=%s speed=%.1f",
            len(text), voice, speed,
        )

        resp = await client.post(
            f"{tts_url}/v1/tts",
            json={
                "text": text,
                "voice": voice,
                "speed": speed,
            },
        )
        resp.raise_for_status()

        mp3_bytes = resp.content
        log.info(
            "TTS complete: %d bytes MP3 (%.1f MB)",
            len(mp3_bytes), len(mp3_bytes) / (1024 * 1024),
        )
        return mp3_bytes
