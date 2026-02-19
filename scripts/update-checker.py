#!/usr/bin/env python3
"""
Daily update checker for UnsaltedButter VPS infrastructure.
Checks BTCPay Server, LND, Next.js, Node.js, nostr-tools, nostr-sdk,
and Ubuntu packages for available updates and sends a Nostr DM to the operator.
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
from nostr_sdk import Client, EventBuilder, Keys, Kind, NostrSigner, PublicKey, RelayUrl, Tag

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

STATE_FILE = Path.home() / ".update-checker-state.json"
PACKAGE_JSON = Path.home() / "unsaltedbutter" / "web" / "package.json"
SECURITY_KEYWORDS = re.compile(
    r"security|CVE-\d{4}|vulnerability|critical|patch", re.IGNORECASE
)
DEFAULT_RELAYS = "wss://relay.damus.io,wss://nos.lol,wss://relay.snort.social"
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
        if r.returncode == 0:
            return r.stdout.strip()
        log.debug("Command %s failed (rc=%d): %s", cmd[:3], r.returncode, r.stderr.strip()[:200])
        return None
    except (subprocess.TimeoutExpired, FileNotFoundError):
        return None


def _find_container(pattern: str) -> str | None:
    """Find a running Docker container by grep pattern (same approach as bash scripts)."""
    out = _run(["sudo", "docker", "ps", "--format", "{{.Names}}"])
    if not out:
        return None
    for name in out.splitlines():
        if re.search(pattern, name):
            return name
    return None


def get_current_versions() -> dict[str, str | None]:
    versions: dict[str, str | None] = {}

    # BTCPay Server (discover container dynamically, try multiple version sources)
    btcpay = _find_container(r"btcpayserver_\d*$|btcpayserver-\d*$|^generated_btcpayserver")
    if btcpay:
        # Try version file first
        out = _run(["sudo", "docker", "exec", btcpay, "cat", "/etc/btcpayserver_version"])
        if not out:
            # Fallback: image tag (e.g., "btcpayserver/btcpayserver:1.13.5" -> "1.13.5")
            out = _run(["sudo", "docker", "inspect", btcpay, "--format", "{{.Config.Image}}"])
            if out and ":" in out:
                out = out.split(":")[-1].lstrip("v")
            else:
                out = None
        if not out:
            # Fallback: BTCPAY_VERSION env var inside container
            out = _run(["sudo", "docker", "exec", btcpay, "printenv", "BTCPAY_VERSION"])
        versions["btcpay"] = out
    else:
        versions["btcpay"] = None

    # LND (discover container dynamically)
    lnd = _find_container(r"lnd_bitcoin$|_lnd_bitcoin$")
    if lnd:
        out = _run(["sudo", "docker", "exec", lnd, "lncli", "--version"])
        if out:
            # "lncli version 0.18.4-beta commit=..." -> "0.18.4-beta"
            m = re.search(r"version\s+([\d.]+(?:-\w+)?)", out)
            versions["lnd"] = m.group(1) if m else out
        else:
            versions["lnd"] = None
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

    # nostr-tools (npm package used by web app)
    try:
        pkg = json.loads(PACKAGE_JSON.read_text())
        dep = pkg.get("dependencies", {}).get("nostr-tools", "")
        versions["nostr_tools"] = dep.lstrip("^~") if dep else None
    except (FileNotFoundError, json.JSONDecodeError):
        versions["nostr_tools"] = None

    # nostr-sdk (Python package used by update-checker venv, orchestrator, nostr-bot)
    out = _run([sys.executable, "-m", "pip", "show", "nostr-sdk"])
    if out:
        m = re.search(r"^Version:\s*(.+)$", out, re.MULTILINE)
        versions["nostr_sdk"] = m.group(1).strip() if m else None
    else:
        versions["nostr_sdk"] = None

    return versions


# ---------------------------------------------------------------------------
# Latest versions (remote APIs)
# ---------------------------------------------------------------------------

async def _github_latest(client: httpx.AsyncClient, owner_repo: str) -> tuple[str, str, str]:
    """Return (tag, release_body, html_url) for the latest release."""
    url = f"{GITHUB_API}/{owner_repo}/releases/latest"
    r = await client.get(url)
    r.raise_for_status()
    data = r.json()
    tag = data["tag_name"].lstrip("v")
    body = data.get("body", "")
    html_url = data.get("html_url", f"https://github.com/{owner_repo}/releases")
    return tag, body, html_url


async def _npm_latest(client: httpx.AsyncClient, package: str) -> str:
    url = f"{NPM_REGISTRY}/{package}/latest"
    r = await client.get(url, headers={"Accept": "application/json"})
    r.raise_for_status()
    return r.json()["version"]


async def _node_latest_in_line(client: httpx.AsyncClient, current_major: int | None) -> str:
    """Get latest Node.js version within the same LTS major line.

    If current_major is known (e.g., 22), return the latest 22.x release.
    If unknown, return the latest LTS of any line.
    """
    r = await client.get("https://nodejs.org/dist/index.json", headers={"Accept": "application/json"})
    r.raise_for_status()
    for entry in r.json():
        ver = entry["version"].lstrip("v")
        major = int(ver.split(".")[0])
        if current_major is not None:
            if major == current_major:
                return ver
        elif entry.get("lts"):
            return ver
    return r.json()[0]["version"].lstrip("v")


async def fetch_latest_versions(current_node_major: int | None = None) -> dict[str, dict]:
    """Return {name: {"version": str, "body": str, "url": str}} for each software."""
    results = {}
    async with httpx.AsyncClient(
        timeout=20,
        headers={"Accept": "application/vnd.github+json"},
    ) as client:
        try:
            btcpay_tag, btcpay_body, btcpay_url = await _github_latest(
                client, "btcpayserver/btcpayserver"
            )
            results["btcpay"] = {"version": btcpay_tag, "body": btcpay_body, "url": btcpay_url}
        except Exception as exc:
            log.error("Failed to fetch BTCPay latest version: %s", exc)

        try:
            lnd_tag, lnd_body, lnd_url = await _github_latest(
                client, "lightningnetwork/lnd"
            )
            results["lnd"] = {"version": lnd_tag, "body": lnd_body, "url": lnd_url}
        except Exception as exc:
            log.error("Failed to fetch LND latest version: %s", exc)

        try:
            nextjs_ver = await _npm_latest(client, "next")
            results["nextjs"] = {"version": nextjs_ver, "body": "", "url": "https://github.com/vercel/next.js/releases"}
        except Exception as exc:
            log.error("Failed to fetch Next.js latest version: %s", exc)

        try:
            node_ver = await _node_latest_in_line(client, current_node_major)
            results["nodejs"] = {"version": node_ver, "body": "", "url": "https://nodejs.org/en/blog/release"}
        except Exception as exc:
            log.error("Failed to fetch Node.js latest version: %s", exc)

        try:
            nostr_tools_ver = await _npm_latest(client, "nostr-tools")
            results["nostr_tools"] = {"version": nostr_tools_ver, "body": "", "url": "https://github.com/nbd-wtf/nostr-tools/releases"}
        except Exception as exc:
            log.error("Failed to fetch nostr-tools latest version: %s", exc)

        try:
            r = await client.get("https://pypi.org/pypi/nostr-sdk/json", headers={"Accept": "application/json"})
            r.raise_for_status()
            nostr_sdk_ver = r.json()["info"]["version"]
            results["nostr_sdk"] = {"version": nostr_sdk_ver, "body": "", "url": "https://pypi.org/project/nostr-sdk/#history"}
        except Exception as exc:
            log.error("Failed to fetch nostr-sdk latest version: %s", exc)

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
    "nostr_tools": "nostr-tools",
    "nostr_sdk": "nostr-sdk",
}

# How to update each component (one-line action)
UPDATE_ACTIONS = {
    "btcpay": "cd ~/btcpayserver-docker && sudo su -c '. btcpay-setup.sh' (restarts Docker stack)",
    "lnd": "Updated via BTCPay Docker stack (see BTCPay update procedure)",
    "nextjs": "Bump version in package.json, test locally, deploy with deploy.sh",
    "nodejs": "Install new version on VPS, then deploy.sh (PM2 restart)",
    "nostr_tools": "Bump in web/package.json, test locally, deploy with deploy.sh",
    "nostr_sdk": "Update pinned version in requirements.txt files, test, redeploy bots",
}


def _is_major_bump(current: str, latest: str) -> bool:
    """Check if the update crosses a major version boundary."""
    try:
        cur_major = int(current.split(".")[0])
        lat_major = int(latest.split(".")[0])
        return lat_major > cur_major
    except (ValueError, IndexError):
        return False


def _is_minor_bump(current: str, latest: str) -> bool:
    """Check if the update is a minor version bump (not just patch)."""
    try:
        cur_parts = [int(x) for x in _normalize_version(current).split(".")[:2]]
        lat_parts = [int(x) for x in _normalize_version(latest).split(".")[:2]]
        return lat_parts[0] == cur_parts[0] and lat_parts[1] > cur_parts[1]
    except (ValueError, IndexError):
        return False


def compare_and_classify(
    current: dict[str, str | None],
    latest: dict[str, dict],
    state: dict,
) -> tuple[list[dict], list[dict], list[str]]:
    """Return (critical, updates, up_to_date)."""
    critical, updates, up_to_date = [], [], []

    for key in ("btcpay", "lnd", "nextjs", "nodejs", "nostr_tools", "nostr_sdk"):
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
            "key": key,
            "current": cur,
            "latest": lat_ver,
            "body_snippet": lat.get("body", "")[:200],
            "url": lat.get("url", ""),
            "action": UPDATE_ACTIONS.get(key, ""),
            "is_major": _is_major_bump(cur, lat_ver),
            "is_minor": _is_minor_bump(cur, lat_ver),
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

def _format_update_entry(u: dict, severity: str) -> list[str]:
    """Format a single update entry with severity, version, URL, and action."""
    lines = []
    bump = ""
    if u.get("is_major"):
        bump = " [MAJOR version]"
    elif u.get("is_minor"):
        bump = " [minor version]"

    cve = ""
    if severity == "CRITICAL":
        m = re.search(r"CVE-\d{4}-\d+", u.get("body_snippet", ""))
        if m:
            cve = f" ({m.group()})"

    lines.append(f"  [{severity}] {u['name']} {u['current']} -> {u['latest']}{bump}{cve}")
    if u.get("url"):
        lines.append(f"    Release notes: {u['url']}")
    if u.get("action"):
        lines.append(f"    How to update: {u['action']}")
    return lines


def format_message(
    critical: list[dict],
    updates: list[dict],
    up_to_date: list[str],
    ubuntu_security: list[str],
    ubuntu_other: list[str],
) -> str | None:
    # Non-security Ubuntu packages alone don't justify a DM (too noisy).
    # They piggyback when there are real updates to report.
    has_updates = critical or updates or ubuntu_security
    if not has_updates:
        return None

    parts = ["VPS Update Report", ""]

    if critical:
        parts.append("=== ACTION REQUIRED (security) ===")
        for u in critical:
            parts.extend(_format_update_entry(u, "CRITICAL"))
        parts.append("")

    if ubuntu_security:
        parts.append("=== UBUNTU SECURITY ===")
        parts.append(f"  {len(ubuntu_security)} packages: {', '.join(ubuntu_security[:10])}")
        if len(ubuntu_security) > 10:
            parts.append(f"  ...and {len(ubuntu_security) - 10} more")
        parts.append("  How to update: sudo apt upgrade (may require reboot for kernel)")
        parts.append("")

    if updates:
        parts.append("=== Available Updates ===")
        for u in updates:
            severity = "routine"
            if u.get("is_major"):
                severity = "info"
            parts.extend(_format_update_entry(u, severity))
            if u.get("is_major"):
                parts.append("    Note: Major version bump. Test before upgrading. Check LTS EOL dates.")
        parts.append("")

    if ubuntu_other:
        parts.append(f"Ubuntu: {len(ubuntu_other)} non-security packages upgradable")
        parts.append("")

    if up_to_date:
        parts.append(f"Up to date: {', '.join(up_to_date)}")

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
    log.info("DM sent to %s", npub)

    # Give relays time to receive the event before disconnecting
    await asyncio.sleep(2)
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

    # Parse current Node.js major for same-line LTS comparison
    node_cur = current.get("nodejs")
    node_major = int(node_cur.split(".")[0]) if node_cur else None

    log.info("Fetching latest versions...")
    latest = await fetch_latest_versions(current_node_major=node_major)
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
        return

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
