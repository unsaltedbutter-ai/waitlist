"""
Nostr DM handler for the TTS Bot.

Parses incoming DMs, validates URLs, manages the conversation flow
(extract -> quote -> pay -> synthesize -> deliver link).

Uses NIP-04 for all outbound DMs (client compatibility).
"""

from __future__ import annotations

import asyncio
import logging
from typing import TYPE_CHECKING

from tts_bot import messages
from tts_bot.url_parser import is_valid_tweet_id, parse_tweet_url

if TYPE_CHECKING:
    from tts_bot.api_client import AudioApiClient
    from tts_bot.config import Config
    from tts_bot.tts_agent_client import TTSAgentClient

log = logging.getLogger(__name__)


class NostrHandler:
    """Handles incoming Nostr DMs and orchestrates the audio workflow."""

    def __init__(
        self,
        config: "Config",
        api: "AudioApiClient",
        tts_agent: "TTSAgentClient",
        send_dm_fn,
    ) -> None:
        self._config = config
        self._api = api
        self._tts_agent = tts_agent
        self._send_dm = send_dm_fn

        # Per-user lock to serialize DMs from the same npub
        self._user_locks: dict[str, asyncio.Lock] = {}

    def _get_user_lock(self, npub: str) -> asyncio.Lock:
        """Get or create a per-user asyncio lock."""
        if npub not in self._user_locks:
            self._user_locks[npub] = asyncio.Lock()
        return self._user_locks[npub]

    async def handle_dm(self, sender_npub: str, content: str) -> None:
        """Process an incoming DM from a user.

        The main entry point for all user messages. Serialized per-user
        to prevent race conditions with concurrent DMs.
        """
        lock = self._get_user_lock(sender_npub)
        async with lock:
            await self._process_dm(sender_npub, content)

    async def _process_dm(self, sender_npub: str, content: str) -> None:
        """Inner DM processing (called under per-user lock)."""
        # Parse tweet URL from message
        tweet_url, tweet_id = parse_tweet_url(content)

        if not tweet_url or not tweet_id or not is_valid_tweet_id(tweet_id):
            await self._send_dm(sender_npub, messages.invalid_url())
            return

        # Check one-at-a-time rate limit
        try:
            has_active = await self._api.has_active_job(sender_npub)
            if has_active:
                await self._send_dm(sender_npub, messages.already_in_progress())
                return
        except Exception:
            log.exception("Failed to check active jobs for %s", sender_npub)

        # Check cache
        cache_entry = None
        try:
            cache_entry = await self._api.check_cache(tweet_id)
        except Exception:
            log.exception("Failed to check cache for tweet %s", tweet_id)

        if cache_entry and cache_entry.get("file_path"):
            # Fully cached: MP3 already exists
            await self._handle_cached(sender_npub, cache_entry)
        elif cache_entry and cache_entry.get("tweet_text"):
            # Text cached but no MP3: reuse text, skip extraction
            await self._handle_text_cached(sender_npub, tweet_url, cache_entry)
        else:
            # Uncached: need to extract text first
            await self._handle_uncached(sender_npub, tweet_url, tweet_id)

    async def _handle_cached(self, sender_npub: str, cache_entry: dict) -> None:
        """Fully cached tweet (MP3 exists). Quote with discount."""
        char_count = cache_entry["char_count"]
        price = self._config.get_cached_price_sats(char_count)

        if price is None:
            await self._send_dm(
                sender_npub,
                messages.too_long(char_count, self._config.max_chars),
            )
            return

        # Create audio job with cached flag
        try:
            result = await self._api.create_audio_job(
                requester_npub=sender_npub,
                tweet_id=cache_entry["tweet_id"],
                tweet_url=cache_entry["tweet_url"],
                tweet_text=cache_entry["tweet_text"],
                tweet_author=cache_entry.get("tweet_author"),
                char_count=char_count,
                amount_sats=price,
                was_cached=True,
                audio_cache_id=cache_entry["id"],
            )
        except Exception:
            log.exception("Failed to create cached audio job")
            await self._send_dm(sender_npub, messages.extraction_failed())
            return

        quote = messages.price_quote(
            char_count=char_count,
            price_sats=price,
            cached=True,
            cache_discount_pct=self._config.cache_discount_pct,
        )
        bolt11 = result.get("bolt11", "")
        await self._send_dm(sender_npub, f"{quote}\n\n{bolt11}")

    async def _handle_text_cached(
        self, sender_npub: str, tweet_url: str, cache_entry: dict,
    ) -> None:
        """Text cached but no MP3. Quote at full price (TTS still needed)."""
        char_count = cache_entry["char_count"]
        price = self._config.get_price_sats(char_count)

        if price is None:
            await self._send_dm(
                sender_npub,
                messages.too_long(char_count, self._config.max_chars),
            )
            return

        try:
            result = await self._api.create_audio_job(
                requester_npub=sender_npub,
                tweet_id=cache_entry["tweet_id"],
                tweet_url=tweet_url,
                tweet_text=cache_entry["tweet_text"],
                tweet_author=cache_entry.get("tweet_author"),
                char_count=char_count,
                amount_sats=price,
                was_cached=False,
                audio_cache_id=cache_entry["id"],
            )
        except Exception:
            log.exception("Failed to create text-cached audio job")
            await self._send_dm(sender_npub, messages.extraction_failed())
            return

        quote = messages.price_quote(char_count=char_count, price_sats=price)
        bolt11 = result.get("bolt11", "")
        await self._send_dm(sender_npub, f"{quote}\n\n{bolt11}")

    async def _handle_uncached(
        self, sender_npub: str, tweet_url: str, tweet_id: str,
    ) -> None:
        """Uncached tweet. Extract text, then quote."""
        # Extract text via TTS Agent
        try:
            extraction = await self._tts_agent.extract_text(tweet_url)
        except Exception:
            log.exception("Text extraction failed for %s", tweet_url)
            await self._send_dm(sender_npub, messages.extraction_failed())
            return

        text = extraction.get("text")
        if not text:
            await self._send_dm(sender_npub, messages.extraction_failed())
            return

        char_count = len(text)
        author_name = extraction.get("author_name")
        author_handle = extraction.get("author_handle")
        # Store combined for DB: "Peter Girnus (@gothburz)"
        if author_name and author_handle:
            author = f"{author_name} ({author_handle})"
        else:
            author = author_handle or author_name

        # Check char limit
        if char_count > self._config.max_chars:
            await self._send_dm(
                sender_npub,
                messages.too_long(char_count, self._config.max_chars),
            )
            return

        price = self._config.get_price_sats(char_count)
        if price is None:
            await self._send_dm(
                sender_npub,
                messages.too_long(char_count, self._config.max_chars),
            )
            return

        # Create audio job (this also stores extracted text in audio_cache)
        try:
            result = await self._api.create_audio_job(
                requester_npub=sender_npub,
                tweet_id=tweet_id,
                tweet_url=tweet_url,
                tweet_text=text,
                tweet_author=author,
                char_count=char_count,
                amount_sats=price,
                was_cached=False,
            )
        except Exception:
            log.exception("Failed to create audio job")
            await self._send_dm(sender_npub, messages.extraction_failed())
            return

        quote = messages.price_quote(char_count=char_count, price_sats=price)
        bolt11 = result.get("bolt11", "")
        await self._send_dm(sender_npub, f"{quote}\n\n{bolt11}")

    async def handle_payment_received(
        self, requester_npub: str, audio_job_id: str, audio_cache_id: str,
        tweet_text: str, tweet_author: str | None, was_cached: bool,
    ) -> None:
        """Handle audio_payment_received push from VPS.

        If fully cached (MP3 exists), create purchase token and send link immediately.
        Otherwise, synthesize audio, upload, then send link.
        """
        await self._send_dm(requester_npub, messages.payment_received())

        if was_cached:
            # MP3 already exists, just create purchase token
            try:
                result = await self._api.update_audio_job_status(
                    audio_job_id, "completed"
                )
                # The VPS creates the purchase token when job completes
                token = result.get("token")
                if token:
                    base_url = self._config.api_base_url.rstrip("/")
                    link = messages.listen_link(base_url, token)
                    await self._send_dm(requester_npub, link)
            except Exception:
                log.exception("Failed to complete cached audio job %s", audio_job_id)
                await self._send_dm(requester_npub, messages.synthesis_failed())
            return

        # Not cached: synthesize with author preamble
        try:
            await self._api.update_audio_job_status(audio_job_id, "synthesizing")

            # Parse author name/handle from stored format "Name (@handle)"
            author_name, author_handle = _parse_stored_author(tweet_author)

            from tts_agent.text_parser import format_tts_text
            tts_text = format_tts_text(tweet_text, author_name, author_handle)

            mp3_bytes = await self._tts_agent.synthesize(
                text=tts_text,
                voice=self._config.default_voice,
            )

            # Estimate duration from MP3 size (128kbps = 16KB/s)
            duration_seconds = max(1, len(mp3_bytes) // 16000)

            upload_result = await self._api.upload_audio(
                audio_cache_id=audio_cache_id,
                audio_job_id=audio_job_id,
                mp3_bytes=mp3_bytes,
                duration_seconds=duration_seconds,
                tts_model="kokoro-82m",
                tts_voice=self._config.default_voice,
                max_plays=self._config.max_plays,
            )

            token = upload_result.get("token")
            if token:
                base_url = self._config.api_base_url.rstrip("/")
                link = messages.listen_link(base_url, token)
                await self._send_dm(requester_npub, link)
            else:
                log.error("Upload succeeded but no token returned")
                await self._send_dm(requester_npub, messages.synthesis_failed())

        except Exception:
            log.exception("Synthesis/upload failed for job %s", audio_job_id)
            try:
                await self._api.update_audio_job_status(
                    audio_job_id, "failed", error_message="TTS synthesis failed",
                )
            except Exception:
                log.exception("Failed to mark job as failed: %s", audio_job_id)
            await self._send_dm(requester_npub, messages.synthesis_failed())


def _parse_stored_author(tweet_author: str | None) -> tuple[str | None, str | None]:
    """Parse stored author format back into (name, handle).

    Stored format: "Peter Girnus (@gothburz)" or just "@gothburz" or "Peter Girnus"
    """
    if not tweet_author:
        return None, None

    import re
    # "Name (@handle)"
    match = re.match(r"^(.+?)\s+\((@[A-Za-z0-9_]+)\)$", tweet_author)
    if match:
        return match.group(1).strip(), match.group(2)

    # Just "@handle"
    if tweet_author.startswith("@"):
        return None, tweet_author

    # Just a name
    return tweet_author, None
