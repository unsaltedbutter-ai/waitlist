#!/bin/bash
# Daily cron: trigger job scheduling via /api/cron/daily.
# Reads CRON_SECRET from .env.production so it never appears in the crontab.
# Cron: 0 10 * * * /home/butter/unsaltedbutter/scripts/cron-daily.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$SCRIPT_DIR/../web/.env.production"

if [[ ! -f "$ENV_FILE" ]]; then
    echo "$(date): ERROR: $ENV_FILE not found" >&2
    exit 1
fi

CRON_SECRET=$(grep '^CRON_SECRET=' "$ENV_FILE" | cut -d= -f2)
if [[ -z "$CRON_SECRET" ]]; then
    echo "$(date): ERROR: CRON_SECRET not set in $ENV_FILE" >&2
    exit 1
fi

/usr/bin/curl -s -f -X POST \
    -H "Authorization: Bearer ${CRON_SECRET}" \
    http://localhost:3000/api/cron/daily
