#!/usr/bin/env bash
# =============================================================================
# lightning-backup.sh
#
# Exports and verifies the Static Channel Backup (SCB). This is your disaster
# recovery file. Without it, funds in channels are unrecoverable if the LND
# database is lost.
#
# Run ON THE VPS as butter.
#
# Usage:
#   ./lightning-backup.sh                    Export to default location
#   ./lightning-backup.sh /path/to/backup    Export to specific path
# =============================================================================
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lightning-common.sh"

BACKUP_DIR="${1:-/home/butter/scb-backups}"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="${BACKUP_DIR}/channel-backup-${TIMESTAMP}.bak"

# Ensure backup directory exists
mkdir -p "$BACKUP_DIR"

echo "Exporting Static Channel Backup..."
echo ""

# Export the multi-channel backup
$LNCLI exportchanbackup --all --output_file="/tmp/scb-export-${TIMESTAMP}.bak"

# Copy from container to host
docker cp "btcpayserver_lnd_bitcoin:/tmp/scb-export-${TIMESTAMP}.bak" "$BACKUP_FILE"

# Clean up temp file in container
docker exec btcpayserver_lnd_bitcoin rm -f "/tmp/scb-export-${TIMESTAMP}.bak"

if [ ! -f "$BACKUP_FILE" ]; then
    echo "ERROR: Backup file was not created."
    exit 1
fi

FILESIZE=$(stat -c%s "$BACKUP_FILE" 2>/dev/null || stat -f%z "$BACKUP_FILE" 2>/dev/null || echo "0")

echo "Backup saved: $BACKUP_FILE"
echo "Size:         $FILESIZE bytes"
echo "Timestamp:    $TIMESTAMP"

# Verify the backup
echo ""
echo "Verifying backup..."
docker cp "$BACKUP_FILE" "btcpayserver_lnd_bitcoin:/tmp/verify-scb.bak"
VERIFY=$($LNCLI verifychanbackup --multi_file="/tmp/verify-scb.bak" 2>&1) && {
    echo "Verification: PASSED"
} || {
    echo "Verification: FAILED"
    echo "$VERIFY"
}
docker exec btcpayserver_lnd_bitcoin rm -f "/tmp/verify-scb.bak"

# Count existing backups
BACKUP_COUNT=$(ls -1 "${BACKUP_DIR}"/channel-backup-*.bak 2>/dev/null | wc -l)
echo ""
echo "Total backups in ${BACKUP_DIR}: $BACKUP_COUNT"

# Show channel count for context
CHAN_COUNT=$($LNCLI listchannels | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('channels',[])))" 2>/dev/null || echo "?")
echo "Active channels: $CHAN_COUNT"

echo ""
echo "To copy to your local machine:"
echo "  scp unsaltedbutter:${BACKUP_FILE} ~/Desktop/"
