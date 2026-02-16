#!/usr/bin/env bash
# =============================================================================
# lightning-set-fees.sh
#
# View or update routing fee policy for channels.
# Run ON THE VPS as butter.
#
# Usage:
#   ./lightning-set-fees.sh                                    Show current fees
#   ./lightning-set-fees.sh --all --base 1000 --rate 5000      Set all channels
#   ./lightning-set-fees.sh --chan <txid:index> --base 1000 --rate 5000
#
# Options:
#   --all                Apply to all channels
#   --chan <chan_point>   Apply to specific channel (funding_txid:output_index)
#   --base N             Base fee in millisatoshis (default: 1000)
#   --rate N             Fee rate in parts per million (default: 5000)
#
# Recommended for merchant nodes (not routing):
#   ./lightning-set-fees.sh --all --base 1000 --rate 5000
# =============================================================================
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lightning-common.sh"

MODE=""
CHAN_POINT=""
BASE_FEE="1000"
FEE_RATE="5000"

while [ $# -gt 0 ]; do
    case "$1" in
        --all)   MODE="all"; shift ;;
        --chan)   MODE="chan"; CHAN_POINT="$2"; shift 2 ;;
        --base)  BASE_FEE="$2"; shift 2 ;;
        --rate)  FEE_RATE="$2"; shift 2 ;;
        *)
            echo "Usage:"
            echo "  $0                                         Show current fees"
            echo "  $0 --all --base 1000 --rate 5000           Set all channels"
            echo "  $0 --chan <txid:index> --base 1000 --rate 5000"
            exit 1
            ;;
    esac
done

# Show current fees if no mode specified
if [ -z "$MODE" ]; then
    echo "Current fee policy:"
    echo ""
    $LNCLI feereport | python3 -c "
import sys, json

data = json.load(sys.stdin)
channels = data.get('channel_fees', [])

if not channels:
    print('  No channels found.')
    sys.exit(0)

# Summary
day_fee = int(data.get('day_fee_sum', '0'))
week_fee = int(data.get('week_fee_sum', '0'))
month_fee = int(data.get('month_fee_sum', '0'))

print(f'  Routing fees earned:')
print(f'    Last 24h:  {day_fee} sats')
print(f'    Last 7d:   {week_fee} sats')
print(f'    Last 30d:  {month_fee} sats')
print()

print(f'  Per-channel policy:')
print()
for ch in channels:
    point = ch.get('chan_point', '?')
    base = ch.get('base_fee_msat', '0')
    rate = ch.get('fee_per_mil', '0')
    print(f'    {point}')
    print(f'      Base fee: {base} msat    Fee rate: {rate} ppm')
    print()
"
    exit 0
fi

# Apply fee policy
if [ "$MODE" = "all" ]; then
    echo "Setting fee policy on ALL channels:"
    echo "  Base fee: ${BASE_FEE} msat"
    echo "  Fee rate: ${FEE_RATE} ppm"
    echo ""

    $LNCLI updatechanpolicy --base_fee_msat "$BASE_FEE" --fee_rate_ppm "$FEE_RATE"

    echo ""
    echo "Done. All channels updated."
elif [ "$MODE" = "chan" ]; then
    if [ -z "$CHAN_POINT" ]; then
        echo "ERROR: --chan requires a channel point (funding_txid:output_index)"
        exit 1
    fi

    echo "Setting fee policy on channel: $CHAN_POINT"
    echo "  Base fee: ${BASE_FEE} msat"
    echo "  Fee rate: ${FEE_RATE} ppm"
    echo ""

    $LNCLI updatechanpolicy --base_fee_msat "$BASE_FEE" --fee_rate_ppm "$FEE_RATE" --chan_point "$CHAN_POINT"

    echo ""
    echo "Done."
fi
