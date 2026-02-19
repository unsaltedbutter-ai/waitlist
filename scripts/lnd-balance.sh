#!/bin/bash
# LND balance logger: on-chain + channel balances.
# Cron: 0 6 * * * /home/butter/unsaltedbutter/scripts/lnd-balance.sh
#
# NOTE: This script only appends to a log file. Nobody is notified.
# TODO: Alert operator via Nostr DM if balance drops below threshold.
set -euo pipefail

LOG="$HOME/logs/lnd-balance.log"
mkdir -p "$HOME/logs"

LND_CONTAINER=$(sudo docker ps --format '{{.Names}}' | grep 'lnd_bitcoin$' | head -1)
if [ -z "$LND_CONTAINER" ]; then exit 0; fi

BALANCE=$(sudo docker exec "$LND_CONTAINER" lncli walletbalance 2>/dev/null \
    | python3 -c "import sys,json; print(json.load(sys.stdin).get('total_balance','?'))" 2>/dev/null \
    || echo "?")
CHAN=$(sudo docker exec "$LND_CONTAINER" lncli channelbalance 2>/dev/null \
    | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('local_balance',{}).get('sat','?'))" 2>/dev/null \
    || echo "?")

echo "$(date): onchain=${BALANCE} channels=${CHAN}" >> "$LOG"
