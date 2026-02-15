#!/usr/bin/env bash
# deploy-schema.sh — One-time schema deployment for UnsaltedButter production DB.
# Drops all tables and recreates from scratch.
#
# SELF-DESTRUCTING: This script deletes itself after successful execution.
# It is NOT safe to run if you have real user data.
#
# Usage (on VPS):
#   chmod +x scripts/deploy-schema.sh
#   ./scripts/deploy-schema.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCHEMA_FILE="$SCRIPT_DIR/schema.sql"
DB_NAME="unsaltedbutter"
DB_USER="butter"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo ""
echo -e "${YELLOW}╔══════════════════════════════════════════════════╗${NC}"
echo -e "${YELLOW}║  UnsaltedButter — One-Time Schema Deployment    ║${NC}"
echo -e "${YELLOW}╚══════════════════════════════════════════════════╝${NC}"
echo ""

# --- Preflight checks ---

if [ ! -f "$SCHEMA_FILE" ]; then
  echo -e "${RED}FATAL: schema.sql not found at $SCHEMA_FILE${NC}"
  exit 1
fi

# Check if the users table exists and has rows
USER_COUNT=$(psql -U "$DB_USER" -d "$DB_NAME" -tAc \
  "SELECT count(*) FROM users;" 2>/dev/null || echo "0")

if [ "$USER_COUNT" -gt 0 ]; then
  echo -e "${RED}ABORT: Found $USER_COUNT user(s) in the database.${NC}"
  echo -e "${RED}This script drops all tables. Refusing to run with existing users.${NC}"
  echo -e "${RED}If you really mean it, manually DROP the users table first.${NC}"
  exit 1
fi

echo -e "Database:  ${GREEN}$DB_NAME${NC}"
echo -e "User:      ${GREEN}$DB_USER${NC}"
echo -e "Schema:    ${GREEN}$SCHEMA_FILE${NC}"
echo -e "Users:     ${GREEN}0 (safe to proceed)${NC}"
echo ""
echo -e "${YELLOW}This will DROP all tables and recreate the schema from scratch.${NC}"
read -rp "Type YES to confirm: " CONFIRM

if [ "$CONFIRM" != "YES" ]; then
  echo "Aborted."
  exit 1
fi

echo ""
echo "Deploying schema..."
psql -U "$DB_USER" -d "$DB_NAME" -f "$SCHEMA_FILE"

echo ""
echo -e "${GREEN}Schema deployed successfully.${NC}"

# Verify tables exist
TABLE_COUNT=$(psql -U "$DB_USER" -d "$DB_NAME" -tAc \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public';")
echo -e "Tables created: ${GREEN}$TABLE_COUNT${NC}"

# Self-destruct
echo ""
echo -e "${YELLOW}Self-destructing deploy script...${NC}"
rm -f "$0"
echo -e "${GREEN}Done. This script no longer exists.${NC}"
