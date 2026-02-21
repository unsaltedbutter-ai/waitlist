"""UnsaltedButter Nostr Bot: DM commands + zap invoice payments."""

import asyncio
import json
import logging
import os
import signal

from pathlib import Path

from dotenv import load_dotenv
from nostr_sdk import (
    Client,
    Event,
    EventBuilder,
    Filter,
    HandleNotification,
    Keys,
    Kind,
    KindStandard,
    Metadata,
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

import api_client
import commands
import notifications
import zap_handler

_ub_dir = Path.home() / ".unsaltedbutter"
_shared = _ub_dir / "shared.env"
_component = _ub_dir / "nostr-bot.env"
if _shared.exists():
    load_dotenv(_shared)
if _component.exists():
    load_dotenv(_component, override=True)

log = logging.getLogger(__name__)


def _npub_to_hex(npub_bech32: str) -> str:
    """Convert npub1... bech32 to hex. Returns empty string on error."""
    try:
        return PublicKey.parse(npub_bech32).to_hex()
    except Exception:
        return ""


class BotNotificationHandler(HandleNotification):
    def __init__(
        self,
        keys: Keys,
        signer: NostrSigner,
        client: Client,
        start_time: Timestamp,
        zap_provider_pubkey_hex: str,
        vps_bot_pubkey_hex: str,
        operator_pubkey_hex: str = "",
    ):
        self._keys = keys
        self._signer = signer
        self._client = client
        self._start_time = start_time
        self._bot_pubkey_hex = keys.public_key().to_hex()
        self._zap_provider_pubkey_hex = zap_provider_pubkey_hex
        self._vps_bot_pubkey_hex = vps_bot_pubkey_hex
        self._operator_pubkey_hex = operator_pubkey_hex

    async def handle(self, relay_url: RelayUrl, subscription_id: str, event: Event):
        kind = event.kind()

        try:
            if kind == Kind(4):
                await self._handle_nip04_dm(event)
            elif kind.as_std() == KindStandard.GIFT_WRAP:
                await self._handle_nip17_dm(event)
            elif kind.as_std() == KindStandard.ZAP_RECEIPT:
                await self._handle_zap(event)
        except Exception:
            log.exception("Error handling event %s (kind %s)", event.id().to_hex()[:16], kind.as_u16())

    async def handle_msg(self, relay_url: RelayUrl, msg: RelayMessage):
        pass

    # -- NIP-04 DM (kind 4) ---------------------------------------------------

    async def _handle_nip04_dm(self, event: Event):
        # Skip old events
        if event.created_at().as_secs() < self._start_time.as_secs():
            return

        sender_pk = event.author()
        sender_hex = sender_pk.to_hex()

        plaintext = nip04_decrypt(self._keys.secret_key(), sender_pk, event.content())
        log.info("NIP-04 DM from %s: %s", sender_hex[:16], plaintext[:80])

        # Check if this is a push notification from the VPS bot
        if sender_hex == self._vps_bot_pubkey_hex:
            await self._handle_push_notification(plaintext)
            return

        replies = await self._dispatch_command(sender_hex, plaintext)
        if isinstance(replies, str):
            replies = [replies]
        for reply in replies:
            log.info("Replying (NIP-04) to %s: %s", sender_hex[:16], reply[:80])
            try:
                await self._send_nip04_reply(sender_pk, reply)
                log.info("NIP-04 reply sent to %s", sender_hex[:16])
            except Exception as e:
                log.error("Failed to send NIP-04 reply to %s: %s", sender_hex[:16], e)

    async def _send_nip04_reply(self, recipient: PublicKey, text: str):
        ciphertext = await self._signer.nip04_encrypt(recipient, text)
        builder = EventBuilder(Kind(4), ciphertext).tags([
            Tag.parse(["p", recipient.to_hex()])
        ])
        await self._client.send_event_builder(builder)

    # -- NIP-17 DM (kind 1059 gift wrap) --------------------------------------

    async def _handle_nip17_dm(self, event: Event):
        unwrapped: UnwrappedGift = await UnwrappedGift.from_gift_wrap(self._signer, event)
        sender: PublicKey = unwrapped.sender()
        rumor: UnsignedEvent = unwrapped.rumor()

        # Skip old events
        if rumor.created_at().as_secs() < self._start_time.as_secs():
            return

        # Only handle kind 14 (private DM)
        if rumor.kind().as_std() != KindStandard.PRIVATE_DIRECT_MESSAGE:
            return

        sender_hex = sender.to_hex()
        plaintext = rumor.content()
        log.info("NIP-17 DM from %s: %s", sender_hex[:16], plaintext[:80])

        # Check if this is a push notification from the VPS bot
        if sender_hex == self._vps_bot_pubkey_hex:
            await self._handle_push_notification(plaintext)
            return

        replies = await self._dispatch_command(sender_hex, plaintext)
        if isinstance(replies, str):
            replies = [replies]
        for reply in replies:
            await self._client.send_private_msg(sender, reply, [])

    # -- Zap receipt (kind 9735) -----------------------------------------------

    async def _handle_zap(self, event: Event):
        if event.created_at().as_secs() < self._start_time.as_secs():
            return

        async def send_dm(pubkey_hex: str, text: str):
            pk = PublicKey.parse(pubkey_hex)
            # Zap is user-initiated, but we don't track protocol here.
            # Default to NIP-04 for compatibility.
            await self._send_nip04_reply(pk, text)

        await zap_handler.handle_zap_receipt(
            event, send_dm, self._bot_pubkey_hex, self._zap_provider_pubkey_hex,
        )

    # -- Push notification from VPS bot ----------------------------------------

    async def _handle_push_notification(self, message: str):
        """Handle a push notification from the VPS private bot."""
        payload = notifications.parse_push_notification(message)
        if payload is None:
            log.debug("Ignoring non-JSON message from VPS bot: %s", message[:80])
            return

        target_npub, msg = notifications.format_notification(payload)
        if target_npub and msg:
            try:
                pk = PublicKey.parse(target_npub)
                # Proactive outbound: use NIP-04 for client compatibility
                await self._send_nip04_reply(pk, msg)
                log.info("Forwarded %s notification to %s", payload.get("type"), target_npub[:16])
            except Exception as e:
                log.error("Failed to forward notification to %s: %s", target_npub[:16], e)
        else:
            log.debug("Push notification type %s produced no message", payload.get("type"))

    # -- Command dispatch ------------------------------------------------------

    async def _dispatch_command(self, sender_hex: str, message: str) -> str:
        cmd = message.strip().lower()
        data = await api_client.get_user(sender_hex)
        user = data["user"] if data else None

        # "login" requires an account or an invite
        if cmd == "login":
            if user is None:
                # Check if they're already invited (e.g. returning after account deletion)
                result = await api_client.add_to_waitlist(sender_hex)
                if result["status"] == "already_invited":
                    code = await api_client.create_otp(sender_hex)
                    formatted = f"{code[:6]}-{code[6:]}"
                    base_url = os.getenv("BASE_URL", "https://unsaltedbutter.ai")
                    return [
                        formatted,
                        f"That's your login code. Enter it within 5 minutes.\n\n{base_url}/login",
                    ]
                # Not invited yet: waitlist message
                return self._waitlist_message(result)
            code = await api_client.create_otp(sender_hex)
            formatted = f"{code[:6]}-{code[6:]}"
            base_url = os.getenv("BASE_URL", "https://unsaltedbutter.ai")
            return [
                formatted,
                f"That's your login code. Enter it within 5 minutes.\n\n{base_url}/login",
            ]

        # "waitlist" only for unregistered users
        if cmd == "waitlist":
            if user is not None:
                return "You already have an account."
            return await self._auto_waitlist(sender_hex)

        # "invites" operator-only: trigger sending pending invite DMs
        if cmd == "invites":
            if self._operator_pubkey_hex and sender_hex == self._operator_pubkey_hex:
                count = await self._send_pending_invite_dms()
                return f"Sent {count} invite DM(s)." if count > 0 else "No pending invite DMs."
            # Non-operators fall through to normal handling

        # Everything else requires registration
        if user is None:
            return await self._auto_waitlist(sender_hex)

        # Registered but hasn't completed onboarding
        if user["onboarded_at"] is None:
            base_url = os.getenv("BASE_URL", "https://unsaltedbutter.ai")
            return f"Complete your setup first.\n\n{base_url}/login"

        return await commands.handle_dm(sender_hex, message)

    # -- Auto-waitlist for unregistered users ----------------------------------

    async def _auto_waitlist(self, sender_hex: str) -> str:
        """Add unregistered user to waitlist automatically and return a message."""
        result = await api_client.add_to_waitlist(sender_hex)
        return self._waitlist_message(result)

    @staticmethod
    def _waitlist_message(result: dict) -> str:
        """Format a human-readable message from a waitlist API result."""
        if result["status"] == "added":
            return "You're on the waitlist. We'll DM you when a spot opens."
        elif result["status"] == "already_invited":
            base_url = os.getenv("BASE_URL", "https://unsaltedbutter.ai")
            return f"You've already been invited. DM me 'login' to get your code.\n\n{base_url}/login"
        else:
            return "You're already on the waitlist. We'll DM you when a spot opens."

    # -- Invite DM sending -----------------------------------------------------

    async def _send_pending_invite_dms(self) -> int:
        """Send invite link DMs to waitlist entries flagged invite_dm_pending."""
        pending = await api_client.get_pending_invite_dms()
        base_url = os.getenv("BASE_URL", "https://unsaltedbutter.ai")
        count = 0

        for entry in pending:
            text = f"You're in. DM me 'login' to get your code.\n\n{base_url}/login"
            try:
                pk = PublicKey.parse(entry["nostr_npub"])
                # Use NIP-04 (kind 4) for broad client compatibility
                ciphertext = await self._signer.nip04_encrypt(pk, text)
                builder = EventBuilder(Kind(4), ciphertext).tags([
                    Tag.parse(["p", pk.to_hex()])
                ])
                await self._client.send_event_builder(builder)
                await api_client.mark_invite_dm_sent(entry["id"])
                count += 1
                log.info("Sent invite DM to %s", entry["nostr_npub"][:16])
            except Exception as e:
                log.error("Failed to send invite DM to %s: %s", entry["nostr_npub"][:16], e)

        return count


async def _invite_check_loop(handler, shutdown_event):
    """Periodically check for pending invite DMs (backup in case VPS push is missed)."""
    # Wait 60 seconds after startup before first check
    try:
        await asyncio.wait_for(shutdown_event.wait(), timeout=60)
        return
    except asyncio.TimeoutError:
        pass

    while not shutdown_event.is_set():
        try:
            count = await handler._send_pending_invite_dms()
            if count > 0:
                log.info("[invite_check] Sent %d invite DM(s)", count)
        except Exception as e:
            log.error("[invite_check] Error: %s", e)

        try:
            await asyncio.wait_for(shutdown_event.wait(), timeout=6 * 3600)
            return
        except asyncio.TimeoutError:
            pass


async def main():
    # Logging
    level = os.getenv("LOG_LEVEL", "INFO").upper()
    logging.basicConfig(
        level=getattr(logging, level, logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    # API client
    api_client.init()

    # Nostr keys
    nsec = os.environ["NOSTR_NSEC"]
    keys = Keys.parse(nsec)
    signer = NostrSigner.keys(keys)
    bot_pk = keys.public_key()
    log.info("Bot pubkey: %s", bot_pk.to_bech32())

    # Zap provider pubkey (required for validating zap receipts per NIP-57)
    zap_provider_pubkey_hex = PublicKey.parse(os.environ["ZAP_PROVIDER_PUBKEY"]).to_hex()
    log.info("Zap provider pubkey: %s...", zap_provider_pubkey_hex[:16])

    # VPS private bot pubkey (for receiving push notifications)
    raw_vps_bot = os.getenv("VPS_BOT_PUBKEY", "")
    if raw_vps_bot:
        vps_bot_pubkey_hex = PublicKey.parse(raw_vps_bot).to_hex()
        log.info("VPS bot pubkey: %s...", vps_bot_pubkey_hex[:16])
    else:
        vps_bot_pubkey_hex = ""
        log.warning("VPS_BOT_PUBKEY not set, push notifications from VPS will be ignored")

    # Client
    client = Client(signer)
    relays = os.getenv("NOSTR_RELAYS", "wss://relay.damus.io,wss://nos.lol,wss://relay.snort.social")
    for relay in relays.split(","):
        relay = relay.strip()
        if relay:
            await client.add_relay(RelayUrl.parse(relay))
    await client.connect()
    log.info("Connected to relays")

    # Publish kind 0 profile metadata
    meta_dict = {
        "name": os.getenv("BOT_NAME", "UnsaltedButter Bot"),
        "about": os.getenv("BOT_ABOUT", "DM me to manage your streaming services. Pay-per-action, 3k sats."),
    }
    bot_lud16 = os.getenv("BOT_LUD16", "")
    if bot_lud16:
        meta_dict["lud16"] = bot_lud16
    metadata = Metadata.from_json(json.dumps(meta_dict))
    await client.set_metadata(metadata)
    log.info("Published kind 0 profile")

    # Subscribe (since=now so we don't reprocess old events)
    start_time = Timestamp.now()
    f = (
        Filter()
        .pubkey(bot_pk)
        .kinds([
            Kind(4),
            Kind.from_std(KindStandard.GIFT_WRAP),
            Kind.from_std(KindStandard.ZAP_RECEIPT),
        ])
        .since(start_time)
    )
    await client.subscribe(f)
    log.info("Subscribed to kind 4, 1059, 9735")

    # Signal handling for clean shutdown
    shutdown_event = asyncio.Event()
    loop = asyncio.get_running_loop()

    def _signal_handler():
        log.info("Shutdown signal received")
        shutdown_event.set()

    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, _signal_handler)

    # Operator pubkey (for gating operator-only commands)
    raw_operator = os.getenv("OPERATOR_NPUB", "")
    operator_pubkey_hex = _npub_to_hex(raw_operator) if raw_operator else ""

    # Run notification handler
    handler = BotNotificationHandler(keys, signer, client, start_time, zap_provider_pubkey_hex, vps_bot_pubkey_hex, operator_pubkey_hex)
    notify_task = asyncio.create_task(client.handle_notifications(handler))

    # Run periodic invite check (backup)
    invite_task = asyncio.create_task(_invite_check_loop(handler, shutdown_event))

    log.info("Bot running. Waiting for events...")

    # Wait for shutdown signal
    await shutdown_event.wait()

    # Clean shutdown
    log.info("Shutting down...")
    notify_task.cancel()
    invite_task.cancel()
    for task in (notify_task, invite_task):
        try:
            await task
        except asyncio.CancelledError:
            pass

    await client.disconnect()
    log.info("Shutdown complete")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
