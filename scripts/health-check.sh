#!/bin/bash
# Health check: disk, memory, Docker containers, PM2, nginx.
# Cron: */15 * * * * /home/butter/unsaltedbutter/scripts/health-check.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ALERT="$HOME/venvs/update-checker/bin/python $SCRIPT_DIR/nostr-alert.py"

LOG="$HOME/logs/health.log"
mkdir -p "$HOME/logs"

# Disk usage
DISK_USAGE=$(df / | tail -1 | awk '{print $5}' | tr -d '%')
if [ "$DISK_USAGE" -gt 85 ]; then
    echo "$(date): ALERT disk at ${DISK_USAGE}%" >> "$LOG"
    $ALERT --key disk-high "VPS disk at ${DISK_USAGE}%" 2>/dev/null || true
fi

# Memory
MEM_USAGE=$(free | awk '/Mem:/ {printf("%.0f", $3/$2 * 100)}')
if [ "$MEM_USAGE" -gt 90 ]; then
    echo "$(date): ALERT memory at ${MEM_USAGE}%" >> "$LOG"
    $ALERT --key memory-high "VPS memory at ${MEM_USAGE}%" 2>/dev/null || true
fi

# Check critical Docker containers
for name in btcpayserver lnd_bitcoin nbxplorer bitcoind; do
    if ! sudo docker ps --format '{{.Names}}' | grep -q "$name"; then
        echo "$(date): ALERT container $name is DOWN" >> "$LOG"
        $ALERT --key "container-${name}" --cooldown 1 "VPS container $name is DOWN" 2>/dev/null || true
    fi
done

# Check PM2
if ! pm2 list 2>/dev/null | grep -q "online"; then
    echo "$(date): ALERT PM2 app not online" >> "$LOG"
    $ALERT --key pm2-down "VPS PM2 app not online" 2>/dev/null || true
fi

# Check nginx
if ! systemctl is-active --quiet nginx; then
    echo "$(date): ALERT nginx is down" >> "$LOG"
    $ALERT --key nginx-down "VPS nginx is down" 2>/dev/null || true
fi
