#!/usr/bin/env bash
# =============================================================================
# test-e2e-onboarding.sh
#
# End-to-end onboarding test: signup -> login -> create invoice -> pay -> verify
# Run ON THE VPS as butter.
#
# Prerequisites:
#   - Next.js app running (PM2)
#   - BTCPay Server running and synchronized
#   - Lightning channel active and graph synced
#   - .env.production configured with BTCPay credentials
#
# Usage:
#   ./scripts/test-e2e-onboarding.sh
#
# This creates a real BTCPay invoice. You pay it from a Lightning wallet,
# then press ENTER to verify the webhook fired and membership activated.
# Cleanup commands are printed at the end.
# =============================================================================
set -euo pipefail

APP_DIR="/home/butter/unsaltedbutter/web"
ENV_FILE="$APP_DIR/.env.production"
API="http://localhost:3000"

# Load env vars
BTCPAY_URL=$(grep '^BTCPAY_URL=' "$ENV_FILE" | cut -d= -f2-)
BTCPAY_API_KEY=$(grep '^BTCPAY_API_KEY=' "$ENV_FILE" | cut -d= -f2-)
BTCPAY_STORE_ID=$(grep '^BTCPAY_STORE_ID=' "$ENV_FILE" | cut -d= -f2-)

TEST_EMAIL="e2etest_$(date +%s)@test.unsaltedbutter.ai"
TEST_PASSWORD="TestPass123!"
INVITE_CODE="E2ETEST$(date +%s | tail -c 7)"

echo "============================================"
echo "  E2E Onboarding Test"
echo "============================================"
echo ""
echo "Test email:   $TEST_EMAIL"
echo "Invite code:  $INVITE_CODE"
echo ""

# --- Step 1: Create invite code in DB ---
echo "=== Step 1: Create invite code ==="
sudo -u postgres psql -d unsaltedbutter -tAc \
  "INSERT INTO waitlist (email, invited, invited_at, invite_code, redeemed_at)
   VALUES ('$TEST_EMAIL', TRUE, NOW(), '$INVITE_CODE', NULL)" > /dev/null
echo "PASS: Invite code '$INVITE_CODE' created in waitlist"
echo ""

# --- Step 2: Sign up ---
echo "=== Step 2: Sign up ==="
SIGNUP_RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$API/api/auth/signup" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$TEST_EMAIL\",\"password\":\"$TEST_PASSWORD\",\"inviteCode\":\"$INVITE_CODE\"}")

SIGNUP_CODE=$(echo "$SIGNUP_RESPONSE" | tail -1)
SIGNUP_BODY=$(echo "$SIGNUP_RESPONSE" | head -n -1)

echo "HTTP $SIGNUP_CODE"
echo "$SIGNUP_BODY" | python3 -m json.tool 2>/dev/null || echo "$SIGNUP_BODY"

if [ "$SIGNUP_CODE" != "201" ]; then
  echo "FAIL: Signup returned $SIGNUP_CODE"
  exit 1
fi

TOKEN=$(echo "$SIGNUP_BODY" | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")
USER_ID=$(echo "$SIGNUP_BODY" | python3 -c "import sys,json; print(json.load(sys.stdin)['userId'])")
echo "PASS: Signed up. userId=$USER_ID"
echo ""

# --- Step 3: Login (verify needsOnboarding) ---
echo "=== Step 3: Login (check needsOnboarding) ==="
LOGIN_RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$API/api/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$TEST_EMAIL\",\"password\":\"$TEST_PASSWORD\"}")

LOGIN_CODE=$(echo "$LOGIN_RESPONSE" | tail -1)
LOGIN_BODY=$(echo "$LOGIN_RESPONSE" | head -n -1)

echo "HTTP $LOGIN_CODE"
echo "$LOGIN_BODY" | python3 -m json.tool 2>/dev/null || echo "$LOGIN_BODY"

NEEDS_ONBOARDING=$(echo "$LOGIN_BODY" | python3 -c "import sys,json; print(json.load(sys.stdin).get('needsOnboarding', False))" 2>/dev/null || echo "unknown")
if [ "$NEEDS_ONBOARDING" = "True" ]; then
  echo "PASS: needsOnboarding=true (no paid membership yet)"
else
  echo "WARN: needsOnboarding=$NEEDS_ONBOARDING (expected True)"
fi
echo ""

# --- Step 4: Create membership invoice ---
echo "=== Step 4: Create membership invoice (solo monthly, 4400 sats) ==="
PREPAY_RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$API/api/credits/prepay" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"membership_plan":"solo","billing_period":"monthly","amount_sats":4400}')

PREPAY_CODE=$(echo "$PREPAY_RESPONSE" | tail -1)
PREPAY_BODY=$(echo "$PREPAY_RESPONSE" | head -n -1)

echo "HTTP $PREPAY_CODE"
echo "$PREPAY_BODY" | python3 -m json.tool 2>/dev/null || echo "$PREPAY_BODY"

if [ "$PREPAY_CODE" != "201" ]; then
  echo "FAIL: Prepay returned $PREPAY_CODE"
  exit 1
fi

INVOICE_ID=$(echo "$PREPAY_BODY" | python3 -c "import sys,json; print(json.load(sys.stdin)['invoiceId'])")
CHECKOUT_LINK=$(echo "$PREPAY_BODY" | python3 -c "import sys,json; print(json.load(sys.stdin)['checkoutLink'])")
echo "PASS: Invoice created. ID=$INVOICE_ID"
echo ""

# --- Step 5: Fetch Lightning bolt11 from BTCPay ---
echo "=== Step 5: Fetch Lightning invoice ==="
sleep 2

BOLT11_RESPONSE=$(curl -s \
  "$BTCPAY_URL/api/v1/stores/$BTCPAY_STORE_ID/invoices/$INVOICE_ID/payment-methods" \
  -H "Authorization: token $BTCPAY_API_KEY")

BOLT11=$(echo "$BOLT11_RESPONSE" | python3 -c "
import sys, json
methods = json.load(sys.stdin)
for m in methods:
    if m.get('paymentMethodId') in ('BTC-LN', 'BTC-LightningNetwork'):
        dest = m.get('destination', '')
        if dest:
            print(dest)
            break
" 2>/dev/null || echo "")

if [ -n "$BOLT11" ]; then
  echo "PASS: Lightning invoice retrieved"
  echo ""
  echo "============================================"
  echo "  PAY THIS FROM YOUR LIGHTNING WALLET"
  echo "============================================"
  echo ""
  echo "$BOLT11"
  echo ""
  echo "Checkout link (browser fallback): $CHECKOUT_LINK"
else
  echo "WARN: Could not extract bolt11. Use checkout link instead:"
  echo "  $CHECKOUT_LINK"
  echo ""
  echo "BTCPay response:"
  echo "$BOLT11_RESPONSE" | python3 -m json.tool 2>/dev/null || echo "$BOLT11_RESPONSE"
fi

echo ""
echo "============================================"
echo "  Waiting for payment..."
echo "============================================"
echo ""
echo "After paying, press ENTER to verify."
read -r

# --- Step 6: Verify payment and membership activation ---
echo "=== Step 6: Verify payment ==="

MP_STATUS=$(sudo -u postgres psql -d unsaltedbutter -tAc \
  "SELECT status FROM membership_payments WHERE btcpay_invoice_id = '$INVOICE_ID'" | head -1 | tr -d '[:space:]')
echo "membership_payments status: $MP_STATUS"

if [ "$MP_STATUS" = "paid" ]; then
  echo "PASS: Payment recorded"
else
  echo "FAIL: Expected 'paid', got '$MP_STATUS'"
  echo ""
  echo "Debug:"
  echo "  pm2 logs unsaltedbutter --lines 50"
  echo "  curl -s '$BTCPAY_URL/api/v1/stores/$BTCPAY_STORE_ID/invoices/$INVOICE_ID' -H 'Authorization: token $BTCPAY_API_KEY' | python3 -m json.tool"
fi

echo ""
USER_STATUS=$(sudo -u postgres psql -d unsaltedbutter -tAc \
  "SELECT membership_plan, billing_period, status, membership_expires_at
   FROM users WHERE id = '$USER_ID'" | head -1)
echo "User record: $USER_STATUS"

echo ""
echo "=== Step 7: Login again (verify onboarding complete) ==="
LOGIN2_RESPONSE=$(curl -s -X POST "$API/api/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$TEST_EMAIL\",\"password\":\"$TEST_PASSWORD\"}")

NEEDS_ONBOARDING2=$(echo "$LOGIN2_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('needsOnboarding', False))" 2>/dev/null || echo "unknown")
echo "needsOnboarding: $NEEDS_ONBOARDING2"
if [ "$NEEDS_ONBOARDING2" = "False" ]; then
  echo "PASS: Onboarding complete"
else
  echo "FAIL: Still showing needsOnboarding=$NEEDS_ONBOARDING2"
fi

echo ""
echo "============================================"
echo "  Cleanup"
echo "============================================"
echo "To remove test data:"
echo "  sudo -u postgres psql -d unsaltedbutter -c \"DELETE FROM membership_payments WHERE user_id = '$USER_ID';\""
echo "  sudo -u postgres psql -d unsaltedbutter -c \"DELETE FROM users WHERE id = '$USER_ID';\""
echo "  sudo -u postgres psql -d unsaltedbutter -c \"DELETE FROM waitlist WHERE invite_code = '$INVITE_CODE';\""
