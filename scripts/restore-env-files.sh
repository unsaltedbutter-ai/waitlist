#!/usr/bin/env bash
# restore-env-files.sh — Decrypt an age-encrypted env backup.
#
# Decrypts the archive and either restores to ~/.unsaltedbutter/
# or extracts to a local directory for inspection.
#
# Requires: age (brew install age)
#
# Usage:
#   ./scripts/restore-env-files.sh env-backups/env-backup-2026-03-01.age

set -euo pipefail

DEST_DIR="$HOME/.unsaltedbutter"

# 1. Check prerequisites
if ! command -v age &>/dev/null; then
    echo "ERROR: age not installed."
    echo "  Install with: brew install age"
    exit 1
fi

# 2. Validate argument
if [ $# -lt 1 ]; then
    echo "Usage: $0 <backup-file.age>"
    echo ""
    echo "Available backups:"
    SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
    PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
    ls -1 "$PROJECT_ROOT/env-backups/"*.age 2>/dev/null | while read -r f; do
        echo "  $f"
    done
    exit 1
fi

BACKUP_FILE="$1"

if [ ! -f "$BACKUP_FILE" ]; then
    echo "ERROR: File not found: $BACKUP_FILE"
    exit 1
fi

# 3. Ask where to restore
echo "Restore destination:"
echo "  1) ~/.unsaltedbutter/ (overwrites existing files)"
echo "  2) Local directory for inspection"
echo ""
read -rp "Choice [1/2]: " choice

case "$choice" in
    1)
        # Restore to ~/.unsaltedbutter/
        if [ -d "$DEST_DIR" ]; then
            echo ""
            echo "WARNING: $DEST_DIR already exists."
            echo "  Existing files will be overwritten by backup contents."
            echo "  Files not in the backup will be left untouched."
            read -rp "Continue? [y/N] " confirm
            if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
                echo "Aborted."
                exit 0
            fi
        fi

        mkdir -p "$DEST_DIR"
        echo "Decrypting and restoring to $DEST_DIR ..."
        age -d "$BACKUP_FILE" | tar x -C "$DEST_DIR"
        chmod 600 "$DEST_DIR"/*.env 2>/dev/null || true

        echo ""
        echo "Restored to $DEST_DIR:"
        ls -la "$DEST_DIR"
        ;;

    2)
        # Extract to local directory
        BASENAME="$(basename "$BACKUP_FILE" .age)"
        LOCAL_DIR="./$BASENAME"

        if [ -d "$LOCAL_DIR" ]; then
            echo "Directory $LOCAL_DIR already exists."
            read -rp "Overwrite? [y/N] " confirm
            if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
                echo "Aborted."
                exit 0
            fi
            rm -rf "$LOCAL_DIR"
        fi

        mkdir -p "$LOCAL_DIR"
        echo "Decrypting to $LOCAL_DIR ..."
        age -d "$BACKUP_FILE" | tar x -C "$LOCAL_DIR"

        echo ""
        echo "Extracted to $LOCAL_DIR:"
        ls -la "$LOCAL_DIR"
        echo ""
        echo "Inspect the files, then copy what you need to $DEST_DIR"
        ;;

    *)
        echo "Invalid choice. Aborted."
        exit 1
        ;;
esac
