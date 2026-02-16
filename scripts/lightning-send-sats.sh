#!/usr/bin/env bash
# =============================================================================
# lightning-send-sats.sh
#
# Sends sats over Lightning. Supports BOLT11 invoices and Lightning Addresses.
# Run ON THE VPS as butter.
#
# Usage:
#   ./lightning-send-sats.sh --invoice <bolt11_invoice>
#   ./lightning-send-sats.sh --address <user@domain.com> --amount <sats>
#
# Options:
#   --fee-limit-percent N   Max routing fee as % of payment (default: 3)
#   --timeout N             Payment timeout in seconds (default: 60)
#
# Examples:
#   ./lightning-send-sats.sh --invoice lnbc500u1p...
#   ./lightning-send-sats.sh --address ray@phoenix.acinq.co --amount 100000
#   ./lightning-send-sats.sh --invoice lnbc... --fee-limit-percent 1 --timeout 30
# =============================================================================
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lightning-common.sh"

INVOICE=""
LN_ADDRESS=""
AMOUNT_SATS=""
FEE_LIMIT_PERCENT="3"
TIMEOUT="60"

while [ $# -gt 0 ]; do
    case "$1" in
        --invoice)            INVOICE="$2"; shift 2 ;;
        --address)            LN_ADDRESS="$2"; shift 2 ;;
        --amount)             AMOUNT_SATS="$2"; shift 2 ;;
        --fee-limit-percent)  FEE_LIMIT_PERCENT="$2"; shift 2 ;;
        --timeout)            TIMEOUT="$2"; shift 2 ;;
        *)
            echo "Unknown argument: $1"
            echo "Usage:"
            echo "  $0 --invoice <bolt11_invoice>"
            echo "  $0 --address <user@domain.com> --amount <sats>"
            echo ""
            echo "Options:"
            echo "  --fee-limit-percent N   Max routing fee % (default: 3)"
            echo "  --timeout N             Timeout in seconds (default: 60)"
            exit 1
            ;;
    esac
done

# Resolve Lightning Address to BOLT11 invoice
if [ -n "$LN_ADDRESS" ]; then
    if [ -z "$AMOUNT_SATS" ]; then
        echo "ERROR: --amount is required when using --address"
        exit 1
    fi

    # Parse user@domain
    LN_USER="${LN_ADDRESS%%@*}"
    LN_DOMAIN="${LN_ADDRESS#*@}"

    if [ -z "$LN_USER" ] || [ -z "$LN_DOMAIN" ] || [ "$LN_USER" = "$LN_ADDRESS" ]; then
        echo "ERROR: Invalid Lightning Address. Expected format: user@domain.com"
        exit 1
    fi

    AMOUNT_MSATS=$((AMOUNT_SATS * 1000))

    echo "Resolving Lightning Address: $LN_ADDRESS"
    echo ""

    # Step 1: Fetch LNURL-pay metadata
    LNURL_RESPONSE=$(curl -sf "https://${LN_DOMAIN}/.well-known/lnurlp/${LN_USER}")
    if [ -z "$LNURL_RESPONSE" ]; then
        echo "ERROR: Could not resolve Lightning Address. Check the address and try again."
        exit 1
    fi

    # Check for LNURL error response
    LNURL_STATUS=$(echo "$LNURL_RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('status','OK'))" 2>/dev/null || echo "OK")
    if [ "$LNURL_STATUS" = "ERROR" ]; then
        LNURL_REASON=$(echo "$LNURL_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('reason','Unknown error'))")
        echo "ERROR from LNURL provider: $LNURL_REASON"
        exit 1
    fi

    CALLBACK=$(echo "$LNURL_RESPONSE" | lnd_json callback)
    MIN_SENDABLE=$(echo "$LNURL_RESPONSE" | lnd_json minSendable)
    MAX_SENDABLE=$(echo "$LNURL_RESPONSE" | lnd_json maxSendable)

    echo "  Callback:     $CALLBACK"
    echo "  Min sendable: $((MIN_SENDABLE / 1000)) sats"
    echo "  Max sendable: $((MAX_SENDABLE / 1000)) sats"

    if [ "$AMOUNT_MSATS" -lt "$MIN_SENDABLE" ] || [ "$AMOUNT_MSATS" -gt "$MAX_SENDABLE" ]; then
        echo ""
        echo "ERROR: Amount ${AMOUNT_SATS} sats is outside the allowed range."
        exit 1
    fi

    # Step 2: Request invoice from callback
    if echo "$CALLBACK" | grep -q '?'; then
        SEPARATOR="&"
    else
        SEPARATOR="?"
    fi

    INVOICE_RESPONSE=$(curl -sf "${CALLBACK}${SEPARATOR}amount=${AMOUNT_MSATS}")

    # Check for error in callback response
    CB_STATUS=$(echo "$INVOICE_RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('status','OK'))" 2>/dev/null || echo "OK")
    if [ "$CB_STATUS" = "ERROR" ]; then
        CB_REASON=$(echo "$INVOICE_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('reason','Unknown error'))")
        echo "ERROR from payment provider: $CB_REASON"
        exit 1
    fi

    INVOICE=$(echo "$INVOICE_RESPONSE" | lnd_json pr)

    echo "  Invoice:      ${INVOICE:0:40}..."
    echo ""
fi

if [ -z "$INVOICE" ]; then
    echo "ERROR: No invoice provided. Use --invoice or --address."
    echo ""
    echo "Usage:"
    echo "  $0 --invoice <bolt11_invoice>"
    echo "  $0 --address <user@domain.com> --amount <sats>"
    exit 1
fi

# Decode and display invoice details before paying
echo "Decoding invoice..."
DECODED=$($LNCLI decodepayreq "$INVOICE")
PAY_AMOUNT=$(echo "$DECODED" | lnd_json num_satoshis)
DESCRIPTION=$(echo "$DECODED" | python3 -c "import sys,json; print(json.load(sys.stdin).get('description',''))" 2>/dev/null || echo "")
DESTINATION=$(echo "$DECODED" | lnd_json destination)
EXPIRY=$(echo "$DECODED" | python3 -c "import sys,json; print(json.load(sys.stdin).get('expiry',''))" 2>/dev/null || echo "")
TIMESTAMP=$(echo "$DECODED" | python3 -c "import sys,json; print(json.load(sys.stdin).get('timestamp',''))" 2>/dev/null || echo "")

# Calculate max fee
MAX_FEE=$(python3 -c "import math; print(math.ceil(${PAY_AMOUNT} * ${FEE_LIMIT_PERCENT} / 100))")

echo ""
echo "Payment details:"
echo "  Amount:      ${PAY_AMOUNT} sats"
echo "  Destination: ${DESTINATION:0:16}..."
echo "  Max fee:     ${MAX_FEE} sats (${FEE_LIMIT_PERCENT}%)"
echo "  Timeout:     ${TIMEOUT}s"
[ -n "$DESCRIPTION" ] && echo "  Description: $DESCRIPTION"
if [ -n "$EXPIRY" ] && [ -n "$TIMESTAMP" ]; then
    EXPIRES_AT=$((TIMESTAMP + EXPIRY))
    REMAINING=$((EXPIRES_AT - $(date +%s)))
    if [ "$REMAINING" -le 0 ]; then
        echo "  WARNING: Invoice has EXPIRED"
        exit 1
    fi
    echo "  Expires in:  ${REMAINING}s"
fi

echo ""
read -rp "Send ${PAY_AMOUNT} sats (+ up to ${MAX_FEE} sats fee)? [y/N] " CONFIRM
if [ "$CONFIRM" != "y" ] && [ "$CONFIRM" != "Y" ]; then
    echo "Cancelled."
    exit 0
fi

echo ""
echo "Sending..."
$LNCLI payinvoice --force --fee_limit "$MAX_FEE" --timeout "${TIMEOUT}s" "$INVOICE"

echo ""
echo "Done."
