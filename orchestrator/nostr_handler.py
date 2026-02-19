"""Top-level Nostr event handler for the orchestrator.

Routes incoming Nostr events to the appropriate handler:
  - Kind 4 (NIP-04 DM): decrypt, route to CommandRouter or NotificationHandler
  - Kind 1059 (NIP-17 gift wrap): unwrap, route same as above
  - Kind 9735 (zap receipt): forward to zap_handler
"""

from __future__ import annotations

import logging
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
    """

    def __init__(
        self,
        keys: Keys,
        signer: NostrSigner,
        client: Client,
        start_time: Timestamp,
        config: Config,
        commands: CommandRouter,
        notifications: NotificationHandler,
        db: Database,
        api_client: ApiClient,
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

    # -- HandleNotification interface ------------------------------------------

    async def handle(self, relay_url: RelayUrl, subscription_id: str, event: Event):
        """Route events by kind."""
        kind = event.kind()
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

        await self._db.log_message("inbound", sender_hex, plaintext)

        if sender_hex == self._config.vps_bot_pubkey:
            await self._notifications.handle_push(plaintext)
            return

        self._user_protocol[sender_hex] = "nip04"
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
        plaintext = rumor.content()

        await self._db.log_message("inbound", sender_hex, plaintext)

        if sender_hex == self._config.vps_bot_pubkey:
            await self._notifications.handle_push(plaintext)
            return

        self._user_protocol[sender_hex] = "nip17"
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
        await self.send_dm(self._config.operator_npub, text)
