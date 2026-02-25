#!/bin/bash
# Sync local backups to Hetzner Storage Box (offsite, separate failure domain).
# Cron: 0 4 * * * /home/butter/unsaltedbutter/scripts/backup-offsite.sh
#
# SCB is synced first (most critical: funds are unrecoverable without it).
# Each rsync runs independently so a failure in one doesn't block the other.
# No --delete on SCB to avoid replicating accidental local deletions.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ALERT="$HOME/venvs/update-checker/bin/python $SCRIPT_DIR/nostr-alert.py"

# Load backup config
BACKUP_ENV="$HOME/.unsaltedbutter/backup.env"
[ -f "$BACKUP_ENV" ] && set -a && . "$BACKUP_ENV" && set +a

SB_USER="${OFFSITE_SB_USER:?Set OFFSITE_SB_USER in ~/.unsaltedbutter/backup.env}"
SB_HOST="${OFFSITE_SB_HOST:?Set OFFSITE_SB_HOST in ~/.unsaltedbutter/backup.env}"
SB_PORT="${OFFSITE_SB_PORT:-23}"
SB_KEY="$HOME/.ssh/storagebox_ed25519"
LOG="$HOME/logs/offsite-backup.log"

mkdir -p "$HOME/logs"

{
    echo "=== Offsite backup started: $(date -u) ==="

    FAILED=0

    # SCB first (most critical: unrecoverable funds without it)
    if rsync -az \
        -e "ssh -p $SB_PORT -i $SB_KEY -o BatchMode=yes" \
        "$HOME/scb-backups/" \
        "${SB_USER}@${SB_HOST}:backups/scb/"; then
        echo "SCB backups synced"
    else
        echo "WARNING: SCB offsite sync failed"
        $ALERT --key offsite-scb-fail "Offsite SCB backup sync failed" 2>/dev/null || true
        FAILED=1
    fi

    # Daily backups (PG dumps, nginx config)
    if rsync -az --delete \
        -e "ssh -p $SB_PORT -i $SB_KEY -o BatchMode=yes" \
        "$HOME/backups/" \
        "${SB_USER}@${SB_HOST}:backups/daily/"; then
        echo "Daily backups synced"
    else
        echo "WARNING: Daily offsite sync failed"
        $ALERT --key offsite-daily-fail "Offsite daily backup sync failed" 2>/dev/null || true
        FAILED=1
    fi

    if [ "$FAILED" -eq 0 ]; then
        echo "=== Offsite backup completed: $(date -u) ==="
    else
        echo "=== Offsite backup completed WITH ERRORS: $(date -u) ==="
    fi
} >> "$LOG" 2>&1
