#!/usr/bin/env bash
# =============================================================================
# lightning-close-channel.sh
#
# Closes a Lightning channel. Cooperative close by default (cheaper, faster).
# Use --force for uncooperative close (when peer is offline/unresponsive).
#
# Run ON THE VPS as butter.
#
# Usage:
#   ./lightning-close-channel.sh <channel_point>
#   ./lightning-close-channel.sh <channel_point> --force
#   ./lightning-close-channel.sh <channel_point> --sat-per-vbyte N
#
# The channel_point is the funding outpoint (txid:output_index), shown in
# lightning-channel-report.sh as "Point: <txid>:<index>".
#
# Examples:
#   # Cooperative close:
#   ./lightning-close-channel.sh c6b730dc63e294d9967249c47423531749f082f227a5afb7b7445f15771afe5d:0
#
#   # Force close (unresponsive peer):
#   ./lightning-close-channel.sh c6b730dc63e294d9967249c47423531749f082f227a5afb7b7445f15771afe5d:0 --force
# =============================================================================
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lightning-common.sh"

FORCE_FLAG=""
FEE_FLAG=""

if [ $# -lt 1 ]; then
    echo "Usage: $0 <channel_point> [--force] [--sat-per-vbyte N]"
    echo ""
    echo "  channel_point    Funding outpoint (txid:output_index)"
    echo "                   Find it with: ./lightning-channel-report.sh"
    echo ""
    echo "  --force          Force close (uncooperative). Use when peer is offline."
    echo "                   Funds locked for 1-14 days (timelock). Higher on-chain fees."
    echo ""
    echo "  --sat-per-vbyte  Set on-chain fee rate (default: auto)"
    exit 1
fi

CHANNEL_POINT="$1"
shift

while [ $# -gt 0 ]; do
    case "$1" in
        --force)          FORCE_FLAG="--force"; shift ;;
        --sat-per-vbyte)  FEE_FLAG="--sat_per_vbyte $2"; shift 2 ;;
        *)                echo "Unknown option: $1"; exit 1 ;;
    esac
done

# Validate channel point format (txid:index)
FUNDING_TXID="${CHANNEL_POINT%%:*}"
OUTPUT_INDEX="${CHANNEL_POINT#*:}"

if [ -z "$FUNDING_TXID" ] || [ "$FUNDING_TXID" = "$CHANNEL_POINT" ] || [ -z "$OUTPUT_INDEX" ]; then
    echo "ERROR: Invalid channel point. Expected format: <txid>:<output_index>"
    echo "  Example: c6b730dc63e294d9967249c47423531749f082f227a5afb7b7445f15771afe5d:0"
    exit 1
fi

# Look up channel details before closing
echo "Looking up channel..."
CHAN_INFO=$($LNCLI listchannels 2>/dev/null | python3 -c "
import sys, json
data = json.load(sys.stdin)
point = '$CHANNEL_POINT'
for ch in data.get('channels', []):
    if ch.get('channel_point') == point:
        capacity = int(ch.get('capacity', 0))
        local = int(ch.get('local_balance', 0))
        remote = int(ch.get('remote_balance', 0))
        active = ch.get('active', False)
        peer = ch.get('remote_pubkey', '')
        htlcs = len(ch.get('pending_htlcs', []))
        print(f'peer={peer}')
        print(f'capacity={capacity}')
        print(f'local={local}')
        print(f'remote={remote}')
        print(f'active={active}')
        print(f'htlcs={htlcs}')
        sys.exit(0)
print('not_found=true')
" 2>/dev/null) || CHAN_INFO="not_found=true"

if echo "$CHAN_INFO" | grep -q "not_found=true"; then
    echo "ERROR: Channel not found with point: $CHANNEL_POINT"
    echo "Run ./lightning-channel-report.sh to see active channels."
    exit 1
fi

# Parse channel info
eval "$CHAN_INFO"

# Resolve peer alias
ALIAS=$($LNCLI getnodeinfo --pub_key "$peer" 2>/dev/null | lnd_json node alias 2>/dev/null || echo "")
ALIAS_STR=""
if [ -n "$ALIAS" ]; then
    ALIAS_STR=" ($ALIAS)"
fi

echo ""
echo "Channel to close:"
echo "  Peer:     ${peer:0:16}...${peer: -6}${ALIAS_STR}"
echo "  Capacity: $(printf "%'d" "$capacity") sats"
echo "  Local:    $(printf "%'d" "$local") sats (yours, returned to wallet)"
echo "  Remote:   $(printf "%'d" "$remote") sats (theirs)"
echo "  Active:   $active"
if [ "$htlcs" -gt 0 ]; then
    echo "  Pending HTLCs: $htlcs"
    echo ""
    echo "WARNING: This channel has $htlcs pending HTLC(s)."
    echo "Wait for them to resolve before closing, or use --force."
fi
echo ""

if [ -n "$FORCE_FLAG" ]; then
    echo "MODE: Force close (uncooperative)"
    echo "  Your funds will be locked for the channel timelock period (typically 144-2016 blocks, 1-14 days)."
    echo "  On-chain fees will be higher than cooperative close."
else
    echo "MODE: Cooperative close"
    echo "  Funds returned to both parties in a single on-chain transaction."
    echo "  Requires peer to be online and responsive."
fi

# Show current fee conditions
FEE_DATA=$(curl -sf https://mempool.space/api/v1/fees/recommended 2>/dev/null || echo "")
if [ -n "$FEE_DATA" ]; then
    echo ""
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
read -r -p "Proceed with close? (y/N): " confirm
if [[ ! "$confirm" =~ ^[yY]$ ]]; then
    echo "Cancelled."
    exit 0
fi

echo ""
echo "Closing channel..."

# shellcheck disable=SC2086
RESULT=$($LNCLI closechannel $FORCE_FLAG $FEE_FLAG --funding_txid "$FUNDING_TXID" --output_index "$OUTPUT_INDEX" 2>&1) || {
    echo "ERROR: Close failed"
    echo "$RESULT"
    exit 1
}

echo "$RESULT"

CLOSE_TXID=$(echo "$RESULT" | lnd_json closing_txid 2>/dev/null || echo "")

echo ""
if [ -n "$CLOSE_TXID" ]; then
    echo "Closing transaction: $CLOSE_TXID"
    echo "Monitor at: https://mempool.space/tx/$CLOSE_TXID"
else
    echo "Close initiated. Check output above for status."
fi

echo ""
echo "Monitor pending closes with:"
echo "  ./lightning-status.sh"
echo "  $LNCLI pendingchannels"
