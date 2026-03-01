#!/usr/bin/env bash
# backup-env-files.sh — Encrypt and commit ~/.unsaltedbutter env files.
#
# Creates a passphrase-encrypted age archive in ./env-backups/ and
# commits it to git. The "debug" subdirectory is excluded.
#
# Requires: age (brew install age)
#
# Usage:
#   ./scripts/backup-env-files.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BACKUP_DIR="$PROJECT_ROOT/env-backups"
SOURCE_DIR="$HOME/.unsaltedbutter"
DATE="$(date +%Y-%m-%d)"
BACKUP_FILE="env-backup-${DATE}.age"
BACKUP_PATH="$BACKUP_DIR/$BACKUP_FILE"

# 1. Check prerequisites
if ! command -v age &>/dev/null; then
    echo "ERROR: age not installed."
    echo "  Install with: brew install age"
    exit 1
fi

if [ ! -d "$SOURCE_DIR" ]; then
    echo "ERROR: $SOURCE_DIR does not exist."
    exit 1
fi

# 2. Create backup dir
mkdir -p "$BACKUP_DIR"

# 3. Check for existing backup with today's date
if [ -f "$BACKUP_PATH" ]; then
    echo "Backup already exists: $BACKUP_PATH"
    read -rp "Overwrite? [y/N] " answer
    if [[ ! "$answer" =~ ^[Yy]$ ]]; then
        echo "Aborted."
        exit 0
    fi
fi

# 4. Create encrypted backup (exclude debug/)
echo "Encrypting $SOURCE_DIR (excluding debug/) ..."
tar c -C "$SOURCE_DIR" --exclude='debug' . | age -p > "$BACKUP_PATH"

echo "Created: $BACKUP_PATH ($(wc -c < "$BACKUP_PATH" | tr -d ' ') bytes)"

# 5. Git add and commit
cd "$PROJECT_ROOT"
git add "$BACKUP_PATH"
git commit -m "Backup env files ($DATE)"

echo ""
echo "Done. Committed $BACKUP_FILE to git."
echo "Remember to push when ready: git push"
