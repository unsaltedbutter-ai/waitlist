#!/bin/bash
# LND Static Channel Backup (SCB) snapshot.
# Called by backup-daily.sh. Keeps last 30 copies.
set -euo pipefail

LND_CONTAINER=$(sudo docker ps --format '{{.Names}}' | grep 'lnd_bitcoin$' | head -1)
if [ -z "$LND_CONTAINER" ]; then exit 0; fi

BACKUP_DIR="$HOME/scb-backups"
mkdir -p "$BACKUP_DIR"

sudo docker cp "$LND_CONTAINER:/data/.lnd/data/chain/bitcoin/mainnet/channel.backup" \
    "${BACKUP_DIR}/channel.backup.$(date +%Y%m%d_%H%M%S)" 2>/dev/null || true

# Keep last 30
ls -t "${BACKUP_DIR}"/channel.backup.* 2>/dev/null | tail -n +31 | xargs rm -f 2>/dev/null || true
