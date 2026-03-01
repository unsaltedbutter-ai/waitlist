"""
TTS Agent: HTTP server for text extraction and TTS synthesis.

Runs on Mac Studio (port 8425). Receives requests from the TTS Bot,
extracts text from X.com URLs via Chrome, and synthesizes audio via
the Kokoro TTS service.

Endpoints:
  POST /extract    - extract text from a tweet URL via Chrome
  POST /synthesize - synthesize text to MP3 via Kokoro TTS
  GET  /health     - liveness check
"""

from __future__ import annotations

import asyncio
import logging
import os
import signal
import subprocess
from pathlib import Path

from aiohttp import web
from dotenv import load_dotenv

from tts_agent.config import Config

log = logging.getLogger(__name__)

# Git hash for version logging
try:
    GIT_HASH = subprocess.run(
        ["git", "rev-parse", "--short", "HEAD"],
        capture_output=True,
        text=True,
        timeout=5,
    ).stdout.strip() or "unknown"
except Exception:
    GIT_HASH = "unknown"


class TTSAgent:
    """HTTP server that handles text extraction and TTS synthesis."""

    def __init__(self, config: Config) -> None:
        self._config = config
        self._app = web.Application()
        self._runner: web.AppRunner | None = None
        self._extracting = False  # one-at-a-time guard for Chrome

    async def start(self) -> None:
        """Start the HTTP server."""
        self._app.router.add_post("/extract", self._handle_extract)
        self._app.router.add_post("/synthesize", self._handle_synthesize)
        self._app.router.add_get("/health", self._handle_health)

        self._runner = web.AppRunner(self._app)
        await self._runner.setup()
        site = web.TCPSite(self._runner, self._config.host, self._config.port)
        await site.start()
        log.info(
            "TTS Agent listening on %s:%d",
            self._config.host, self._config.port,
        )

    async def stop(self) -> None:
        """Graceful shutdown."""
        if self._runner:
            await self._runner.cleanup()
            self._runner = None
        log.info("TTS Agent stopped")

    # ------------------------------------------------------------------
    # HTTP handlers
    # ------------------------------------------------------------------

    async def _handle_extract(self, request: web.Request) -> web.Response:
        """POST /extract

        Body: {"url": "https://x.com/user/status/123"}
        Returns: {"text": "...", "author": "@handle", "char_count": 1234}
        """
        try:
            data = await request.json()
        except Exception:
            return web.json_response({"error": "Invalid JSON"}, status=400)

        url = data.get("url")
        if not url:
            return web.json_response({"error": "Missing url"}, status=400)

        if self._extracting:
            return web.json_response(
                {"error": "Extraction already in progress"},
                status=409,
            )

        self._extracting = True
        try:
            # Run Chrome automation in a thread (blocking I/O)
            from tts_agent.text_extractor import extract_clipboard_text
            from tts_agent.text_parser import extract_author_info, extract_post_text

            clipboard_text = await asyncio.get_running_loop().run_in_executor(
                None, extract_clipboard_text, url,
            )

            if not clipboard_text.strip():
                return web.json_response(
                    {"error": "Empty clipboard (page may not have loaded)"},
                    status=502,
                )

            # Extract post body via VLM
            post_text = await extract_post_text(clipboard_text)
            if not post_text:
                return web.json_response(
                    {"error": "Could not extract post text from page"},
                    status=502,
                )

            author_name, author_handle = extract_author_info(clipboard_text)

            return web.json_response({
                "text": post_text,
                "author_name": author_name,
                "author_handle": author_handle,
                "char_count": len(post_text),
            })

        except Exception:
            log.exception("Text extraction failed for %s", url)
            return web.json_response(
                {"error": "Text extraction failed"},
                status=500,
            )
        finally:
            self._extracting = False

    async def _handle_synthesize(self, request: web.Request) -> web.Response:
        """POST /synthesize

        Body: {"text": "...", "voice": "af_heart", "speed": 1.0}
        Returns: audio/mpeg bytes (MP3)
        """
        try:
            data = await request.json()
        except Exception:
            return web.json_response({"error": "Invalid JSON"}, status=400)

        text = data.get("text")
        if not text:
            return web.json_response({"error": "Missing text"}, status=400)

        voice = data.get("voice", "af_heart")
        speed = data.get("speed", 1.0)

        try:
            from tts_agent.tts_client import synthesize

            mp3_bytes = await synthesize(
                text=text,
                tts_url=self._config.tts_url,
                voice=voice,
                speed=speed,
            )

            return web.Response(
                body=mp3_bytes,
                content_type="audio/mpeg",
            )

        except Exception:
            log.exception("TTS synthesis failed")
            return web.json_response(
                {"error": "TTS synthesis failed"},
                status=500,
            )

    async def _handle_health(self, request: web.Request) -> web.Response:
        """GET /health"""
        return web.json_response({
            "ok": True,
            "version": GIT_HASH,
            "extracting": self._extracting,
        })


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

async def run() -> None:
    """Load config, start the agent, run until shutdown."""
    config = Config.load()

    agent = TTSAgent(config)
    await agent.start()

    shutdown = asyncio.Event()
    loop = asyncio.get_running_loop()

    def _signal_handler() -> None:
        log.info("Shutdown signal received")
        shutdown.set()

    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, _signal_handler)

    log.info("TTS Agent %s running (port=%d)", GIT_HASH, config.port)

    await shutdown.wait()
    log.info("Shutting down...")
    await agent.stop()
    log.info("Shutdown complete")


def main() -> None:
    """Entry point: load env, configure logging, run the agent."""
    ub_dir = Path.home() / ".unsaltedbutter"
    shared_env = ub_dir / "shared.env"
    component_env = ub_dir / "tts_agent.env"
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
