#!/usr/bin/env bash
# =============================================================================
# insert-signup-webtest.sh
#
# Deletes the webtest user (if present), inserts a fresh waitlist entry
# with an invite code, and prints the signup URL.
#
# Usage:
#   ./scripts/insert-signup-webtest.sh --dev
#   ./scripts/insert-signup-webtest.sh --prod
# =============================================================================
set -eu

TEST_EMAIL="webtest@test.unsaltedbutter.ai"

# Generate a 12-char alphanumeric invite code (matches nanoid format in app)
INVITE_CODE=$(LC_ALL=C tr -dc 'A-Z0-9' </dev/urandom | head -c 12)

if [ "${1:-}" = "--dev" ]; then
    PSQL="psql -h 192.168.5.188 -U butter -d unsaltedbutter"
    BASE_URL="http://localhost:3000"
elif [ "${1:-}" = "--prod" ]; then
    PSQL="sudo -u postgres psql -d unsaltedbutter"
    BASE_URL="https://unsaltedbutter.ai"
else
    echo "Usage: $0 --dev | --prod"
    exit 1
fi

echo "Cleaning up existing test user..."

$PSQL -c "
  -- Delete user (CASCADE removes creds, queue, payments, consents, etc.)
  DELETE FROM users WHERE email = '$TEST_EMAIL';

  -- Delete any waitlist entries for this email
  DELETE FROM waitlist WHERE email = '$TEST_EMAIL';
"

echo "Inserting waitlist entry with invite code $INVITE_CODE..."

$PSQL -c "
  INSERT INTO waitlist (email, invited, invited_at, invite_code)
  VALUES ('$TEST_EMAIL', TRUE, NOW(), '$INVITE_CODE');
"

echo ""
echo "Done. Invite code: ${INVITE_CODE}"
echo "Sign up at: ${BASE_URL}/login"
echo ""
echo "Email: ${TEST_EMAIL}"
