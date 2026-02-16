"""UnsaltedButter Nostr Bot — DM commands + zap topups."""

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

import commands
import db
import notifications
import zap_handler

_env_file = Path.home() / ".unsaltedbutter" / "nostr.env"
load_dotenv(_env_file if _env_file.exists() else None)

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
    ):
        self._keys = keys
        self._signer = signer
        self._client = client
        self._start_time = start_time
        self._bot_pubkey_hex = keys.public_key().to_hex()
        self._zap_provider_pubkey_hex = zap_provider_pubkey_hex

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

    # ── NIP-04 DM (kind 4) ──────────────────────────────────

    async def _handle_nip04_dm(self, event: Event):
        # Skip old events
        if event.created_at().as_secs() < self._start_time.as_secs():
            return

        sender_pk = event.author()
        sender_hex = sender_pk.to_hex()

        plaintext = nip04_decrypt(self._keys.secret_key(), sender_pk, event.content())
        log.info("NIP-04 DM from %s: %s", sender_hex[:16], plaintext[:80])

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

    # ── NIP-17 DM (kind 1059 gift wrap) ──────────────────────

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

        replies = await self._dispatch_command(sender_hex, plaintext)
        if isinstance(replies, str):
            replies = [replies]
        for reply in replies:
            await self._client.send_private_msg(sender, reply, [])

    # ── Zap receipt (kind 9735) ──────────────────────────────

    async def _handle_zap(self, event: Event):
        if event.created_at().as_secs() < self._start_time.as_secs():
            return

        async def send_dm(pubkey_hex: str, text: str):
            pk = PublicKey.parse(pubkey_hex)
            await self._client.send_private_msg(pk, text, [])

        await zap_handler.handle_zap_receipt(
            event, send_dm, self._bot_pubkey_hex, self._zap_provider_pubkey_hex,
        )

    # ── Command dispatch ─────────────────────────────────────

    async def _dispatch_command(self, sender_hex: str, message: str) -> str:
        cmd = message.strip().lower()
        user = await db.get_user_by_npub(sender_hex)

        # "login" works for anyone (proves npub ownership for both login + signup)
        if cmd == "login":
            code = await db.create_otp(sender_hex)
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
            result, invite_code = await db.add_to_waitlist(sender_hex)
            if result == "added":
                return "You're on the waitlist. We'll DM you when a spot opens."
            elif result == "already_invited":
                base_url = os.getenv("BASE_URL", "https://unsaltedbutter.ai")
                link = f"{base_url}/login?code={invite_code}"
                return f"You've already been invited:\n\n{link}"
            else:
                return "You're already on the waitlist. We'll DM you when a spot opens."

        # "invites" operator-only: trigger sending pending invite DMs
        if cmd == "invites":
            operator_npub = os.getenv("OPERATOR_NPUB", "")
            if operator_npub and sender_hex == _npub_to_hex(operator_npub):
                count = await self._send_pending_invite_dms()
                return f"Sent {count} invite DM(s)." if count > 0 else "No pending invite DMs."
            # Non-operators fall through to normal handling

        # Everything else requires registration
        if user is None:
            return "Join the waitlist"

        return await commands.handle_dm(user["id"], user["status"], message)

    # ── Invite DM sending ─────────────────────────────────────

    async def _send_pending_invite_dms(self) -> int:
        """Send invite link DMs to waitlist entries flagged invite_dm_pending."""
        pending = await db.get_pending_invite_dms()
        base_url = os.getenv("BASE_URL", "https://unsaltedbutter.ai")
        count = 0

        for entry in pending:
            link = f"{base_url}/login?code={entry['invite_code']}"
            text = f"You're in. Here's your invite link:\n\n{link}"
            try:
                pk = PublicKey.parse(entry["nostr_npub"])
                # Use NIP-04 (kind 4) for broad client compatibility
                ciphertext = await self._signer.nip04_encrypt(pk, text)
                builder = EventBuilder(Kind(4), ciphertext).tags([
                    Tag.parse(["p", pk.to_hex()])
                ])
                await self._client.send_event_builder(builder)
                await db.mark_invite_dm_sent(entry["id"])
                count += 1
                log.info("Sent invite DM to %s", entry["nostr_npub"][:16])
            except Exception as e:
                log.error("Failed to send invite DM to %s: %s", entry["nostr_npub"][:16], e)

        return count


async def _notification_loop(client, signer, shutdown_event, handler):
    """Check for users needing notifications every 6 hours."""
    # Wait 60 seconds after startup before first check
    try:
        await asyncio.wait_for(shutdown_event.wait(), timeout=60)
        return  # Shutdown requested during initial wait
    except asyncio.TimeoutError:
        pass  # Expected, continue to first check

    while not shutdown_event.is_set():
        try:
            await notifications.check_and_send_notifications(client, signer)
        except Exception as e:
            log.error("[notifications] Error: %s", e)

        # Backup: send any pending invite DMs (in case operator forgot to DM "invites")
        try:
            count = await handler._send_pending_invite_dms()
            if count > 0:
                log.info("[notifications] Backup invite DM check sent %d DM(s)", count)
        except Exception as e:
            log.error("[notifications] Invite DM backup check error: %s", e)

        try:
            await asyncio.wait_for(shutdown_event.wait(), timeout=6 * 3600)
            return  # Shutdown requested
        except asyncio.TimeoutError:
            pass  # Expected, time for next check


async def main():
    # Logging
    level = os.getenv("LOG_LEVEL", "INFO").upper()
    logging.basicConfig(
        level=getattr(logging, level, logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    # Database
    await db.init_pool()

    # Nostr keys
    nsec = os.environ["NOSTR_NSEC"]
    keys = Keys.parse(nsec)
    signer = NostrSigner.keys(keys)
    bot_pk = keys.public_key()
    log.info("Bot pubkey: %s", bot_pk.to_bech32())

    # Zap provider pubkey — required for validating zap receipts (NIP-57).
    # This is the nostr pubkey your Lightning provider (e.g. Alby) uses to
    # sign kind 9735 events. Get it from your LUD-16 LNURL metadata endpoint.
    zap_provider_pubkey_hex = os.environ["ZAP_PROVIDER_PUBKEY"]
    log.info("Zap provider pubkey: %s...", zap_provider_pubkey_hex[:16])

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
        "about": os.getenv("BOT_ABOUT", "DM me to manage your streaming rotation. Zap me to add credits."),
    }
    bot_lud16 = os.getenv("BOT_LUD16", "")
    if bot_lud16:
        meta_dict["lud16"] = bot_lud16
    metadata = Metadata.from_json(json.dumps(meta_dict))
    await client.set_metadata(metadata)
    log.info("Published kind 0 profile")

    # Subscribe — since=now so we don't reprocess old events.
    # Gift wraps (kind 1059) have randomized outer timestamps, so the handler
    # also checks rumor.created_at() as a fallback.
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

    # Run notification handler in a task
    handler = BotNotificationHandler(keys, signer, client, start_time, zap_provider_pubkey_hex)
    notify_task = asyncio.create_task(client.handle_notifications(handler))

    # Run proactive notification scheduler (includes backup invite DM check)
    notif_loop_task = asyncio.create_task(_notification_loop(client, signer, shutdown_event, handler))

    log.info("Bot running. Waiting for events...")

    # Wait for shutdown signal
    await shutdown_event.wait()

    # Clean shutdown
    log.info("Shutting down...")
    notify_task.cancel()
    notif_loop_task.cancel()
    for task in (notify_task, notif_loop_task):
        try:
            await task
        except asyncio.CancelledError:
            pass

    await client.disconnect()
    await db.close_pool()
    log.info("Shutdown complete")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
