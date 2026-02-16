#!/usr/bin/env python3
"""Send a Nostr DM to the operator. Used by deploy.sh and for testing."""

import asyncio
import os
import subprocess
import sys
from pathlib import Path

from dotenv import load_dotenv
from nostr_sdk import Client, Keys, NostrSigner, PublicKey, RelayUrl

DEFAULT_RELAYS = "wss://relay.damus.io,wss://nos.lol,wss://relay.snort.social"


def get_git_hash() -> str:
    try:
        r = subprocess.run(
            ["git", "-C", str(Path(__file__).parent.parent), "rev-parse", "--short", "HEAD"],
            capture_output=True, text=True, timeout=5,
        )
        return r.stdout.strip() if r.returncode == 0 else "unknown"
    except Exception:
        return "unknown"


async def send_dm(message: str) -> None:
    env_file = Path.home() / ".unsaltedbutter" / "nostr.env"
    if env_file.exists():
        load_dotenv(env_file)

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
    await client.send_private_msg(recipient, message, [])
    await client.disconnect()
    print(f"DM sent to {npub}")


if __name__ == "__main__":
    msg = " ".join(sys.argv[1:]) if len(sys.argv) > 1 else None
    if msg is None:
        git_hash = get_git_hash()
        msg = f"Deploy complete — {git_hash}"
    asyncio.run(send_dm(msg))
