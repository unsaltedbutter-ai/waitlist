#!/usr/bin/env python3
"""One-time migration: split env files into shared.env + component-specific files.

Reads existing env files from ~/.unsaltedbutter/ and agent/.env, classifies
each variable as shared vs component-specific, and writes the new split files.

Backs up originals to ~/.unsaltedbutter/backup/ before writing.

Usage:
    python3 scripts/migrate-env.py [--dry-run]
"""

import argparse
import shutil
import sys
from datetime import datetime
from pathlib import Path

# Variables that belong in shared.env (used by multiple components on the same machine)
SHARED_VARS = {
    "NOSTR_NSEC",
    "NOSTR_RELAYS",
    "OPERATOR_NPUB",
    "VPS_BOT_PUBKEY",
    "ZAP_PROVIDER_PUBKEY",
    "API_BASE_URL",
    "AGENT_HMAC_SECRET",
    "BASE_URL",
    "BOT_NAME",
    "BOT_ABOUT",
    "BOT_LUD16",
    "LOG_LEVEL",
    "OTP_TIMEOUT_SECONDS",
}

UB_DIR = Path.home() / ".unsaltedbutter"

# Source files to read (path, new component filename)
SOURCES = [
    (UB_DIR / "orchestrator.env", "orchestrator.env"),
    (UB_DIR / "nostr.env", "nostr-bot.env"),
    # agent/.env is relative to the repo root
]


def parse_env_file(path: Path) -> list[tuple[str, str, str]]:
    """Parse a dotenv file into (key, value, raw_line) tuples.

    Comments and blank lines are returned with key="" so we can
    preserve structure in the output.
    """
    entries = []
    if not path.exists():
        return entries

    for line in path.read_text().splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            entries.append(("", "", line))
            continue
        if "=" in line:
            key, _, value = line.partition("=")
            entries.append((key.strip(), value.strip(), line))
        else:
            entries.append(("", "", line))
    return entries


def classify(entries: list[tuple[str, str, str]]) -> tuple[dict[str, str], dict[str, str]]:
    """Split entries into shared and component-specific dicts."""
    shared = {}
    component = {}
    for key, value, _ in entries:
        if not key:
            continue
        if key in SHARED_VARS:
            shared[key] = value
        else:
            component[key] = value
    return shared, component


def write_env(path: Path, variables: dict[str, str], header: str, dry_run: bool) -> None:
    """Write a dict of variables to a dotenv file."""
    lines = [header, ""]
    for key, value in variables.items():
        lines.append(f"{key}={value}")
    content = "\n".join(lines) + "\n"

    if dry_run:
        print(f"  [DRY RUN] Would write {path} ({len(variables)} variables)")
        return

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content)
    print(f"  Wrote {path} ({len(variables)} variables)")


def backup(path: Path, backup_dir: Path, dry_run: bool) -> None:
    """Copy a file to the backup directory with a timestamp suffix."""
    if not path.exists():
        return
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    dest = backup_dir / f"{path.name}.{timestamp}"
    if dry_run:
        print(f"  [DRY RUN] Would backup {path} -> {dest}")
        return
    backup_dir.mkdir(parents=True, exist_ok=True)
    shutil.copy2(path, dest)
    print(f"  Backed up {path.name} -> {dest}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Migrate env files to shared + component split")
    parser.add_argument("--dry-run", action="store_true", help="Show what would happen without writing files")
    args = parser.parse_args()

    # Find the repo root (scripts/ is one level below)
    repo_root = Path(__file__).resolve().parent.parent
    agent_env = repo_root / "agent" / ".env"

    backup_dir = UB_DIR / "backup"
    all_shared: dict[str, str] = {}
    component_files: dict[str, dict[str, str]] = {}

    print("Reading existing env files...")
    print()

    # Process ~/.unsaltedbutter/orchestrator.env
    orch_path = UB_DIR / "orchestrator.env"
    if orch_path.exists():
        entries = parse_env_file(orch_path)
        shared, comp = classify(entries)
        all_shared.update(shared)
        component_files["orchestrator.env"] = comp
        print(f"  {orch_path}: {len(shared)} shared, {len(comp)} component-specific")
    else:
        print(f"  {orch_path}: not found (skipping)")

    # Process ~/.unsaltedbutter/nostr.env
    nostr_path = UB_DIR / "nostr.env"
    if nostr_path.exists():
        entries = parse_env_file(nostr_path)
        shared, comp = classify(entries)
        all_shared.update(shared)
        component_files["nostr-bot.env"] = comp
        print(f"  {nostr_path}: {len(shared)} shared, {len(comp)} component-specific")
    else:
        print(f"  {nostr_path}: not found (skipping)")

    # Process agent/.env
    if agent_env.exists():
        entries = parse_env_file(agent_env)
        shared, comp = classify(entries)
        all_shared.update(shared)
        component_files["agent.env"] = comp
        print(f"  {agent_env}: {len(shared)} shared, {len(comp)} component-specific")
    else:
        print(f"  {agent_env}: not found (skipping)")

    if not all_shared and not component_files:
        print("\nNo env files found. Nothing to migrate.")
        sys.exit(0)

    print()
    print("Backing up originals...")
    for path in [orch_path, nostr_path, agent_env]:
        backup(path, backup_dir, args.dry_run)

    print()
    print("Writing new files...")

    # Write shared.env
    if all_shared:
        write_env(
            UB_DIR / "shared.env",
            all_shared,
            "# Shared environment variables (loaded by orchestrator, nostr-bot, agent)",
            args.dry_run,
        )

    # Write component files
    for filename, variables in component_files.items():
        write_env(
            UB_DIR / filename,
            variables,
            f"# Component-specific variables for {filename.replace('.env', '')}",
            args.dry_run,
        )

    # Rename nostr.env -> nostr-bot.env (the old file stays as backup)
    if nostr_path.exists() and not args.dry_run:
        nostr_path.unlink()
        print(f"  Removed old {nostr_path.name} (backed up, replaced by nostr-bot.env)")

    # Remove agent/.env if it existed (secrets now in ~/.unsaltedbutter/)
    if agent_env.exists() and not args.dry_run:
        agent_env.unlink()
        print(f"  Removed old {agent_env} (backed up, replaced by ~/.unsaltedbutter/agent.env)")

    print()
    print("Summary:")
    print(f"  shared.env: {len(all_shared)} variables")
    for filename, variables in component_files.items():
        print(f"  {filename}: {len(variables)} variables")
    print(f"  Backups: {backup_dir}/")
    print()
    if args.dry_run:
        print("Dry run complete. Re-run without --dry-run to apply changes.")
    else:
        print("Migration complete.")


if __name__ == "__main__":
    main()
