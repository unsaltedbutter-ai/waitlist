#!/bin/bash
# LND balance logger: on-chain + channel balances (local + inbound).
# Cron: 0 6 * * * /home/butter/unsaltedbutter/scripts/lnd-balance.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ALERT="$HOME/venvs/update-checker/bin/python $SCRIPT_DIR/nostr-alert.py"

LOG="$HOME/logs/lnd-balance.log"
mkdir -p "$HOME/logs"

LND_CONTAINER=$(sudo docker ps --format '{{.Names}}' | grep 'lnd_bitcoin$' | head -1)
if [ -z "$LND_CONTAINER" ]; then
    echo "$(date): ALERT LND container not running" >> "$LOG"
    $ALERT --key lnd-down "LND container not running" 2>/dev/null || true
    exit 0
fi

BALANCE=$(sudo docker exec "$LND_CONTAINER" lncli walletbalance 2>/dev/null \
    | python3 -c "import sys,json; print(json.load(sys.stdin).get('total_balance','?'))" 2>/dev/null \
    || echo "?")
CHAN=$(sudo docker exec "$LND_CONTAINER" lncli channelbalance 2>/dev/null \
    | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('local_balance',{}).get('sat','?'))" 2>/dev/null \
    || echo "?")
INBOUND=$(sudo docker exec "$LND_CONTAINER" lncli channelbalance 2>/dev/null \
    | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('remote_balance',{}).get('sat','?'))" 2>/dev/null \
    || echo "?")

echo "$(date): onchain=${BALANCE} local=${CHAN} inbound=${INBOUND}" >> "$LOG"

# Alert if inbound liquidity is below threshold
INBOUND_THRESHOLD="${INBOUND_THRESHOLD:-250000}"
if [ "$INBOUND" != "?" ] && [ "$INBOUND" -lt "$INBOUND_THRESHOLD" ] 2>/dev/null; then
    $ALERT --key inbound-low "Inbound liquidity low: ${INBOUND} sats (threshold: ${INBOUND_THRESHOLD})" 2>/dev/null || true
fi
