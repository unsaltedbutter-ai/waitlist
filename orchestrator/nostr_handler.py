"""Top-level Nostr event handler for the orchestrator.

Routes incoming Nostr events to the appropriate handler:
  - Kind 4 (NIP-04 DM): decrypt, route to CommandRouter or NotificationHandler
  - Kind 1059 (NIP-17 gift wrap): unwrap, route same as above
  - Kind 9735 (zap receipt): forward to zap_handler
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import TYPE_CHECKING

from nostr_sdk import (
    Client,
    Event,
    EventBuilder,
    HandleNotification,
    Keys,
    Kind,
    KindStandard,
    NostrSigner,
    PublicKey,
    RelayMessage,
    RelayUrl,
    Tag,
    Timestamp,
    UnsignedEvent,
    UnwrappedGift,
    nip04_decrypt,
)

import zap_handler
from db import _redact_sensitive

if TYPE_CHECKING:
    from api_client import ApiClient
    from commands import CommandRouter
    from config import Config
    from db import Database
    from notifications import NotificationHandler

log = logging.getLogger(__name__)


class NostrHandler(HandleNotification):
    """Top-level Nostr event handler for the orchestrator.

    Routes:
    - Kind 4 (NIP-04 DM): decrypt, check sender.
      If VPS bot -> push handler. If user -> command router.
    - Kind 1059 (NIP-17 gift wrap): unwrap, check sender. Same routing.
    - Kind 9735 (zap receipt): forward to zap handler.

    Supports two-phase initialization: construct with core dependencies,
    then call wire() to attach commands and notifications after they are
    created (they need send_dm from this handler, creating a circular dep).
    """

    def __init__(
        self,
        keys: Keys,
        signer: NostrSigner,
        client: Client,
        start_time: Timestamp,
        config: Config,
        db: Database,
        api_client: ApiClient,
        commands: CommandRouter | None = None,
        notifications: NotificationHandler | None = None,
    ) -> None:
        self._keys = keys
        self._signer = signer
        self._client = client
        self._start_time = start_time
        self._config = config
        self._commands = commands
        self._notifications = notifications
        self._db = db
        self._api_client = api_client
        self._bot_pubkey_hex = keys.public_key().to_hex()
        # Track each user's last-seen DM protocol for reply matching.
        # Default (missing key) = "nip04" for compatibility on outreach.
        self._user_protocol: dict[str, str] = {}
        # Per-user locks: prevent concurrent DM processing for the same user.
        # Two DMs from the same user (e.g., NIP-04 and NIP-17 both deliver)
        # could race through state transitions without serialization.
        self._user_locks: dict[str, asyncio.Lock] = {}
        self._user_lock_last_used: dict[str, float] = {}
        # Maximum idle time (seconds) before a user lock is eligible for cleanup.
        self._lock_idle_seconds: float = 300.0
        # Event deduplication: map event_id_hex -> monotonic timestamp when first seen.
        # Relays can deliver the same event multiple times (from different relays
        # or on reconnection). We skip events we have already processed.
        self._seen_events: dict[str, float] = {}
        self._seen_events_ttl: float = 600.0  # 10 minutes
        # Only prune stale entries every N events to avoid O(n) on every call.
        self._seen_events_check_counter: int = 0
        self._seen_events_prune_interval: int = 50

    def wire(
        self,
        commands: CommandRouter,
        notifications: NotificationHandler,
    ) -> None:
        """Set late-bound dependencies after construction.

        NostrHandler provides send_dm/send_operator_dm to other modules,
        but commands and notifications need send_dm to be created. This
        two-phase init breaks the circular dependency: construct the handler
        first, pass send_dm to commands/notifications, then wire them back.
        """
        self._commands = commands
        self._notifications = notifications

    # -- Per-user lock management -----------------------------------------------

    def _get_user_lock(self, npub_hex: str) -> asyncio.Lock:
        """Get or create an asyncio.Lock for a specific user.

        Creates the lock on first access. Tracks last-used time for cleanup.
        """
        lock = self._user_locks.get(npub_hex)
        if lock is None:
            lock = asyncio.Lock()
            self._user_locks[npub_hex] = lock
        self._user_lock_last_used[npub_hex] = time.monotonic()
        return lock

    def cleanup_idle_locks(self) -> int:
        """Remove locks for users who have been idle longer than _lock_idle_seconds.

        Only removes locks that are not currently held. Returns the number
        of locks removed. Safe to call periodically (e.g., every 5 minutes).
        """
        now = time.monotonic()
        to_remove = []
        for npub_hex, last_used in self._user_lock_last_used.items():
            if now - last_used > self._lock_idle_seconds:
                lock = self._user_locks.get(npub_hex)
                if lock is not None and not lock.locked():
                    to_remove.append(npub_hex)
        for npub_hex in to_remove:
            del self._user_locks[npub_hex]
            del self._user_lock_last_used[npub_hex]
        return len(to_remove)

    # -- Event deduplication ----------------------------------------------------

    def _is_duplicate(self, event_id_hex: str) -> bool:
        """Check if we have already processed this event ID.

        Returns True if the event was already seen (caller should skip it).
        Returns False if the event is new (registers it for future checks).

        Periodically prunes entries older than _seen_events_ttl to bound
        memory usage without paying O(n) on every call.
        """
        now = time.monotonic()

        # Periodic cleanup of expired entries.
        self._seen_events_check_counter += 1
        if self._seen_events_check_counter >= self._seen_events_prune_interval:
            self._seen_events_check_counter = 0
            cutoff = now - self._seen_events_ttl
            stale = [eid for eid, ts in self._seen_events.items() if ts < cutoff]
            for eid in stale:
                del self._seen_events[eid]

        if event_id_hex in self._seen_events:
            return True

        self._seen_events[event_id_hex] = now
        return False

    # -- HandleNotification interface ------------------------------------------

    async def handle(self, relay_url: RelayUrl, subscription_id: str, event: Event):
        """Route events by kind. Skips duplicate events silently."""
        event_id_hex = event.id().to_hex()
        if self._is_duplicate(event_id_hex):
            log.debug("Skipping duplicate event %s", event_id_hex[:16])
            return

        kind = event.kind()
        log.debug("[event] kind=%s id=%s author=%s", kind.as_u16(), event_id_hex[:16], event.author().to_hex()[:16])
        try:
            if kind == Kind(4):
                await self._handle_nip04_dm(event)
            elif kind.as_std() == KindStandard.GIFT_WRAP:
                await self._handle_nip17_dm(event)
            elif kind.as_std() == KindStandard.ZAP_RECEIPT:
                await self._handle_zap(event)
        except Exception:
            log.exception(
                "Error handling event %s (kind %s)",
                event.id().to_hex()[:16],
                kind.as_u16(),
            )

    async def handle_msg(self, relay_url: RelayUrl, msg: RelayMessage):
        """Required by HandleNotification. No-op."""
        pass

    # -- Private handlers ------------------------------------------------------

    async def _handle_nip04_dm(self, event: Event) -> None:
        """Handle a NIP-04 DM (kind 4)."""
        if event.created_at().as_secs() < self._start_time.as_secs():
            return

        sender_pk = event.author()
        sender_hex = sender_pk.to_hex()
        plaintext = nip04_decrypt(
            self._keys.secret_key(), sender_pk, event.content()
        )

        sender_npub = sender_pk.to_bech32()
        log.info("[nip04] DM from %s (%s): %s", sender_npub, sender_hex[:16], _redact_sensitive(plaintext)[:100])
        await self._db.log_message("inbound", sender_hex, plaintext)

        if sender_hex == self._config.vps_bot_pubkey:
            log.info("[nip04] Sender matches VPS_BOT_PUBKEY, routing to push handler")
            await self._notifications.handle_push(plaintext)
            return

        self._user_protocol[sender_hex] = "nip04"
        async with self._get_user_lock(sender_hex):
            await self._commands.handle_dm(sender_hex, plaintext)

    async def _handle_nip17_dm(self, event: Event) -> None:
        """Handle a NIP-17 gift-wrapped DM (kind 1059)."""
        unwrapped: UnwrappedGift = await UnwrappedGift.from_gift_wrap(
            self._signer, event
        )
        sender: PublicKey = unwrapped.sender()
        rumor: UnsignedEvent = unwrapped.rumor()

        if rumor.created_at().as_secs() < self._start_time.as_secs():
            return

        # Only handle kind 14 (private DM)
        if rumor.kind().as_std() != KindStandard.PRIVATE_DIRECT_MESSAGE:
            return

        sender_hex = sender.to_hex()
        sender_npub = sender.to_bech32()
        plaintext = rumor.content()

        log.info("[nip17] DM from %s (%s): %s", sender_npub, sender_hex[:16], _redact_sensitive(plaintext)[:100])
        await self._db.log_message("inbound", sender_hex, plaintext)

        if sender_hex == self._config.vps_bot_pubkey:
            log.info("[nip17] Sender matches VPS_BOT_PUBKEY, routing to push handler")
            await self._notifications.handle_push(plaintext)
            return

        log.debug(
            "[nip17] Sender %s does not match VPS_BOT_PUBKEY %s, treating as user DM",
            sender_hex[:16], self._config.vps_bot_pubkey[:16],
        )
        self._user_protocol[sender_hex] = "nip17"
        async with self._get_user_lock(sender_hex):
            await self._commands.handle_dm(sender_hex, plaintext)

    async def _handle_zap(self, event: Event) -> None:
        """Handle a zap receipt (kind 9735)."""
        if event.created_at().as_secs() < self._start_time.as_secs():
            return

        async def send_dm(pubkey_hex: str, text: str) -> None:
            pk = PublicKey.parse(pubkey_hex)
            await self._client.send_private_msg(pk, text, [])

        await zap_handler.handle_zap_receipt(
            event,
            send_dm,
            self._bot_pubkey_hex,
            self._config.zap_provider_pubkey,
            api_client=self._api_client,
        )

    # -- DM sending helpers (used by other modules via callback) ---------------

    async def _send_nip04(self, pk: PublicKey, text: str) -> None:
        """Send a NIP-04 (kind 4) DM for broad client compatibility."""
        ciphertext = await self._signer.nip04_encrypt(pk, text)
        builder = EventBuilder(Kind(4), ciphertext).tags([
            Tag.parse(["p", pk.to_hex()])
        ])
        await self._client.send_event_builder(builder)

    async def send_dm(self, recipient_npub: str, text: str) -> None:
        """Send a DM using the recipient's last-seen protocol.

        If the user last sent us a NIP-04 DM, reply with NIP-04.
        If NIP-17, reply with NIP-17.
        Default (outreach, no prior contact): NIP-04 for compatibility.
        """
        try:
            pk = PublicKey.parse(recipient_npub)
            protocol = self._user_protocol.get(recipient_npub, "nip04")
            if protocol == "nip17":
                await self._client.send_private_msg(pk, text, [])
            else:
                await self._send_nip04(pk, text)
            await self._db.log_message("outbound", recipient_npub, text)
        except Exception:
            log.exception("Failed to send DM to %s", recipient_npub[:16])

    async def send_operator_dm(self, text: str) -> None:
        """Send a DM to the operator."""
        await self.send_dm(self._config.operator_pubkey, text)
