#!/bin/bash
# Daily backup: app PG, BTCPay PG, LND SCB, nginx config.
# Cron: 0 3 * * * /home/butter/unsaltedbutter/scripts/backup-daily.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BACKUP_DIR="$HOME/backups"
DATE=$(date +%Y%m%d_%H%M%S)
mkdir -p "$BACKUP_DIR"

# App PostgreSQL
DB_PASS=$(cat "$HOME/.unsaltedbutter/db_password")
PGPASSWORD="$DB_PASS" pg_dump -h localhost -U butter unsaltedbutter | gzip > "$BACKUP_DIR/pg_app_${DATE}.sql.gz"

# BTCPay PostgreSQL
BTCPAY_PG=$(sudo docker ps --format '{{.Names}}' | grep 'generated_postgres' | head -1)
if [ -n "$BTCPAY_PG" ]; then
    sudo docker exec "$BTCPAY_PG" pg_dumpall -U postgres 2>/dev/null | gzip > "$BACKUP_DIR/pg_btcpay_${DATE}.sql.gz"
fi

# LND SCB
"$SCRIPT_DIR/backup-scb.sh"

# nginx config
tar czf "$BACKUP_DIR/nginx_${DATE}.tar.gz" -C / etc/nginx/ 2>/dev/null || true

# Prune backups older than 14 days
find "$BACKUP_DIR" -type f -mtime +14 -delete 2>/dev/null || true

chmod 600 "$BACKUP_DIR"/* 2>/dev/null || true
