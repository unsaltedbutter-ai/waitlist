#!/usr/bin/env python3
"""
Shared CLI alert sender for UnsaltedButter VPS scripts.
Sends a Nostr DM to the operator with per-key cooldown to avoid spam.

Usage:
    nostr-alert.py --key <key> "message"
    nostr-alert.py --key disk-high --dry-run "VPS disk at 92%"
    nostr-alert.py --key container-lnd --cooldown 1 --force "LND is DOWN"

Reuses the update-checker venv (nostr-sdk, python-dotenv).
Loads config from ~/.unsaltedbutter/nostr.env.
State file: ~/.nostr-alert-state.json
"""

import argparse
import asyncio
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv
from nostr_sdk import Client, EventBuilder, Keys, Kind, NostrSigner, PublicKey, RelayUrl, Tag

# ---------------------------------------------------------------------------
# Cooldown defaults (hours)
# ---------------------------------------------------------------------------

COOLDOWN_HOURS: dict[str, int] = {
    "pm2-down": 1,
    "nginx-down": 1,
    "disk-high": 6,
    "memory-high": 6,
    "lnd-down": 6,
    "inbound-low": 24,
}

# Prefix match for container-* keys
COOLDOWN_PREFIX: dict[str, int] = {
    "container-": 1,
}

COOLDOWN_DEFAULT = 6

STATE_FILE = Path.home() / ".nostr-alert-state.json"
DEFAULT_RELAYS = "wss://relay.damus.io,wss://nos.lol,wss://relay.snort.social"


# ---------------------------------------------------------------------------
# Cooldown logic
# ---------------------------------------------------------------------------

def get_cooldown_hours(key: str) -> int:
    if key in COOLDOWN_HOURS:
        return COOLDOWN_HOURS[key]
    for prefix, hours in COOLDOWN_PREFIX.items():
        if key.startswith(prefix):
            return hours
    return COOLDOWN_DEFAULT


def load_state() -> dict:
    if STATE_FILE.exists():
        try:
            return json.loads(STATE_FILE.read_text())
        except (json.JSONDecodeError, OSError):
            return {}
    return {}


def save_state(state: dict) -> None:
    STATE_FILE.write_text(json.dumps(state, indent=2))


def is_within_cooldown(state: dict, key: str, cooldown_hours: int) -> bool:
    entry = state.get(key)
    if not entry:
        return False
    try:
        last_sent = datetime.fromisoformat(entry["last_sent"])
    except (KeyError, ValueError, TypeError):
        return False
    now = datetime.now(timezone.utc)
    elapsed_hours = (now - last_sent).total_seconds() / 3600
    return elapsed_hours < cooldown_hours


def record_sent(state: dict, key: str) -> None:
    state[key] = {"last_sent": datetime.now(timezone.utc).isoformat()}
    save_state(state)


# ---------------------------------------------------------------------------
# Nostr DM (NIP-04, same pattern as update-checker.py)
# ---------------------------------------------------------------------------

async def send_nostr_dm(message: str) -> None:
    nsec = os.environ["NOSTR_NSEC"]
    npub = os.environ.get(
        "OPERATOR_NPUB",
        "***REDACTED***",
    )

    keys = Keys.parse(nsec)
    signer = NostrSigner.keys(keys)
    client = Client(signer)

    relays = os.getenv("NOSTR_RELAYS", DEFAULT_RELAYS)
    for relay in relays.split(","):
        relay = relay.strip()
        if relay:
            await client.add_relay(RelayUrl.parse(relay))
    await client.connect()

    recipient = PublicKey.parse(npub)
    # Proactive outbound: use NIP-04 for client compatibility
    ciphertext = await signer.nip04_encrypt(recipient, message)
    builder = EventBuilder(Kind(4), ciphertext).tags([
        Tag.parse(["p", recipient.to_hex()])
    ])
    await client.send_event_builder(builder)

    await client.disconnect()


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

async def main() -> int:
    parser = argparse.ArgumentParser(
        description="Send a Nostr DM alert with per-key cooldown"
    )
    parser.add_argument("--key", required=True, help="Alert key (e.g. disk-high, container-lnd)")
    parser.add_argument("--dry-run", action="store_true", help="Print message, don't send")
    parser.add_argument("--force", action="store_true", help="Bypass cooldown")
    parser.add_argument("--cooldown", type=int, default=None, help="Override cooldown hours")
    parser.add_argument("message", help="Alert message text")
    args = parser.parse_args()

    env_file = Path.home() / ".unsaltedbutter" / "nostr.env"
    if env_file.exists():
        load_dotenv(env_file)

    cooldown_hours = args.cooldown if args.cooldown is not None else get_cooldown_hours(args.key)

    if args.dry_run:
        print(f"[DRY RUN] key={args.key} cooldown={cooldown_hours}h message: {args.message}")
        return 0

    state = load_state()

    if not args.force and is_within_cooldown(state, args.key, cooldown_hours):
        # Silent exit: within cooldown
        return 0

    await send_nostr_dm(f"[{args.key}] {args.message}")
    record_sent(state, args.key)
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
