#!/bin/bash
# Health check: disk, memory, Docker containers, PM2, nginx.
# Cron: */15 * * * * /home/butter/unsaltedbutter/scripts/health-check.sh
#
# NOTE: This script only appends to a log file. Nobody is notified.
# TODO: Send a Nostr DM to the operator on alert (use update-checker pattern).
set -euo pipefail

LOG="$HOME/logs/health.log"
mkdir -p "$HOME/logs"

# Disk usage
DISK_USAGE=$(df / | tail -1 | awk '{print $5}' | tr -d '%')
if [ "$DISK_USAGE" -gt 85 ]; then
    echo "$(date): ALERT disk at ${DISK_USAGE}%" >> "$LOG"
fi

# Memory
MEM_USAGE=$(free | awk '/Mem:/ {printf("%.0f", $3/$2 * 100)}')
if [ "$MEM_USAGE" -gt 90 ]; then
    echo "$(date): ALERT memory at ${MEM_USAGE}%" >> "$LOG"
fi

# Check critical Docker containers
for name in btcpayserver lnd_bitcoin nbxplorer bitcoind; do
    if ! sudo docker ps --format '{{.Names}}' | grep -q "$name"; then
        echo "$(date): ALERT container $name is DOWN" >> "$LOG"
    fi
done

# Check PM2
if ! pm2 list 2>/dev/null | grep -q "online"; then
    echo "$(date): ALERT PM2 app not online" >> "$LOG"
fi

# Check nginx
if ! systemctl is-active --quiet nginx; then
    echo "$(date): ALERT nginx is down" >> "$LOG"
fi
