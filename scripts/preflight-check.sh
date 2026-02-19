#!/usr/bin/env bash
# =============================================================================
# preflight-check.sh
#
# Pre-maintenance readiness check. Run before updating BTCPay/LND, restarting
# Docker, or any operation that causes downtime.
#
# Checks: pending HTLCs, active jobs, pending channels, container health.
# Exits 0 (GO) or 1 (WAIT) with a clear summary.
#
# Run ON THE VPS as butter.
#
# Usage:
#   ./preflight-check.sh          Interactive (shows details, waits for input)
#   ./preflight-check.sh --quiet  Non-interactive (exit code only, for scripting)
# =============================================================================
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lightning-common.sh"

QUIET=false
if [ "${1:-}" = "--quiet" ]; then
    QUIET=true
fi

BLOCKERS=0
WARNINGS=0

print_status() {
    local label="$1"
    local status="$2"  # ok, warn, block
    local detail="$3"

    if [ "$status" = "ok" ]; then
        echo "  [OK]    $label"
    elif [ "$status" = "warn" ]; then
        echo "  [WARN]  $label: $detail"
        WARNINGS=$((WARNINGS + 1))
    else
        echo "  [WAIT]  $label: $detail"
        BLOCKERS=$((BLOCKERS + 1))
    fi
}

if ! $QUIET; then
    echo "============================================"
    echo "  Pre-Maintenance Readiness Check"
    echo "============================================"
    echo ""
fi

# --- 1. Pending HTLCs (in-flight payments) ---
CHANNELS=$($LNCLI listchannels 2>/dev/null) || CHANNELS="{}"
HTLC_INFO=$(echo "$CHANNELS" | python3 -c "
import sys, json
data = json.load(sys.stdin)
channels = data.get('channels', [])
total = 0
details = []
for ch in channels:
    htlcs = ch.get('pending_htlcs', [])
    if htlcs:
        total += len(htlcs)
        peer = ch.get('remote_pubkey', '')[:16]
        total_sats = sum(int(h.get('amount', 0)) for h in htlcs)
        details.append(f'{peer}... ({len(htlcs)} HTLCs, {total_sats:,} sats)')
print(f'{total}')
for d in details:
    print(d)
" 2>/dev/null || echo "0")

HTLC_COUNT=$(echo "$HTLC_INFO" | head -1)
if [ "$HTLC_COUNT" = "0" ]; then
    print_status "Pending HTLCs" "ok" ""
else
    print_status "Pending HTLCs" "block" "$HTLC_COUNT in-flight payment(s)"
    if ! $QUIET; then
        echo "$HTLC_INFO" | tail -n +2 | while read -r line; do
            echo "          $line"
        done
    fi
fi

# --- 2. Active/pending jobs in the app ---
DB_PASS=$(cat "$HOME/.unsaltedbutter/db_password" 2>/dev/null || echo "")
if [ -n "$DB_PASS" ]; then
    JOB_COUNT=$(PGPASSWORD="$DB_PASS" psql -h localhost -U butter -d unsaltedbutter -tAc \
        "SELECT count(*) FROM jobs WHERE status IN ('active', 'pending');" 2>/dev/null || echo "?")
    JOB_COUNT=$(echo "$JOB_COUNT" | tr -d '[:space:]')

    if [ "$JOB_COUNT" = "?" ]; then
        print_status "Active jobs" "warn" "Could not query database"
    elif [ "$JOB_COUNT" = "0" ]; then
        print_status "Active jobs" "ok" ""
    else
        print_status "Active jobs" "block" "$JOB_COUNT active/pending job(s)"
        if ! $QUIET; then
            PGPASSWORD="$DB_PASS" psql -h localhost -U butter -d unsaltedbutter -c \
                "SELECT id, service_id, status, created_at FROM jobs WHERE status IN ('active', 'pending') ORDER BY created_at;" 2>/dev/null || true
        fi
    fi
else
    print_status "Active jobs" "warn" "DB password not found, skipping"
fi

# --- 3. Pending channels ---
PENDING=$($LNCLI pendingchannels 2>/dev/null) || PENDING="{}"
PENDING_COUNTS=$(echo "$PENDING" | python3 -c "
import sys, json
data = json.load(sys.stdin)
opening = len(data.get('pending_open_channels', []))
closing = len(data.get('pending_closing_channels', []))
force = len(data.get('pending_force_closing_channels', []))
waiting = len(data.get('waiting_close_channels', []))
total = opening + closing + force + waiting
parts = []
if opening: parts.append(f'{opening} opening')
if closing: parts.append(f'{closing} closing')
if force: parts.append(f'{force} force-closing')
if waiting: parts.append(f'{waiting} waiting close')
print(f'{total}')
print(', '.join(parts) if parts else '')
" 2>/dev/null || echo "0")

PENDING_TOTAL=$(echo "$PENDING_COUNTS" | head -1)
PENDING_DETAIL=$(echo "$PENDING_COUNTS" | tail -1)
if [ "$PENDING_TOTAL" = "0" ]; then
    print_status "Pending channels" "ok" ""
else
    print_status "Pending channels" "warn" "$PENDING_DETAIL"
fi

# --- 4. Docker containers ---
EXPECTED_CONTAINERS="btcpayserver lnd_bitcoin nbxplorer bitcoind"
RUNNING=$(sudo docker ps --format '{{.Names}}' 2>/dev/null || echo "")
MISSING=""
for name in $EXPECTED_CONTAINERS; do
    if ! echo "$RUNNING" | grep -q "$name"; then
        MISSING="$MISSING $name"
    fi
done

if [ -z "$MISSING" ]; then
    print_status "Docker containers" "ok" ""
else
    print_status "Docker containers" "block" "DOWN:$MISSING"
fi

# --- 5. LND sync status ---
INFO=$($LNCLI getinfo 2>/dev/null) || INFO="{}"
SYNCED=$(echo "$INFO" | python3 -c "
import sys, json
data = json.load(sys.stdin)
chain = str(data.get('synced_to_chain', False)).lower() == 'true'
graph = str(data.get('synced_to_graph', False)).lower() == 'true'
print('yes' if chain and graph else 'no')
" 2>/dev/null || echo "no")

if [ "$SYNCED" = "yes" ]; then
    print_status "LND sync" "ok" ""
else
    print_status "LND sync" "warn" "Not fully synced (chain or graph)"
fi

# --- 6. PM2 app status ---
if pm2 list 2>/dev/null | grep -q "online"; then
    print_status "PM2 app" "ok" ""
else
    print_status "PM2 app" "warn" "Not running"
fi

# --- Verdict ---
echo ""

if [ "$BLOCKERS" -gt 0 ]; then
    echo "Result: WAIT ($BLOCKERS blocker(s), $WARNINGS warning(s))"
    echo ""
    echo "  There are in-flight payments or active jobs. Wait for them to"
    echo "  complete before proceeding with maintenance."
    if ! $QUIET; then
        echo ""
        echo "  Re-run this check in a few minutes:"
        echo "    $SCRIPT_DIR/preflight-check.sh"
    fi
    exit 1
elif [ "$WARNINGS" -gt 0 ]; then
    echo "Result: GO (with $WARNINGS warning(s))"
    echo ""
    echo "  No blockers, but review warnings above."
    exit 0
else
    echo "Result: GO"
    echo ""
    echo "  All clear. Safe to proceed with maintenance."
    exit 0
fi
