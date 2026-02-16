#!/usr/bin/env bash
# =============================================================================
# lightning-lookup-payment.sh
#
# Looks up a payment by hash, BOLT11 invoice, or shows recent pending invoices.
# Primary customer support tool when someone says "my payment failed."
#
# Run ON THE VPS as butter.
#
# Usage:
#   ./lightning-lookup-payment.sh --hash <payment_hash>
#   ./lightning-lookup-payment.sh --invoice <bolt11_invoice>
#   ./lightning-lookup-payment.sh --pending
#   ./lightning-lookup-payment.sh --recent [N]
# =============================================================================
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lightning-common.sh"

MODE=""
PAYMENT_HASH=""
INVOICE=""
RECENT_COUNT=10

while [ $# -gt 0 ]; do
    case "$1" in
        --hash)     MODE="hash"; PAYMENT_HASH="$2"; shift 2 ;;
        --invoice)  MODE="invoice"; INVOICE="$2"; shift 2 ;;
        --pending)  MODE="pending"; shift ;;
        --recent)   MODE="recent"; RECENT_COUNT="${2:-10}"; shift; [ "${1:-}" ] && [[ "$1" =~ ^[0-9]+$ ]] && { RECENT_COUNT="$1"; shift; } || true ;;
        *)
            echo "Usage:"
            echo "  $0 --hash <payment_hash>        Look up by payment hash"
            echo "  $0 --invoice <bolt11_invoice>    Decode + look up invoice"
            echo "  $0 --pending                     Show pending incoming invoices"
            echo "  $0 --recent [N]                  Show N most recent invoices (default: 10)"
            exit 1
            ;;
    esac
done

if [ -z "$MODE" ]; then
    echo "Usage:"
    echo "  $0 --hash <payment_hash>"
    echo "  $0 --invoice <bolt11_invoice>"
    echo "  $0 --pending"
    echo "  $0 --recent [N]"
    exit 1
fi

case "$MODE" in
    hash)
        echo "Looking up payment hash: ${PAYMENT_HASH:0:16}..."
        echo ""

        # Try outgoing payments
        echo "--- Outgoing payment ---"
        RESULT=$($LNCLI lookuppayment "$PAYMENT_HASH" 2>&1) && {
            echo "$RESULT" | python3 -c "
import sys, json
data = json.load(sys.stdin)
for p in data.get('payments', [data] if 'payment_hash' in data else []):
    status = p.get('status', 'UNKNOWN')
    amount = p.get('value_sat', p.get('value', '0'))
    fee = p.get('fee_sat', p.get('fee', '0'))
    created = p.get('creation_date', '')
    failure = p.get('failure_reason', '')
    print(f'  Status:   {status}')
    print(f'  Amount:   {amount} sats')
    print(f'  Fee:      {fee} sats')
    print(f'  Created:  {created}')
    if failure and failure != 'FAILURE_REASON_NONE':
        print(f'  Failure:  {failure}')
" 2>/dev/null || echo "  Not found in outgoing payments."
        } || echo "  Not found in outgoing payments."

        echo ""
        echo "--- Incoming invoice ---"
        # Check if it exists as an incoming invoice (lookup by hash via listinvoices)
        INVOICES=$($LNCLI listinvoices --max_invoices 1000 --reversed 2>/dev/null || echo '{"invoices":[]}')
        echo "$INVOICES" | python3 -c "
import sys, json
target = '$PAYMENT_HASH'
data = json.load(sys.stdin)
found = False
for inv in data.get('invoices', []):
    if inv.get('r_hash', '') == target or inv.get('payment_request_hash', '') == target:
        found = True
        state = inv.get('state', 'UNKNOWN')
        amount = inv.get('value', '0')
        memo = inv.get('memo', '')
        settled = inv.get('settle_date', '')
        created = inv.get('creation_date', '')
        print(f'  State:    {state}')
        print(f'  Amount:   {amount} sats')
        print(f'  Memo:     {memo}')
        print(f'  Created:  {created}')
        if settled and settled != '0':
            print(f'  Settled:  {settled}')
        break
if not found:
    print('  Not found in incoming invoices.')
" 2>/dev/null || echo "  Error searching invoices."
        ;;

    invoice)
        echo "Decoding invoice..."
        echo ""

        DECODED=$($LNCLI decodepayreq "$INVOICE")
        echo "$DECODED" | python3 -c "
import sys, json
d = json.load(sys.stdin)
print(f'  Destination: {d[\"destination\"][:16]}...{d[\"destination\"][-8:]}')
print(f'  Amount:      {d[\"num_satoshis\"]} sats')
print(f'  Hash:        {d[\"payment_hash\"]}')
desc = d.get('description', '')
if desc:
    print(f'  Description: {desc}')
expiry = int(d.get('expiry', 0))
ts = int(d.get('timestamp', 0))
import time
if ts and expiry:
    expires_at = ts + expiry
    now = int(time.time())
    remaining = expires_at - now
    if remaining <= 0:
        print(f'  Expiry:      EXPIRED ({abs(remaining)}s ago)')
    else:
        print(f'  Expiry:      {remaining}s remaining')
"

        HASH=$(echo "$DECODED" | lnd_json payment_hash)

        echo ""
        echo "Checking payment status for hash: ${HASH:0:16}..."

        # Try to look up as outgoing
        $LNCLI lookuppayment "$HASH" 2>/dev/null | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    payments = data.get('payments', [data] if 'payment_hash' in data else [])
    for p in payments:
        status = p.get('status', 'UNKNOWN')
        fee = p.get('fee_sat', p.get('fee', '0'))
        failure = p.get('failure_reason', '')
        print(f'  Outgoing status: {status}')
        print(f'  Fee paid:        {fee} sats')
        if failure and failure != 'FAILURE_REASON_NONE':
            print(f'  Failure reason:  {failure}')
except:
    pass
" 2>/dev/null || true

        # Check route availability
        DEST=$(echo "$DECODED" | lnd_json destination)
        AMT=$(echo "$DECODED" | lnd_json num_satoshis)
        echo ""
        echo "Testing route to destination..."
        $LNCLI queryroutes --dest "$DEST" --amt "$AMT" 2>&1 | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    routes = data.get('routes', [])
    if routes:
        hops = len(routes[0].get('hops', []))
        total_fees = routes[0].get('total_fees_msat', '0')
        fee_sats = int(total_fees) // 1000
        print(f'  Route found: {hops} hops, ~{fee_sats} sats fee')
    else:
        print('  No route found. Check channel liquidity.')
except:
    print('  Could not query routes.')
" 2>/dev/null || echo "  Could not query routes."
        ;;

    pending)
        echo "Pending incoming invoices:"
        echo ""
        $LNCLI listinvoices --pending_only | python3 -c "
import sys, json, time
data = json.load(sys.stdin)
invoices = data.get('invoices', [])
if not invoices:
    print('  No pending invoices.')
    sys.exit(0)
for inv in invoices:
    amount = inv.get('value', '0')
    memo = inv.get('memo', '')
    created = int(inv.get('creation_date', '0'))
    expiry = int(inv.get('expiry', '3600'))
    now = int(time.time())
    remaining = (created + expiry) - now
    hash_val = inv.get('r_hash', '')
    state = inv.get('state', 'UNKNOWN')
    exp_str = f'{remaining}s remaining' if remaining > 0 else 'EXPIRED'
    print(f'  [{state}] {amount} sats  {exp_str}')
    if memo:
        print(f'    Memo: {memo}')
    if hash_val:
        print(f'    Hash: {hash_val[:32]}...')
    print()
"
        ;;

    recent)
        echo "Last $RECENT_COUNT invoices:"
        echo ""
        $LNCLI listinvoices --max_invoices "$RECENT_COUNT" --reversed | python3 -c "
import sys, json, time
data = json.load(sys.stdin)
invoices = data.get('invoices', [])
if not invoices:
    print('  No invoices found.')
    sys.exit(0)
for inv in invoices:
    amount = inv.get('value', '0')
    memo = inv.get('memo', '')
    state = inv.get('state', 'UNKNOWN')
    created = int(inv.get('creation_date', '0'))
    settled = int(inv.get('settle_date', '0'))
    time_str = time.strftime('%Y-%m-%d %H:%M', time.localtime(created)) if created else '?'
    settle_str = time.strftime('%H:%M', time.localtime(settled)) if settled and settled != 0 else ''
    status_char = {'SETTLED': 'PAID', 'OPEN': 'OPEN', 'CANCELED': 'CANC', 'ACCEPTED': 'ACPT'}.get(state, state[:4])
    line = f'  [{status_char:4s}] {amount:>10s} sats  {time_str}'
    if settle_str:
        line += f'  settled {settle_str}'
    if memo:
        line += f'  \"{memo}\"'
    print(line)
"
        ;;
esac
