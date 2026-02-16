#!/usr/bin/env bash
# =============================================================================
# setup-offsite-backup.sh
#
# Sets up SSH key auth and daily rsync to Hetzner Storage Box.
# Run ON THE VPS as butter.
#
# Prerequisites:
#   - Hetzner Storage Box provisioned
#   - Storage box password available (needed once for SSH key install)
#
# Usage:
#   ./setup-offsite-backup.sh <username> <host>
#   ./setup-offsite-backup.sh u547750 u547750.your-storagebox.de
# =============================================================================
set -euo pipefail

if [ $# -lt 2 ]; then
  echo "Usage: $0 <storagebox-user> <storagebox-host>"
  echo "Example: $0 u547750 u547750.your-storagebox.de"
  exit 1
fi

SB_USER="$1"
SB_HOST="$2"
SB_PORT=23
SB_KEY="$HOME/.ssh/storagebox_ed25519"

echo "============================================"
echo "  Hetzner Storage Box Setup"
echo "============================================"
echo ""
echo "  User: $SB_USER"
echo "  Host: $SB_HOST"
echo ""

# Step 1: Generate SSH key
if [ -f "$SB_KEY" ]; then
  echo "SSH key already exists at $SB_KEY, skipping generation."
else
  echo "Generating SSH key..."
  ssh-keygen -t ed25519 -f "$SB_KEY" -N "" -C "butter@unsaltedbutter-backup"
  echo "DONE"
fi
echo ""

# Step 2: Install public key on storage box (skip if key auth already works)
# Note: Hetzner Storage Boxes have a restricted shell. "ls" and "true" don't work.
# Use "mkdir -p ." as a no-op connectivity test.
echo "Testing if SSH key auth is already configured..."
if ssh -p "$SB_PORT" -i "$SB_KEY" -o BatchMode=yes -o ConnectTimeout=10 "${SB_USER}@${SB_HOST}" "mkdir -p ." 2>/dev/null; then
  echo "PASS: Key auth already works, skipping install"
else
  echo "Key auth not configured. Installing SSH key on storage box..."
  echo "You will be prompted for the storage box password (one time only)."
  echo ""
  cat "${SB_KEY}.pub" | ssh -p "$SB_PORT" "${SB_USER}@${SB_HOST}" install-ssh-key
  echo ""
  echo "DONE: SSH key installed"
  echo ""

  # Verify it worked
  echo "Verifying key auth..."
  ssh -p "$SB_PORT" -i "$SB_KEY" -o BatchMode=yes -o ConnectTimeout=10 "${SB_USER}@${SB_HOST}" "mkdir -p ." \
    && echo "PASS: Key auth works" \
    || { echo "FAIL: Key auth not working"; exit 1; }
fi
echo ""

# Step 4: Create directory structure
echo "Creating backup directories on storage box..."
ssh -p "$SB_PORT" -i "$SB_KEY" "${SB_USER}@${SB_HOST}" "mkdir -p backups/daily backups/scb"
echo "DONE"
echo ""

# Step 5: Write the sync script (uses env vars so storagebox creds aren't hardcoded twice)
SYNC_SCRIPT="$HOME/scripts/backup-offsite.sh"
mkdir -p "$HOME/scripts"
cat > "$SYNC_SCRIPT" << SCRIPTEOF
#!/usr/bin/env bash
# Sync local backups to Hetzner Storage Box
# Runs daily at 3:30 AM UTC (after the 3 AM local backup)
# Installed by: setup-offsite-backup.sh
set -euo pipefail

SB_USER="$SB_USER"
SB_HOST="$SB_HOST"
SB_PORT=$SB_PORT
SB_KEY="\$HOME/.ssh/storagebox_ed25519"
LOG="\$HOME/logs/offsite-backup.log"

mkdir -p "\$HOME/logs"

{
  echo "=== Offsite backup started: \$(date -u) ==="

  # Sync daily backups (14-day retention matches local)
  rsync -az --delete \\
    -e "ssh -p \$SB_PORT -i \$SB_KEY -o BatchMode=yes" \\
    "\$HOME/backups/" \\
    "\${SB_USER}@\${SB_HOST}:backups/daily/"
  echo "Daily backups synced"

  # Sync SCB backups
  rsync -az --delete \\
    -e "ssh -p \$SB_PORT -i \$SB_KEY -o BatchMode=yes" \\
    "\$HOME/scb-backups/" \\
    "\${SB_USER}@\${SB_HOST}:backups/scb/"
  echo "SCB backups synced"

  echo "=== Offsite backup completed: \$(date -u) ==="
} >> "\$LOG" 2>&1
SCRIPTEOF
chmod +x "$SYNC_SCRIPT"
echo "Sync script written to: $SYNC_SCRIPT"
echo ""

# Step 6: Initial sync
echo "Running initial sync..."
bash "$SYNC_SCRIPT"
echo "DONE"
echo ""

# Step 7: Add to cron (3:30 AM UTC, after the 3 AM local backup)
CRON_LINE="30 3 * * * $SYNC_SCRIPT"
if crontab -l 2>/dev/null | grep -qF "backup-offsite.sh"; then
  echo "Cron entry already exists, skipping."
else
  (crontab -l 2>/dev/null; echo "$CRON_LINE") | crontab -
  echo "Cron entry added: $CRON_LINE"
fi
echo ""

echo "============================================"
echo "  Setup complete"
echo "============================================"
echo ""
echo "  Storage box: ${SB_USER}@${SB_HOST}"
echo "  Sync script: $SYNC_SCRIPT"
echo "  Cron: daily at 3:30 AM UTC"
echo "  Log: ~/logs/offsite-backup.log"
echo ""
echo "  Verify: ssh -p $SB_PORT -i $SB_KEY ${SB_USER}@${SB_HOST} ls -lR backups/"
