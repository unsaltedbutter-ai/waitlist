#!/usr/bin/env bash
# =============================================================================
# lightning-status.sh
#
# Node health dashboard. Shows sync status, balances, channels, and pending
# HTLCs at a glance.
# Run ON THE VPS as butter.
# =============================================================================
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lightning-common.sh"

echo "============================================"
echo "  Lightning Node Status"
echo "============================================"
echo ""

# --- Node info ---
INFO=$($LNCLI getinfo)

ALIAS=$(echo "$INFO" | lnd_json alias)
PUBKEY=$(echo "$INFO" | lnd_json identity_pubkey)
SYNCED_CHAIN=$(echo "$INFO" | lnd_json synced_to_chain)
SYNCED_GRAPH=$(echo "$INFO" | lnd_json synced_to_graph)
BLOCK_HEIGHT=$(echo "$INFO" | lnd_json block_height)
NUM_ACTIVE=$(echo "$INFO" | lnd_json num_active_channels)
NUM_INACTIVE=$(echo "$INFO" | lnd_json num_inactive_channels)
NUM_PENDING=$(echo "$INFO" | lnd_json num_pending_channels)
VERSION=$(echo "$INFO" | python3 -c "import sys,json; print(json.load(sys.stdin).get('version','unknown'))" 2>/dev/null || echo "unknown")

echo "Node:     $ALIAS"
echo "Pubkey:   ${PUBKEY:0:20}...${PUBKEY: -8}"
echo "Version:  $VERSION"
echo "Block:    $BLOCK_HEIGHT"
echo ""

if [ "$SYNCED_CHAIN" = "True" ] || [ "$SYNCED_CHAIN" = "true" ]; then
    echo "Chain sync:  OK"
else
    echo "Chain sync:  NOT SYNCED"
fi

if [ "$SYNCED_GRAPH" = "True" ] || [ "$SYNCED_GRAPH" = "true" ]; then
    echo "Graph sync:  OK"
else
    echo "Graph sync:  NOT SYNCED"
fi

echo ""
echo "--------------------------------------------"
echo "  Channels"
echo "--------------------------------------------"
echo ""
echo "  Active:   $NUM_ACTIVE"
echo "  Inactive: $NUM_INACTIVE"
echo "  Pending:  $NUM_PENDING"

# --- Balances ---
echo ""
echo "--------------------------------------------"
echo "  Balances"
echo "--------------------------------------------"
echo ""

WALLET=$($LNCLI walletbalance)
ONCHAIN_CONFIRMED=$(echo "$WALLET" | lnd_json confirmed_balance)
ONCHAIN_UNCONFIRMED=$(echo "$WALLET" | lnd_json unconfirmed_balance)

echo "  On-chain confirmed:   $(printf "%'d" "$ONCHAIN_CONFIRMED") sats"
echo "  On-chain unconfirmed: $(printf "%'d" "$ONCHAIN_UNCONFIRMED") sats"

CHANBAL=$($LNCLI channelbalance)
LOCAL=$(echo "$CHANBAL" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('local_balance',{}).get('sat','0'))" 2>/dev/null || echo "0")
REMOTE=$(echo "$CHANBAL" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('remote_balance',{}).get('sat','0'))" 2>/dev/null || echo "0")
PENDING_OPEN=$(echo "$CHANBAL" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('pending_open_local_balance',{}).get('sat','0'))" 2>/dev/null || echo "0")

echo ""
echo "  Channel local (outbound):  $(printf "%'d" "$LOCAL") sats"
echo "  Channel remote (inbound):  $(printf "%'d" "$REMOTE") sats"
[ "$PENDING_OPEN" != "0" ] && echo "  Pending open:              $(printf "%'d" "$PENDING_OPEN") sats"

TOTAL=$((ONCHAIN_CONFIRMED + LOCAL))
echo ""
echo "  Total controlled:          $(printf "%'d" "$TOTAL") sats"

# --- Pending channels ---
PENDING=$($LNCLI pendingchannels)
PENDING_OPEN_COUNT=$(echo "$PENDING" | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('pending_open_channels',[])))" 2>/dev/null || echo "0")
PENDING_CLOSE_COUNT=$(echo "$PENDING" | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('pending_closing_channels',[])))" 2>/dev/null || echo "0")
PENDING_FORCE_COUNT=$(echo "$PENDING" | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('pending_force_closing_channels',[])))" 2>/dev/null || echo "0")
WAITING_CLOSE_COUNT=$(echo "$PENDING" | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('waiting_close_channels',[])))" 2>/dev/null || echo "0")

if [ "$PENDING_OPEN_COUNT" != "0" ] || [ "$PENDING_CLOSE_COUNT" != "0" ] || [ "$PENDING_FORCE_COUNT" != "0" ] || [ "$WAITING_CLOSE_COUNT" != "0" ]; then
    echo ""
    echo "--------------------------------------------"
    echo "  Pending Channels"
    echo "--------------------------------------------"
    echo ""
    [ "$PENDING_OPEN_COUNT" != "0" ] && echo "  Opening:       $PENDING_OPEN_COUNT"
    [ "$PENDING_CLOSE_COUNT" != "0" ] && echo "  Closing:       $PENDING_CLOSE_COUNT"
    [ "$PENDING_FORCE_COUNT" != "0" ] && echo "  Force closing: $PENDING_FORCE_COUNT"
    [ "$WAITING_CLOSE_COUNT" != "0" ] && echo "  Waiting close: $WAITING_CLOSE_COUNT"
fi

# --- HTLC summary ---
CHANNELS=$($LNCLI listchannels)
HTLC_COUNT=$(echo "$CHANNELS" | python3 -c "
import sys, json
data = json.load(sys.stdin)
total = sum(len(ch.get('pending_htlcs', [])) for ch in data.get('channels', []))
print(total)
" 2>/dev/null || echo "0")

if [ "$HTLC_COUNT" != "0" ]; then
    echo ""
    echo "--------------------------------------------"
    echo "  In-flight HTLCs: $HTLC_COUNT"
    echo "--------------------------------------------"
fi

echo ""
echo "============================================"
