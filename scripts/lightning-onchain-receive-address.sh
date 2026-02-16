#!/usr/bin/env bash
# =============================================================================
# lightning-onchain-receive-address.sh
#
# Generates a new on-chain Bitcoin address for funding the LND wallet.
# Run ON THE VPS as butter.
#
# Usage:
#   ./lightning-onchain-receive-address.sh [p2wkh|p2tr]
# =============================================================================
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lightning-common.sh"

ADDR_TYPE="${1:-p2wkh}"

if [ "$ADDR_TYPE" != "p2wkh" ] && [ "$ADDR_TYPE" != "p2tr" ]; then
    echo "Usage: $0 [p2wkh|p2tr]"
    echo "  p2wkh  SegWit (default)"
    echo "  p2tr   Taproot (lower spend fees)"
    exit 1
fi

echo "Generating $ADDR_TYPE deposit address..."
echo ""

ADDRESS=$($LNCLI newaddress "$ADDR_TYPE" | lnd_json address)

echo "Send BTC to: $ADDRESS"
echo ""

# Show current wallet balance
BALANCE=$($LNCLI walletbalance)
CONFIRMED=$(echo "$BALANCE" | lnd_json confirmed_balance)
UNCONFIRMED=$(echo "$BALANCE" | lnd_json unconfirmed_balance)

echo "Current wallet balance:"
echo "  Confirmed:   ${CONFIRMED} sats"
echo "  Unconfirmed: ${UNCONFIRMED} sats"
