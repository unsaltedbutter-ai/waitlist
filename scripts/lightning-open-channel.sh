#!/usr/bin/env bash
# =============================================================================
# lightning-open-channel.sh
#
# Opens a Lightning channel to a specified node.
# Run ON THE VPS as butter.
#
# Usage:
#   ./lightning-open-channel.sh <pubkey>@<host>:<port> <amount_sats> [options]
#
# Options:
#   --private           Open a private (unannounced) channel
#   --sat-per-vbyte N   Set on-chain fee rate (default: auto)
#
# Examples:
#   # ACINQ (Phoenix/Eclair):
#   ./lightning-open-channel.sh 03864ef025fde8fb587d989186ce6a4a186895ee44a926bfc370e2c366597a3f8f@3.33.236.230:9735 500000
#
#   # With options:
#   ./lightning-open-channel.sh 03864ef025fde8fb587d989186ce6a4a186895ee44a926bfc370e2c366597a3f8f@3.33.236.230:9735 500000 --private --sat-per-vbyte 10
# =============================================================================
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lightning-common.sh"

MIN_CHANNEL_SATS=20000
PRIVATE_FLAG=""
FEE_FLAG=""

if [ $# -lt 2 ]; then
    echo "Usage: $0 <pubkey>@<host>:<port> <amount_sats> [--private] [--sat-per-vbyte N]"
    echo ""
    echo "Common nodes:"
    echo "  ACINQ:  03864ef025fde8fb587d989186ce6a4a186895ee44a926bfc370e2c366597a3f8f@3.33.236.230:9735"
    echo "  LOOP:   021c97a90a411ff2b10dc2a8e32de2f29d2fa49d41bfbb52bd416e460db0747d0d@54.184.88.205:9735"
    exit 1
fi

NODE_URI="$1"
AMOUNT_SATS="$2"
shift 2

while [ $# -gt 0 ]; do
    case "$1" in
        --private)        PRIVATE_FLAG="--private"; shift ;;
        --sat-per-vbyte)  FEE_FLAG="--sat_per_vbyte $2"; shift 2 ;;
        *)                echo "Unknown option: $1"; exit 1 ;;
    esac
done

# Parse pubkey and host from URI
PUBKEY="${NODE_URI%%@*}"
HOST="${NODE_URI#*@}"

if [ -z "$PUBKEY" ] || [ -z "$HOST" ] || [ "$PUBKEY" = "$NODE_URI" ]; then
    echo "ERROR: Invalid node URI. Expected format: <pubkey>@<host>:<port>"
    exit 1
fi

if [ "$AMOUNT_SATS" -lt "$MIN_CHANNEL_SATS" ]; then
    echo "ERROR: Minimum channel size is ${MIN_CHANNEL_SATS} sats."
    echo "Channels smaller than this are impractical (high fee ratio, low capacity)."
    exit 1
fi

echo "Connecting to peer..."
echo "  Pubkey: ${PUBKEY:0:16}..."
echo "  Host:   $HOST"
echo ""

# Connect to peer. Only suppress "already connected" errors.
CONNECT_OUTPUT=$($LNCLI connect "$NODE_URI" 2>&1) || {
    if echo "$CONNECT_OUTPUT" | grep -q "already connected"; then
        echo "  Already connected to peer."
    else
        echo "ERROR connecting to peer:"
        echo "  $CONNECT_OUTPUT"
        exit 1
    fi
}

# Resolve peer alias
ALIAS=$($LNCLI getnodeinfo --pub_key "$PUBKEY" 2>/dev/null | lnd_json node alias 2>/dev/null || echo "")
ALIAS_STR=""
if [ -n "$ALIAS" ]; then
    ALIAS_STR=" ($ALIAS)"
fi

# Show on-chain balance for context
WALLET=$($LNCLI walletbalance 2>/dev/null)
ONCHAIN=$(echo "$WALLET" | lnd_json confirmed_balance 2>/dev/null || echo "?")

echo "Open channel:"
echo "  Peer:     ${PUBKEY:0:16}...${PUBKEY: -6}${ALIAS_STR}"
echo "  Amount:   $(printf "%'d" "$AMOUNT_SATS") sats"
echo "  On-chain: $(printf "%'d" "$ONCHAIN") sats available"
[ -n "$PRIVATE_FLAG" ] && echo "  Private (unannounced) channel"
echo ""

# Show current fee conditions
FEE_DATA=$(curl -sf https://mempool.space/api/v1/fees/recommended 2>/dev/null || echo "")
if [ -n "$FEE_DATA" ]; then
    echo "Current mempool fees (sat/vB):"
    echo "$FEE_DATA" | python3 -c "
import sys, json
d = json.load(sys.stdin)
print(f'    Next block: {d[\"fastestFee\"]}    30 min: {d[\"halfHourFee\"]}    1 hour: {d[\"hourFee\"]}    Economy: {d[\"economyFee\"]}')
" 2>/dev/null || true
fi

if [ -n "$FEE_FLAG" ]; then
    echo "  Selected fee rate: $FEE_FLAG"
else
    echo "  Fee rate: LND auto-estimate (target 6 blocks)"
    echo "  Tip: Use --sat-per-vbyte N for a lower rate if you are not in a hurry."
fi

echo ""
read -r -p "Proceed with open? (y/N): " confirm
if [[ ! "$confirm" =~ ^[yY]$ ]]; then
    echo "Cancelled."
    exit 0
fi

echo ""
echo "Opening channel..."

# shellcheck disable=SC2086
RESULT=$($LNCLI openchannel $PRIVATE_FLAG $FEE_FLAG "$PUBKEY" "$AMOUNT_SATS")
echo "$RESULT"

TXID=$(echo "$RESULT" | lnd_json funding_txid_str 2>/dev/null || echo "")

echo ""
if [ -n "$TXID" ]; then
    echo "Channel funding tx: $TXID"
    echo "Waiting for 3 confirmations before the channel is active."
else
    echo "Check output above for status."
fi

echo ""
if [ -n "$TXID" ]; then
    echo "Monitor at: https://mempool.space/tx/$TXID"
fi
echo "Monitor pending channels with:"
echo "  ./lightning-status.sh"
