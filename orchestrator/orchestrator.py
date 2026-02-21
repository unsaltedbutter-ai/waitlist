"""UnsaltedButter Orchestrator: main entry point.

Wires all modules together, starts the Nostr client, agent callback
server, timer loop, and background maintenance tasks. Handles
graceful shutdown on SIGINT/SIGTERM.
"""

from __future__ import annotations

import asyncio
import json
import logging
import signal
import subprocess
import sys
import time

from nostr_sdk import (
    Client,
    Filter,
    Keys,
    Kind,
    KindStandard,
    Metadata,
    NostrSigner,
    RelayUrl,
    Timestamp,
)

from agent_client import AgentClient
from agent_server import AgentCallbackServer
from api_client import ApiClient
from commands import CommandRouter
from config import Config
from db import Database
from job_manager import JobManager
from nostr_handler import NostrHandler
from notifications import NotificationHandler
from session import Session
from timers import TimerQueue

log = logging.getLogger(__name__)

try:
    GIT_HASH = subprocess.run(
        ["git", "rev-parse", "--short", "HEAD"],
        capture_output=True,
        text=True,
        timeout=5,
    ).stdout.strip() or "unknown"
except Exception:
    GIT_HASH = "unknown"


async def _invite_check_loop(
    notifications: NotificationHandler,
    shutdown: asyncio.Event,
    interval_seconds: int = 6 * 3600,
) -> None:
    """Periodically check for pending invite DMs (backup for missed pushes)."""
    # Wait 60s after startup before first check
    try:
        await asyncio.wait_for(shutdown.wait(), timeout=60)
        return
    except asyncio.TimeoutError:
        pass

    while not shutdown.is_set():
        try:
            count = await notifications.send_pending_invite_dms()
            if count > 0:
                log.info("[invite_check] Sent %d invite DM(s)", count)
        except Exception:
            log.exception("[invite_check] Error")

        try:
            await asyncio.wait_for(shutdown.wait(), timeout=interval_seconds)
            return
        except asyncio.TimeoutError:
            pass


async def _heartbeat_loop(
    api: ApiClient,
    shutdown: asyncio.Event,
    interval_seconds: int = 300,
    *,
    version: str = "unknown",
    start_monotonic: float = 0.0,
) -> None:
    """Send VPS heartbeats periodically."""
    while not shutdown.is_set():
        try:
            uptime_s = int(time.monotonic() - start_monotonic)
            await api.heartbeat(
                payload={"version": version, "uptime_s": uptime_s}
            )
        except Exception:
            log.exception("[heartbeat] VPS heartbeat failed")

        try:
            await asyncio.wait_for(shutdown.wait(), timeout=interval_seconds)
            return
        except asyncio.TimeoutError:
            pass


async def _cleanup_loop(
    db: Database,
    shutdown: asyncio.Event,
    interval_seconds: int = 3600,
) -> None:
    """Periodically clean up terminal jobs and old messages."""
    # Wait 5 min after startup
    try:
        await asyncio.wait_for(shutdown.wait(), timeout=300)
        return
    except asyncio.TimeoutError:
        pass

    while not shutdown.is_set():
        try:
            deleted = await db.delete_terminal_jobs()
            if deleted > 0:
                log.info("[cleanup] Deleted %d terminal job(s)", deleted)
            purged = await db.purge_old_messages()
            if purged > 0:
                log.info("[cleanup] Purged %d old message(s)", purged)
            fired = await db.delete_fired_timers()
            if fired > 0:
                log.info("[cleanup] Deleted %d fired timer(s)", fired)
        except Exception:
            log.exception("[cleanup] Error")

        try:
            await asyncio.wait_for(shutdown.wait(), timeout=interval_seconds)
            return
        except asyncio.TimeoutError:
            pass


async def run(config: Config) -> None:
    """Start all services and run until shutdown signal."""
    start_monotonic = time.monotonic()

    # -- Database --
    db = Database(config.db_path)
    await db.connect()

    # -- API client --
    api = ApiClient(config.api_base_url, config.hmac_secret)
    await api.start()

    # -- Agent client --
    agent_client = AgentClient(config.agent_url)
    await agent_client.start()

    # -- Timer queue --
    timers = TimerQueue(db, tick_seconds=config.timer_tick_seconds)

    # -- Nostr keys + client --
    keys = Keys.parse(config.nostr_nsec)
    signer = NostrSigner.keys(keys)
    client = Client(signer)

    for relay in config.nostr_relays:
        await client.add_relay(RelayUrl.parse(relay))
    await client.connect()
    log.info("Connected to %d relay(s)", len(config.nostr_relays))

    # -- Publish kind 0 profile metadata --
    meta_dict: dict = {
        "name": config.bot_name,
        "about": config.bot_about,
    }
    if config.bot_lud16:
        meta_dict["lud16"] = config.bot_lud16
    metadata = Metadata.from_json(json.dumps(meta_dict))
    await client.set_metadata(metadata)
    log.info("Published kind 0 profile")

    # -- Build the module graph --
    # NostrHandler provides send_dm/send_operator_dm to all other modules.
    # Construct it first (without commands/notifications), grab send_dm,
    # then wire commands/notifications back in after they are created.
    start_time = Timestamp.now()

    nostr_handler = NostrHandler(
        keys=keys,
        signer=signer,
        client=client,
        start_time=start_time,
        config=config,
        db=db,
        api_client=api,
    )

    send_dm = nostr_handler.send_dm
    send_operator_dm = nostr_handler.send_operator_dm

    # -- Session --
    session = Session(
        db=db,
        api=api,
        agent=agent_client,
        timers=timers,
        config=config,
        send_dm=send_dm,
        send_operator_dm=send_operator_dm,
    )

    # -- Job manager --
    job_manager = JobManager(
        db=db,
        api=api,
        session=session,
        timers=timers,
        config=config,
        send_dm=send_dm,
    )

    # -- Command router --
    commands = CommandRouter(
        api=api,
        session=session,
        job_manager=job_manager,
        config=config,
        send_dm=send_dm,
    )

    # -- Notification handler --
    notifications = NotificationHandler(
        session=session,
        job_manager=job_manager,
        api=api,
        config=config,
        send_dm=send_dm,
        send_operator_dm=send_operator_dm,
    )

    # -- Wire remaining refs into NostrHandler --
    nostr_handler.wire(commands=commands, notifications=notifications)

    # -- Wire timer callbacks --
    timers.set_callback(job_manager.handle_timer)

    # -- Agent callback server --
    callback_server = AgentCallbackServer(
        host=config.callback_host, port=config.callback_port
    )
    callback_server.set_otp_callback(session.handle_otp_needed)

    async def _result_callback(
        job_id: str,
        success: bool,
        access_end_date: str | None,
        error: str | None,
        duration_seconds: int,
    ) -> None:
        await session.handle_result(
            job_id, success, access_end_date, error, duration_seconds
        )
        await job_manager.on_job_complete(job_id)

    callback_server.set_result_callback(_result_callback)
    await callback_server.start()

    # -- Subscribe to Nostr events --
    # Two filters: kind 4 + 9735 use .since() to skip old events.
    # Kind 1059 (gift wrap) uses .limit(0) because NIP-17 randomizes
    # created_at up to 2 days in the past, so .since(now) drops them.
    bot_pk = keys.public_key()
    f_legacy = (
        Filter()
        .pubkey(bot_pk)
        .kinds([Kind(4), Kind.from_std(KindStandard.ZAP_RECEIPT)])
        .since(start_time)
    )
    f_giftwrap = (
        Filter()
        .pubkey(bot_pk)
        .kind(Kind.from_std(KindStandard.GIFT_WRAP))
        .limit(0)
    )
    await client.subscribe(f_legacy)
    await client.subscribe(f_giftwrap)
    log.info("Subscribed to kind 4, 1059, 9735")

    # -- Shutdown signal handling --
    shutdown = asyncio.Event()
    loop = asyncio.get_running_loop()

    def _signal_handler() -> None:
        log.info("Shutdown signal received")
        shutdown.set()

    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, _signal_handler)

    # -- Start background tasks --
    await timers.start()
    tasks = [
        asyncio.create_task(
            client.handle_notifications(nostr_handler),
            name="nostr_notifications",
        ),
        asyncio.create_task(
            _invite_check_loop(notifications, shutdown),
            name="invite_check",
        ),
        asyncio.create_task(
            _heartbeat_loop(
                api,
                shutdown,
                version=GIT_HASH,
                start_monotonic=start_monotonic,
            ),
            name="heartbeat",
        ),
        asyncio.create_task(
            _cleanup_loop(db, shutdown),
            name="cleanup",
        ),
    ]

    log.info(
        "Orchestrator %s running (pubkey: %s)", GIT_HASH, bot_pk.to_bech32()
    )
    from nostr_sdk import PublicKey as _PK
    vps_bot_npub = _PK.parse(config.vps_bot_pubkey).to_bech32()
    log.info("Expecting VPS push DMs from: %s", vps_bot_npub)
    log.info("Relays: %s", ", ".join(config.nostr_relays))

    # -- Wait for shutdown --
    await shutdown.wait()
    log.info("Shutting down...")

    # -- Graceful shutdown --
    for t in tasks:
        t.cancel()
    for t in tasks:
        try:
            await t
        except asyncio.CancelledError:
            pass

    await timers.stop()
    await callback_server.stop()
    await agent_client.close()
    await api.close()
    await client.disconnect()
    await db.close()
    log.info("Shutdown complete")


def main() -> None:
    """Load config, configure logging, run the orchestrator."""
    config = Config.load()

    logging.basicConfig(
        level=getattr(logging, config.log_level, logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    try:
        asyncio.run(run(config))
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
