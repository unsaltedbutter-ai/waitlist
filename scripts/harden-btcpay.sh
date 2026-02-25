#!/usr/bin/env bash
# =============================================================================
# harden-btcpay.sh — Rotate API key + disable registration
#
# Run ON THE VPS as butter:
#   ./harden-btcpay.sh
# =============================================================================
set -euo pipefail

BTCPAY_URL="https://pay.unsaltedbutter.ai"
read -rp "BTCPay admin email: " BTCPAY_EMAIL
ENV_FILE="/home/butter/unsaltedbutter/web/.env.production"

read -rsp "BTCPay password for ${BTCPAY_EMAIL}: " PASSWORD
echo ""

STORE_ID=$(grep '^BTCPAY_STORE_ID=' "$ENV_FILE" | cut -d= -f2)
OLD_KEY=$(grep '^BTCPAY_API_KEY=' "$ENV_FILE" | cut -d= -f2)

echo ""
echo "Store: $STORE_ID"
echo "Old key: ${OLD_KEY:0:12}..."
echo ""

# --- 1. Disable public registration ---
echo "[1/4] Disabling public registration..."
REG_RESULT=$(curl -sf -u "${BTCPAY_EMAIL}:${PASSWORD}" \
    -X PUT \
    -H "Content-Type: application/json" \
    -d '{"policies":{"AllowNewUserRegistration":false}}' \
    "${BTCPAY_URL}/api/v1/server/info" 2>&1) && {
    echo "  Registration disabled via server info endpoint"
} || {
    # Try the settings endpoint instead
    curl -sf -u "${BTCPAY_EMAIL}:${PASSWORD}" \
        -X PUT \
        -H "Content-Type: application/json" \
        -d '{"policies":{"AllowNewUserRegistration":false}}' \
        "${BTCPAY_URL}/api/v1/server/policies" > /dev/null 2>&1 && {
        echo "  Registration disabled via policies endpoint"
    } || {
        echo "  WARNING: Could not disable registration via API."
        echo "  Do it manually: Server Settings > Policies > Disable registration"
    }
}

# --- 2. Create new API key with correct permissions ---
echo "[2/4] Creating new API key..."
NEW_KEY_RAW=$(curl -sf -u "${BTCPAY_EMAIL}:${PASSWORD}" \
    -X POST \
    -H "Content-Type: application/json" \
    -d "{
        \"label\": \"unsaltedbutter-web-v2\",
        \"permissions\": [
            \"btcpay.store.cancreateinvoice:${STORE_ID}\",
            \"btcpay.store.canviewinvoices:${STORE_ID}\",
            \"btcpay.store.canuselightningnode:${STORE_ID}\"
        ]
    }" \
    "${BTCPAY_URL}/api/v1/api-keys" 2>&1) || {
    echo "ERROR: Failed to create new API key. Check password."
    exit 1
}

NEW_KEY=$(echo "$NEW_KEY_RAW" | python3 -c "import sys,json; print(json.load(sys.stdin)['apiKey'])")
echo "  New key: ${NEW_KEY:0:12}..."
echo "  Permissions: cancreateinvoice, canviewinvoices, canuselightningnode"

# --- 3. Revoke old API key ---
echo "[3/4] Revoking old API key..."
# Get the key ID for the old key
OLD_KEY_ID=$(curl -sf -H "Authorization: token ${OLD_KEY}" \
    "${BTCPAY_URL}/api/v1/api-keys/current" | python3 -c "import sys,json; print(json.load(sys.stdin)['apiKey'])")

curl -sf -u "${BTCPAY_EMAIL}:${PASSWORD}" \
    -X DELETE \
    "${BTCPAY_URL}/api/v1/api-keys/${OLD_KEY_ID}" > /dev/null 2>&1 && {
    echo "  Old key revoked"
} || {
    echo "  WARNING: Could not revoke old key. Revoke manually in BTCPay UI."
    echo "  Account > API Keys > delete 'unsaltedbutter-web'"
}

# --- 4. Update .env.production ---
echo "[4/4] Updating .env.production..."
cp "$ENV_FILE" "${ENV_FILE}.bak.$(date +%s)"
sed -i "s|^BTCPAY_API_KEY=.*|BTCPAY_API_KEY=${NEW_KEY}|" "$ENV_FILE"
echo "  .env.production updated"

# Restart PM2
echo ""
echo "Restarting Next.js..."
cd /home/butter/unsaltedbutter/web && pm2 restart unsaltedbutter
sleep 3

echo ""
echo "Done. New key: ${NEW_KEY:0:12}..."
echo "Old key revoked. Registration disabled."
