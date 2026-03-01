"""
TTS Bot: Nostr bot for tweet-to-audio service.

Runs on Mac Studio. Listens for DMs containing X.com URLs,
coordinates text extraction, pricing, payment, TTS synthesis,
and delivery of listen links.

Much simpler than the cancel/resume orchestrator: no sessions,
no OTP relay, no complex timers, no credential decryption.
Linear flow only.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import signal
import sys
import time
from pathlib import Path

# Ensure project root is on sys.path so `tts_bot.*` and `shared.*` imports work
# regardless of which directory the user runs `python tts_bot.py` from.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from dotenv import load_dotenv
from nostr_sdk import (
    Client,
    Event,
    Filter,
    HandleNotification,
    Keys,
    Kind,
    nip04_decrypt,
    nip04_encrypt,
    PublicKey,
    RelayMessage,
    SecretKey,
    Timestamp,
)

from tts_bot.api_client import AudioApiClient
from tts_bot.config import Config
from tts_bot.nostr_handler import NostrHandler
from tts_bot.tts_agent_client import TTSAgentClient

log = logging.getLogger(__name__)


class TTSBot:
    """Main TTS Bot process."""

    def __init__(self, config: Config) -> None:
        self._config = config
        self._keys: Keys | None = None
        self._client: Client | None = None
        self._api: AudioApiClient | None = None
        self._tts_agent: TTSAgentClient | None = None
        self._handler: NostrHandler | None = None

        # Event deduplication (10-minute TTL)
        self._seen_events: dict[str, float] = {}
        self._dedup_ttl = 600.0

    async def start(self) -> None:
        """Initialize all components and connect to Nostr relays."""
        # Parse Nostr keys
        self._keys = Keys.parse(self._config.nostr_nsec)
        log.info("Bot pubkey: %s", self._keys.public_key().to_bech32())

        # Initialize HTTP clients
        self._api = AudioApiClient(
            self._config.api_base_url, self._config.hmac_secret,
        )
        await self._api.start()

        self._tts_agent = TTSAgentClient(self._config.tts_agent_url)
        await self._tts_agent.start()

        # Initialize handler
        self._handler = NostrHandler(
            config=self._config,
            api=self._api,
            tts_agent=self._tts_agent,
            send_dm_fn=self._send_dm,
        )

        # Connect to Nostr
        self._client = Client(self._keys)
        for relay in self._config.nostr_relays:
            await self._client.add_relay(relay)
        await self._client.connect()

        # Subscribe to DMs (NIP-04 Kind 4, addressed to us)
        our_pubkey = self._keys.public_key()
        dm_filter = Filter().kind(Kind(4)).pubkey(our_pubkey).since(
            Timestamp.now()
        )
        # Also subscribe to NIP-17 gift-wrapped DMs (Kind 1059)
        gift_filter = Filter().kind(Kind(1059)).pubkey(our_pubkey).since(
            Timestamp.now()
        )
        # Subscribe to NIP-57 zap receipts (Kind 9735) tagged to us
        zap_filter = Filter().kind(Kind(9735)).pubkey(our_pubkey).since(
            Timestamp.now()
        )
        await self._client.subscribe([dm_filter, gift_filter, zap_filter], None)

        log.info("Connected to %d relays", len(self._config.nostr_relays))

    async def stop(self) -> None:
        """Graceful shutdown."""
        if self._client:
            await self._client.disconnect()
            self._client = None

        if self._api:
            await self._api.close()
            self._api = None

        if self._tts_agent:
            await self._tts_agent.close()
            self._tts_agent = None

        log.info("TTS Bot stopped")

    async def _send_dm(self, recipient_npub: str, content: str) -> None:
        """Send a NIP-04 DM to a user (outbound always NIP-04)."""
        if not self._client or not self._keys:
            log.error("Cannot send DM: client not initialized")
            return

        try:
            recipient_pk = PublicKey.parse(recipient_npub)
            encrypted = nip04_encrypt(
                self._keys.secret_key(), recipient_pk, content,
            )

            # Build Kind 4 event
            from nostr_sdk import EventBuilder, Tag

            builder = EventBuilder(Kind(4), encrypted, [
                Tag.public_key(recipient_pk),
            ])
            event = builder.sign_with_keys(self._keys)

            # Publish to all relays
            await self._client.send_event(event)
            log.info(
                "Sent DM to %s (%d chars)",
                recipient_npub[:16], len(content),
            )

        except Exception:
            log.exception("Failed to send DM to %s", recipient_npub[:16])

    async def run_event_loop(self) -> None:
        """Main event loop: process incoming Nostr events."""
        if not self._client or not self._keys:
            raise RuntimeError("Bot not started")

        log.info("Entering event loop")

        while True:
            try:
                # Poll for notifications
                await self._client.handle_notifications(
                    _NotificationHandler(self)
                )
            except asyncio.CancelledError:
                break
            except Exception:
                log.exception("Error in event loop")
                await asyncio.sleep(1.0)

    async def _handle_event(self, event: Event) -> None:
        """Route an incoming event to the appropriate handler."""
        event_id = event.id().to_hex()

        # Dedup
        now = time.monotonic()
        self._cleanup_dedup(now)
        if event_id in self._seen_events:
            return
        self._seen_events[event_id] = now

        kind = event.kind().as_u16()

        if kind == 4:
            # NIP-04 DM
            await self._handle_nip04_dm(event)
        elif kind == 1059:
            # NIP-17 gift wrap (system push from VPS)
            await self._handle_gift_wrap(event)
        elif kind == 9735:
            # NIP-57 zap receipt
            await self._handle_zap(event)

    async def _handle_nip04_dm(self, event: Event) -> None:
        """Decrypt and process a NIP-04 DM."""
        if not self._keys:
            return

        sender_pk = event.author()
        sender_npub = sender_pk.to_hex()

        try:
            content = nip04_decrypt(
                self._keys.secret_key(), sender_pk, event.content(),
            )
        except Exception:
            log.warning("Failed to decrypt NIP-04 DM from %s", sender_npub[:16])
            return

        log.info("DM from %s: %s", sender_npub[:16], content[:100])

        # Check if this is a system push from VPS
        if sender_npub == self._config.vps_bot_pubkey:
            await self._handle_system_push(content)
        else:
            if self._handler:
                await self._handler.handle_dm(sender_npub, content)

    async def _handle_gift_wrap(self, event: Event) -> None:
        """Unwrap and process a NIP-17 gift-wrapped DM."""
        if not self._keys:
            return

        try:
            from nostr_sdk import UnwrappedGift

            unwrapped = UnwrappedGift.from_gift_wrap(self._keys, event)
            rumor = unwrapped.rumor()
            sender_pk = rumor.author()
            sender_npub = sender_pk.to_hex()
            content = rumor.content()

        except Exception:
            log.warning("Failed to unwrap NIP-17 gift wrap")
            return

        log.info("Gift wrap from %s: %s", sender_npub[:16], content[:100])

        if sender_npub == self._config.vps_bot_pubkey:
            await self._handle_system_push(content)
        else:
            if self._handler:
                await self._handler.handle_dm(sender_npub, content)

    async def _handle_zap(self, event: Event) -> None:
        """Validate and process a NIP-57 zap receipt."""
        if not self._keys or not self._handler:
            return

        from shared.zap_verify import validate_zap_receipt

        zap = validate_zap_receipt(
            event,
            bot_pubkey_hex=self._keys.public_key().to_hex(),
            zap_provider_pubkey_hex=self._config.zap_provider_pubkey,
        )
        if zap is None:
            return

        log.info(
            "Valid zap receipt %s from %s (%d sats)",
            zap.event_id[:16], zap.sender_hex[:16], zap.amount_sats,
        )

        await self._handler.handle_zap(zap)

    async def _handle_system_push(self, content: str) -> None:
        """Handle a push notification from the VPS."""
        try:
            payload = json.loads(content)
        except json.JSONDecodeError:
            log.warning("Invalid JSON in system push: %s", content[:100])
            return

        push_type = payload.get("type")
        data = payload.get("data", {})

        if push_type == "audio_payment_received":
            if self._handler:
                await self._handler.handle_payment_received(
                    requester_npub=data["requester_npub"],
                    audio_job_id=data["audio_job_id"],
                    audio_cache_id=data["audio_cache_id"],
                    tweet_text=data["tweet_text"],
                    tweet_author=data.get("tweet_author"),
                    was_cached=data.get("was_cached", False),
                )
        else:
            log.warning("Unknown system push type: %s", push_type)

    def _cleanup_dedup(self, now: float) -> None:
        """Remove expired entries from the dedup dict."""
        cutoff = now - self._dedup_ttl
        expired = [k for k, v in self._seen_events.items() if v < cutoff]
        for k in expired:
            del self._seen_events[k]


class _NotificationHandler(HandleNotification):
    """Bridge between nostr-sdk's notification system and our bot."""

    def __init__(self, bot: TTSBot) -> None:
        self._bot = bot

    async def handle(self, relay_url: str, subscription_id: str, event: Event) -> None:
        """Called when a new event arrives."""
        asyncio.create_task(self._bot._handle_event(event))

    async def handle_msg(self, relay_url: str, msg: RelayMessage) -> None:
        """Called for relay protocol messages (ignored)."""
        pass


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

async def run() -> None:
    """Load config, start the bot, run until shutdown."""
    config = Config.load()

    bot = TTSBot(config)
    await bot.start()

    shutdown = asyncio.Event()
    loop = asyncio.get_running_loop()

    def _signal_handler() -> None:
        log.info("Shutdown signal received")
        shutdown.set()

    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, _signal_handler)

    log.info("TTS Bot running")

    # Run event loop in background
    event_task = asyncio.create_task(bot.run_event_loop())

    await shutdown.wait()
    event_task.cancel()
    try:
        await event_task
    except asyncio.CancelledError:
        pass

    log.info("Shutting down...")
    await bot.stop()
    log.info("Shutdown complete")


def main() -> None:
    """Entry point: load env, configure logging, run the bot."""
    ub_dir = Path.home() / ".unsaltedbutter"
    shared_env = ub_dir / "shared.env"
    component_env = ub_dir / "tts_bot.env"
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
