#!/usr/bin/env python3
"""
Daily update checker for UnsaltedButter VPS infrastructure.
Checks BTCPay Server, LND, Next.js, Node.js, and Ubuntu packages
for available updates and sends a Nostr DM to the operator.
"""

import argparse
import asyncio
import json
import logging
import os
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

import httpx
from dotenv import load_dotenv
from nostr_sdk import Client, Keys, NostrSigner, PublicKey, RelayUrl

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

STATE_FILE = Path.home() / ".update-checker-state.json"
PACKAGE_JSON = Path.home() / "unsaltedbutter" / "web" / "package.json"
SECURITY_KEYWORDS = re.compile(
    r"security|CVE-\d{4}|vulnerability|critical|patch", re.IGNORECASE
)
RELAYS = [
    "wss://relay.damus.io",
    "wss://nos.lol",
    "wss://relay.snort.social",
]
GITHUB_API = "https://api.github.com/repos"
NPM_REGISTRY = "https://registry.npmjs.org"

log = logging.getLogger("update-checker")


# ---------------------------------------------------------------------------
# State persistence
# ---------------------------------------------------------------------------

def load_state() -> dict:
    if STATE_FILE.exists():
        return json.loads(STATE_FILE.read_text())
    return {}


def save_state(state: dict) -> None:
    STATE_FILE.write_text(json.dumps(state, indent=2))


# ---------------------------------------------------------------------------
# Current versions (local commands)
# ---------------------------------------------------------------------------

def _run(cmd: list[str], timeout: int = 15) -> str | None:
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return r.stdout.strip() if r.returncode == 0 else None
    except (subprocess.TimeoutExpired, FileNotFoundError):
        return None


def get_current_versions() -> dict[str, str | None]:
    versions: dict[str, str | None] = {}

    # BTCPay Server
    out = _run(["docker", "exec", "btcpayserver_btcpayserver_1",
                "cat", "/etc/btcpayserver_version"])
    if not out:
        # Try alternate container name format
        out = _run(["docker", "exec", "btcpayserver-btcpayserver-1",
                     "cat", "/etc/btcpayserver_version"])
    versions["btcpay"] = out

    # LND
    out = _run(["docker", "exec", "btcpayserver_lnd_1",
                "lncli", "--version"])
    if not out:
        out = _run(["docker", "exec", "btcpayserver-lnd-1",
                     "lncli", "--version"])
    if out:
        # "lncli version 0.18.4-beta commit=..." → "0.18.4-beta"
        m = re.search(r"version\s+([\d.]+(?:-\w+)?)", out)
        versions["lnd"] = m.group(1) if m else out
    else:
        versions["lnd"] = None

    # Next.js — read from package.json
    try:
        pkg = json.loads(PACKAGE_JSON.read_text())
        dep = pkg.get("dependencies", {}).get("next", "")
        versions["nextjs"] = dep.lstrip("^~")
    except (FileNotFoundError, json.JSONDecodeError):
        versions["nextjs"] = None

    # Node.js
    out = _run(["node", "--version"])
    versions["nodejs"] = out.lstrip("v") if out else None

    return versions


# ---------------------------------------------------------------------------
# Latest versions (remote APIs)
# ---------------------------------------------------------------------------

async def _github_latest(client: httpx.AsyncClient, owner_repo: str) -> tuple[str, str]:
    """Return (tag, release_body) for the latest release."""
    url = f"{GITHUB_API}/{owner_repo}/releases/latest"
    r = await client.get(url)
    r.raise_for_status()
    data = r.json()
    tag = data["tag_name"].lstrip("v")
    body = data.get("body", "")
    return tag, body


async def _npm_latest(client: httpx.AsyncClient, package: str) -> str:
    url = f"{NPM_REGISTRY}/{package}/latest"
    r = await client.get(url)
    r.raise_for_status()
    return r.json()["version"]


async def _node_latest(client: httpx.AsyncClient) -> str:
    """Get latest LTS Node.js version."""
    r = await client.get("https://nodejs.org/dist/index.json")
    r.raise_for_status()
    for entry in r.json():
        if entry.get("lts"):
            return entry["version"].lstrip("v")
    return r.json()[0]["version"].lstrip("v")


async def fetch_latest_versions() -> dict[str, dict]:
    """Return {name: {"version": str, "body": str}} for each software."""
    results = {}
    async with httpx.AsyncClient(
        timeout=20,
        headers={"Accept": "application/vnd.github+json"},
    ) as client:
        btcpay_tag, btcpay_body = await _github_latest(
            client, "btcpayserver/btcpayserver"
        )
        results["btcpay"] = {"version": btcpay_tag, "body": btcpay_body}

        lnd_tag, lnd_body = await _github_latest(
            client, "lightningnetwork/lnd"
        )
        results["lnd"] = {"version": lnd_tag, "body": lnd_body}

        nextjs_ver = await _npm_latest(client, "next")
        results["nextjs"] = {"version": nextjs_ver, "body": ""}

        node_ver = await _node_latest(client)
        results["nodejs"] = {"version": node_ver, "body": ""}

    return results


# ---------------------------------------------------------------------------
# Ubuntu upgradable packages
# ---------------------------------------------------------------------------

def get_ubuntu_upgradable() -> list[str]:
    """Return list of upgradable package lines, highlighting security."""
    _run(["sudo", "-n", "apt-get", "update", "-qq"], timeout=120)
    out = _run(["apt", "list", "--upgradable"], timeout=30)
    if not out:
        return []
    lines = [l for l in out.splitlines() if "/" in l and "Listing..." not in l]
    return lines


# ---------------------------------------------------------------------------
# Compare and classify
# ---------------------------------------------------------------------------

def _normalize_version(v: str) -> str:
    """Strip common suffixes for comparison."""
    return re.sub(r"-(beta|rc\d*|alpha).*", "", v).strip(".")


def _versions_differ(current: str | None, latest: str) -> bool:
    if current is None:
        return False  # Can't compare, skip
    return _normalize_version(current) != _normalize_version(latest)


DISPLAY_NAMES = {
    "btcpay": "BTCPay Server",
    "lnd": "LND",
    "nextjs": "Next.js",
    "nodejs": "Node.js",
}


def compare_and_classify(
    current: dict[str, str | None],
    latest: dict[str, dict],
    state: dict,
) -> tuple[list[dict], list[dict], list[str]]:
    """Return (critical, updates, up_to_date)."""
    critical, updates, up_to_date = [], [], []

    for key in ("btcpay", "lnd", "nextjs", "nodejs"):
        cur = current.get(key)
        lat = latest.get(key, {})
        lat_ver = lat.get("version", "")
        name = DISPLAY_NAMES[key]

        if not cur:
            log.warning("Could not determine current version of %s", name)
            continue

        if not _versions_differ(cur, lat_ver):
            up_to_date.append(f"{name} {cur}")
            continue

        # Already notified for this version?
        if state.get(key) == lat_ver:
            up_to_date.append(f"{name} {cur}")
            continue

        is_critical = bool(SECURITY_KEYWORDS.search(lat.get("body", "")))
        entry = {
            "name": name,
            "current": cur,
            "latest": lat_ver,
            "body_snippet": lat.get("body", "")[:200],
        }

        if is_critical:
            critical.append(entry)
        else:
            updates.append(entry)

    return critical, updates, up_to_date


# ---------------------------------------------------------------------------
# Ubuntu classification
# ---------------------------------------------------------------------------

def classify_ubuntu(lines: list[str]) -> tuple[list[str], list[str]]:
    """Split into (security, other) upgrade lines."""
    security, other = [], []
    for line in lines:
        pkg_name = line.split("/")[0]
        if "-security" in line or "security" in line.lower():
            security.append(pkg_name)
        else:
            other.append(pkg_name)
    return security, other


# ---------------------------------------------------------------------------
# Message formatting
# ---------------------------------------------------------------------------

def format_message(
    critical: list[dict],
    updates: list[dict],
    up_to_date: list[str],
    ubuntu_security: list[str],
    ubuntu_other: list[str],
) -> str | None:
    has_updates = critical or updates or ubuntu_security or ubuntu_other
    if not has_updates:
        return None

    parts = ["Software Updates Available", ""]

    if critical:
        parts.append("CRITICAL:")
        for u in critical:
            cve = ""
            m = re.search(r"CVE-\d{4}-\d+", u["body_snippet"])
            if m:
                cve = f" — {m.group()}"
            parts.append(f"  {u['name']} {u['current']} → {u['latest']}{cve}")
        parts.append("")

    if ubuntu_security:
        parts.append("UBUNTU SECURITY:")
        parts.append(f"  {len(ubuntu_security)} security packages: {', '.join(ubuntu_security[:10])}")
        if len(ubuntu_security) > 10:
            parts.append(f"  ...and {len(ubuntu_security) - 10} more")
        parts.append("")

    if updates:
        parts.append("Updates:")
        for u in updates:
            parts.append(f"  {u['name']} {u['current']} → {u['latest']}")
        parts.append("")

    if ubuntu_other:
        parts.append("Ubuntu packages:")
        parts.append(f"  {len(ubuntu_other)} packages upgradable")
        parts.append("")

    if up_to_date:
        parts.append("Up to date:")
        parts.append(f"  {', '.join(up_to_date)}")

    return "\n".join(parts)


# ---------------------------------------------------------------------------
# Nostr DM
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

    for relay in RELAYS:
        await client.add_relay(RelayUrl.parse(relay))
    await client.connect()

    recipient = PublicKey.parse(npub)
    await client.send_private_msg(recipient, message, [])
    log.info("DM sent to %s", npub)

    await client.disconnect()


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

async def main() -> None:
    parser = argparse.ArgumentParser(description="Check for software updates")
    parser.add_argument("--dry-run", action="store_true",
                        help="Print message without sending DM")
    args = parser.parse_args()

    env_file = Path.home() / ".unsaltedbutter" / "nostr.env"
    if env_file.exists():
        load_dotenv(env_file)

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )

    log.info("Checking current versions...")
    current = get_current_versions()
    for k, v in current.items():
        log.info("  %s: %s", DISPLAY_NAMES.get(k, k), v or "unknown")

    log.info("Fetching latest versions...")
    latest = await fetch_latest_versions()
    for k, v in latest.items():
        log.info("  %s: %s", DISPLAY_NAMES.get(k, k), v["version"])

    log.info("Checking Ubuntu packages...")
    ubuntu_lines = get_ubuntu_upgradable()
    ubuntu_sec, ubuntu_other = classify_ubuntu(ubuntu_lines)

    state = load_state()
    critical, updates, up_to_date = compare_and_classify(current, latest, state)

    message = format_message(critical, updates, up_to_date, ubuntu_sec, ubuntu_other)

    if message is None:
        log.info("Everything up to date. No DM sent.")
        return

    if args.dry_run:
        print("\n--- DRY RUN ---")
        print(message)
        print("--- END ---\n")
    else:
        await send_nostr_dm(message)

    # Update state with notified versions
    for entry in critical + updates:
        key = next(
            k for k, v in DISPLAY_NAMES.items() if v == entry["name"]
        )
        state[key] = entry["latest"]
    state["last_run"] = datetime.now(timezone.utc).isoformat()
    save_state(state)
    log.info("State saved to %s", STATE_FILE)


if __name__ == "__main__":
    asyncio.run(main())
