#!/usr/bin/env bash
# invite-npub.sh: Create a waitlist invite for an npub.
#   Usage: invite-npub.sh <npub1...> [--operator]
#
# Without --operator: inserts/promotes a waitlist entry with invited=TRUE.
# With --operator:    also creates the user row and sets OPERATOR_USER_ID
#                     in web/.env.production (if not already set to a valid user).
#
# Run on VPS: /home/butter/unsaltedbutter/scripts/invite-npub.sh npub1... [--operator]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
ENV_FILE="${PROJECT_DIR}/web/.env.production"
DB_PASS="$(cat /home/butter/.unsaltedbutter/db_password)"

export PGPASSWORD="${DB_PASS}"

run_sql() {
    psql -h localhost -U butter -d unsaltedbutter -tAc "$1" | head -1 | tr -d '[:space:]'
}

# ── Args ──────────────────────────────────────────────────────

NPUB=""
OPERATOR=false

for arg in "$@"; do
    case "$arg" in
        --operator) OPERATOR=true ;;
        npub1*)     NPUB="$arg" ;;
        *)          echo "Unknown arg: $arg"; exit 1 ;;
    esac
done

if [[ -z "$NPUB" ]]; then
    echo "Usage: $0 <npub1...> [--operator]"
    exit 1
fi

# ── Convert npub to hex (pure python3, no dependencies) ──────

NPUB_HEX=$(python3 -c "
CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
def bech32_decode(bech):
    data = [CHARSET.find(c) for c in bech[bech.index('1')+1:]]
    if -1 in data:
        return None
    # strip checksum (last 6)
    data = data[:-6]
    # convert 5-bit groups to 8-bit
    acc, bits, out = 0, 0, []
    for v in data:
        acc = (acc << 5) | v
        bits += 5
        while bits >= 8:
            bits -= 8
            out.append((acc >> bits) & 0xff)
    return bytes(out)
raw = bech32_decode('${NPUB}')
if raw is None:
    raise ValueError('invalid bech32')
print(raw.hex())
")
if [[ -z "$NPUB_HEX" ]]; then
    echo "ERROR: Could not parse npub. Is it valid?"
    exit 1
fi
echo "npub hex: ${NPUB_HEX}"

# ── Check if already a paid member ───────────────────────────

EXISTING_USER=$(run_sql "SELECT id FROM users WHERE nostr_npub = '${NPUB_HEX}'" || true)
if [[ -n "$EXISTING_USER" ]]; then
    HAS_PAID=$(run_sql "SELECT COUNT(*) FROM membership_payments WHERE user_id = '${EXISTING_USER}' AND status = 'paid'" || true)
    if [[ "${HAS_PAID:-0}" -gt 0 ]]; then
        echo "User ${NPUB_HEX:0:16}... is already a paid member (${EXISTING_USER}). Nothing to do."
        exit 0
    fi
    echo "User exists but hasn't paid: ${EXISTING_USER}"
fi

# ── Waitlist logic ───────────────────────────────────────────

INVITE_CODE=$(openssl rand -hex 6 | tr '[:lower:]' '[:upper:]')

WAITLIST_ROW=$(run_sql "SELECT id || '|' || invited FROM waitlist WHERE nostr_npub = '${NPUB_HEX}'" || true)
if [[ -n "$WAITLIST_ROW" ]]; then
    WL_ID=$(echo "$WAITLIST_ROW" | cut -d'|' -f1)
    WL_INVITED=$(echo "$WAITLIST_ROW" | cut -d'|' -f2)
    if [[ "$WL_INVITED" == "t" ]]; then
        EXISTING_CODE=$(run_sql "SELECT invite_code FROM waitlist WHERE id = '${WL_ID}'" || true)
        echo "Already invited (code: ${EXISTING_CODE}). Skipping waitlist update."
    else
        run_sql "UPDATE waitlist SET invited = TRUE, invite_code = '${INVITE_CODE}', invite_dm_pending = TRUE WHERE id = '${WL_ID}'" >/dev/null
        echo "Promoted waitlist entry to invited (code: ${INVITE_CODE})"
    fi
else
    run_sql "INSERT INTO waitlist (nostr_npub, invited, invite_code, invite_dm_pending) VALUES ('${NPUB_HEX}', TRUE, '${INVITE_CODE}', TRUE)" >/dev/null
    echo "Created waitlist invite (code: ${INVITE_CODE})"
fi

# ── Operator mode ────────────────────────────────────────────

if $OPERATOR; then
    # Create user row if not exists
    if [[ -z "$EXISTING_USER" ]]; then
        EXISTING_USER=$(run_sql "INSERT INTO users (nostr_npub, status, membership_plan, billing_period) VALUES ('${NPUB_HEX}', 'active', 'solo', 'monthly') RETURNING id")
        if [[ -z "$EXISTING_USER" ]]; then
            echo "ERROR: Failed to create user row"
            exit 1
        fi
        echo "Created user row: ${EXISTING_USER}"
    fi

    # Bootstrap membership so operator skips onboarding
    HAS_BOOTSTRAP=$(run_sql "SELECT COUNT(*) FROM membership_payments WHERE user_id = '${EXISTING_USER}' AND btcpay_invoice_id = 'OPERATOR_BOOTSTRAP'" || true)
    if [[ "${HAS_BOOTSTRAP:-0}" -eq 0 ]]; then
        run_sql "INSERT INTO membership_payments (user_id, btcpay_invoice_id, amount_sats, amount_usd_cents, period_start, period_end, status) VALUES ('${EXISTING_USER}', 'OPERATOR_BOOTSTRAP', 0, 0, NOW(), '2099-12-31', 'paid') ON CONFLICT (btcpay_invoice_id) DO NOTHING" >/dev/null
        run_sql "UPDATE users SET membership_expires_at = '2099-12-31' WHERE id = '${EXISTING_USER}'" >/dev/null
        run_sql "INSERT INTO service_credits (user_id, credit_sats) VALUES ('${EXISTING_USER}', 0) ON CONFLICT (user_id) DO NOTHING" >/dev/null
        echo "Bootstrapped operator membership (expires 2099-12-31)"
    else
        echo "Operator membership already bootstrapped."
    fi

    # Check current OPERATOR_USER_ID
    CURRENT_OP=$(sed -n 's/^OPERATOR_USER_ID=//p' "$ENV_FILE" 2>/dev/null || true)
    if [[ -n "$CURRENT_OP" ]]; then
        OP_EXISTS=$(run_sql "SELECT COUNT(*) FROM users WHERE id = '${CURRENT_OP}'" || true)
        if [[ "${OP_EXISTS:-0}" -gt 0 ]]; then
            echo "OPERATOR_USER_ID already set to valid user: ${CURRENT_OP}"
            echo "Not overwriting. Edit ${ENV_FILE} manually if you want to change it."
            exit 0
        fi
        echo "Current OPERATOR_USER_ID (${CURRENT_OP}) not found in DB. Replacing."
    fi

    # Update .env.production
    if grep -q '^OPERATOR_USER_ID=' "$ENV_FILE" 2>/dev/null; then
        sed -i "s/^OPERATOR_USER_ID=.*/OPERATOR_USER_ID=${EXISTING_USER}/" "$ENV_FILE"
    else
        echo "OPERATOR_USER_ID=${EXISTING_USER}" >> "$ENV_FILE"
    fi
    echo "Set OPERATOR_USER_ID=${EXISTING_USER} in ${ENV_FILE}"
    echo ""
    echo "Restart the app to pick up the change:"
    echo "  pm2 restart unsaltedbutter"
fi

echo ""
echo "Done. User can now DM 'login' to ButterBot and enter the OTP on the site."
