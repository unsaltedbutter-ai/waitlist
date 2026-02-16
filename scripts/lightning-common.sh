#!/usr/bin/env bash
# =============================================================================
# lightning-common.sh — Shared config for all Lightning scripts.
# Source this file, do not execute it directly.
# =============================================================================

LND_CONTAINER="btcpayserver_lnd_bitcoin"
LNCLI="docker exec $LND_CONTAINER lncli -n mainnet --macaroonpath=/data/admin.macaroon --tlscertpath=/data/tls.cert"

# Safe JSON field extractor. Prints the raw output on parse failure instead of
# a Python traceback, so the operator sees the actual LND error message.
lnd_json() {
    local input
    input=$(cat)
    echo "$input" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    fields = sys.argv[1:]
    if len(fields) == 0:
        json.dump(data, sys.stdout, indent=2)
    else:
        obj = data
        for f in fields:
            if isinstance(obj, list):
                obj = obj[int(f)]
            else:
                obj = obj[f]
        print(obj)
except (json.JSONDecodeError, KeyError, IndexError, TypeError) as e:
    print(f'Parse error: {e}', file=sys.stderr)
    # Print the raw input so the operator sees the actual LND message
    print(sys.argv[-1] if len(sys.argv) > 1 else '', end='', file=sys.stderr)
    sys.exit(1)
" "$@" 2>&1 || {
        echo ""
        echo "Raw LND output:"
        echo "$input"
        return 1
    }
}
