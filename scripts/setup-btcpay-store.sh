#!/usr/bin/env bash
# =============================================================================
# setup-btcpay-store.sh — Configure BTCPay store, Lightning, API key, webhook
#
# Run ON THE VPS as butter:
#   ./setup-btcpay-store.sh --password YOUR_BTCPAY_PASSWORD
#
# Prerequisites:
#   - BTCPay admin account created at https://pay.unsaltedbutter.ai
#   - A store created in the BTCPay UI
#   - Email: info@unsaltedbutter.ai
# =============================================================================
set -euo pipefail

BTCPAY_URL="https://pay.unsaltedbutter.ai"
BTCPAY_EMAIL="info@unsaltedbutter.ai"
ENV_FILE="/home/butter/unsaltedbutter/web/.env.production"
read -rsp "BTCPay password for ${BTCPAY_EMAIL}: " PASSWORD
echo ""

if [[ -z "$PASSWORD" ]]; then
    echo "ERROR: Password cannot be empty."
    exit 1
fi

echo ""
echo "================================================"
echo "  BTCPay Store Setup"
echo "================================================"
echo ""

# --- 1. Find the store ---
echo "[1/5] Finding store..."
STORES_RAW=$(curl -sf -u "${BTCPAY_EMAIL}:${PASSWORD}" "${BTCPAY_URL}/api/v1/stores" 2>&1) || {
    echo "ERROR: Could not connect or authenticate."
    echo "  - Is ${BTCPAY_URL} reachable?"
    echo "  - Is the password correct for ${BTCPAY_EMAIL}?"
    exit 1
}

STORE_ID=$(echo "$STORES_RAW" | python3 -c "import sys,json; s=json.load(sys.stdin); print(s[0]['id'])" 2>/dev/null) || {
    echo "ERROR: No stores found. Create a store in the BTCPay UI first."
    exit 1
}
STORE_NAME=$(echo "$STORES_RAW" | python3 -c "import sys,json; s=json.load(sys.stdin); print(s[0]['name'])" 2>/dev/null)
echo "  Store: ${STORE_NAME} (${STORE_ID})"

# --- 2. Connect Lightning (internal LND node) ---
echo "[2/5] Connecting Lightning (internal LND node)..."
LN_BODY=$(curl -sf -u "${BTCPAY_EMAIL}:${PASSWORD}" \
    -X PUT \
    -H "Content-Type: application/json" \
    -d '{"enabled":true,"connectionString":"Internal Node"}' \
    "${BTCPAY_URL}/api/v1/stores/${STORE_ID}/payment-methods/BTC-LN" 2>&1) && {
    echo "  Lightning connected (BTC-LN)"
} || {
    # Try legacy endpoint
    LN_BODY=$(curl -sf -u "${BTCPAY_EMAIL}:${PASSWORD}" \
        -X PUT \
        -H "Content-Type: application/json" \
        -d '{"enabled":true,"connectionString":"Internal Node"}' \
        "${BTCPAY_URL}/api/v1/stores/${STORE_ID}/payment-methods/BTC_LightningNetwork" 2>&1) && {
        echo "  Lightning connected (legacy endpoint)"
    } || {
        echo "  WARNING: Could not auto-connect Lightning."
        echo "  Go to Store → Settings → Lightning → Use internal node"
        echo "  Continuing anyway..."
    }
}

# --- 3. Create API key ---
echo "[3/5] Creating API key..."
APIKEY_RAW=$(curl -sf -u "${BTCPAY_EMAIL}:${PASSWORD}" \
    -X POST \
    -H "Content-Type: application/json" \
    -d "{
        \"label\": \"unsaltedbutter-web\",
        \"permissions\": [
            \"btcpay.store.cancreateinvoice:${STORE_ID}\",
            \"btcpay.store.canviewinvoices:${STORE_ID}\",
            \"btcpay.store.canmodifyinvoices:${STORE_ID}\"
        ]
    }" \
    "${BTCPAY_URL}/api/v1/api-keys" 2>&1) || {
    echo "ERROR: Failed to create API key."
    exit 1
}

API_KEY=$(echo "$APIKEY_RAW" | python3 -c "import sys,json; print(json.load(sys.stdin)['apiKey'])" 2>/dev/null) || {
    echo "ERROR: Unexpected API key response: ${APIKEY_RAW}"
    exit 1
}
echo "  API key: ${API_KEY:0:12}..."

# --- 4. Create webhook ---
echo "[4/5] Creating webhook..."
WEBHOOK_SECRET=$(openssl rand -hex 32)

WH_RAW=$(curl -sf -u "${BTCPAY_EMAIL}:${PASSWORD}" \
    -X POST \
    -H "Content-Type: application/json" \
    -d "{
        \"url\": \"https://unsaltedbutter.ai/api/credits/webhook\",
        \"secret\": \"${WEBHOOK_SECRET}\",
        \"enabled\": true,
        \"automaticRedelivery\": true,
        \"authorizedEvents\": {
            \"everything\": false,
            \"specificEvents\": [\"InvoiceSettled\"]
        }
    }" \
    "${BTCPAY_URL}/api/v1/stores/${STORE_ID}/webhooks" 2>&1) && {
    WH_ID=$(echo "$WH_RAW" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])" 2>/dev/null)
    echo "  Webhook created (ID: ${WH_ID})"
    echo "  URL: https://unsaltedbutter.ai/api/credits/webhook"
    echo "  Event: InvoiceSettled"
} || {
    echo "  WARNING: Webhook creation failed. Create manually in BTCPay UI:"
    echo "    URL:    https://unsaltedbutter.ai/api/credits/webhook"
    echo "    Secret: ${WEBHOOK_SECRET}"
    echo "    Event:  InvoiceSettled"
}

# --- 5. Update .env.production ---
echo "[5/5] Updating .env.production..."

if [[ ! -f "$ENV_FILE" ]]; then
    echo "ERROR: ${ENV_FILE} not found."
    exit 1
fi

# Back up first
cp "$ENV_FILE" "${ENV_FILE}.bak.$(date +%s)"

sed -i "s|^BTCPAY_API_KEY=.*|BTCPAY_API_KEY=${API_KEY}|" "$ENV_FILE"
sed -i "s|^BTCPAY_STORE_ID=.*|BTCPAY_STORE_ID=${STORE_ID}|" "$ENV_FILE"
sed -i "s|^BTCPAY_WEBHOOK_SECRET=.*|BTCPAY_WEBHOOK_SECRET=${WEBHOOK_SECRET}|" "$ENV_FILE"

echo "  .env.production updated (backup saved)"

# --- 6. Restart PM2 ---
echo ""
echo "Restarting Next.js..."
cd /home/butter/unsaltedbutter/web && pm2 restart unsaltedbutter
sleep 3

echo ""
echo "================================================"
echo "  Setup Complete"
echo "================================================"
echo ""
echo "  Store ID:       ${STORE_ID}"
echo "  API Key:        ${API_KEY:0:12}..."
echo "  Webhook Secret: ${WEBHOOK_SECRET:0:12}..."
echo ""
echo "  NOTE: Lightning invoices won't work until Bitcoin sync completes."
echo "  Check sync progress:"
echo "    sudo docker exec \$(sudo docker ps -q -f name=bitcoind) bitcoin-cli getblockchaininfo 2>&1 | grep verificationprogress"
echo ""
