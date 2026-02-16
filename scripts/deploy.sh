#!/usr/bin/env bash
# =============================================================================
# deploy.sh — Deploy UnsaltedButter to VPS
#
# Run from your local machine (from the project root):
#   ./scripts/deploy.sh <VPS_IP>
#
# First deploy (--init flag applies schema + generates .env.production):
#   ./scripts/deploy.sh <VPS_IP> --init
#
# Set up nostr bot + update checker (run once after --init):
#   ./scripts/deploy.sh <VPS_IP> --setup-bots
#
# What this does:
#   1. rsync web/ to VPS
#   2. rsync scripts/ (for schema + nginx config)
#   3. rsync nostr-bot/
#   4. [--init] Generate .env.production with real secrets
#   5. [--init] Apply database schema + migrations
#   6. [--setup-bots] Generate shared nostr.env, install venvs, systemd, cron
#   7. npm ci && npm run build
#   8. Install/configure nginx
#   9. [--init] Run certbot for SSL
#  10. PM2 restart + nostr-bot restart
# =============================================================================
set -euo pipefail

# --- Config ---
VPS_USER="butter"
REMOTE_DIR="/home/butter/unsaltedbutter"
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()  { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
err()  { echo -e "${RED}[✗]${NC} $1"; exit 1; }

# --- Args ---
VPS_IP="${1:-}"
INIT_MODE=false
SETUP_BOTS=false

for arg in "${@:2}"; do
    case "$arg" in
        --init)       INIT_MODE=true ;;
        --setup-bots) SETUP_BOTS=true ;;
        *)            err "Unknown flag: $arg" ;;
    esac
done

if [[ -z "${VPS_IP}" ]]; then
    echo "Usage: ./scripts/deploy.sh <VPS_IP> [--init] [--setup-bots]"
    echo ""
    echo "  <VPS_IP>      IP address of the Hetzner VPS"
    echo "  --init        First deploy: generate .env.production, apply schema, setup SSL"
    echo "  --setup-bots  One-time: install nostr-bot (systemd) + update-checker (cron)"
    exit 1
fi

# SSH multiplexing — reuse one TCP connection for all SSH/rsync calls.
# Prevents UFW rate-limit (22/limit) from refusing connections.
# Path must be short — Unix domain sockets have a 104-char limit on macOS.
SSH_CONTROL_PATH="/tmp/ub-ssh-$$"
SSH_OPTS="-o ControlMaster=auto -o ControlPath=${SSH_CONTROL_PATH} -o ControlPersist=120"
SSH_CMD="ssh ${SSH_OPTS} ${VPS_USER}@${VPS_IP}"
RSYNC_SSH="ssh ${SSH_OPTS}"

cleanup_ssh() {
    ssh -o ControlPath="${SSH_CONTROL_PATH}" -O exit "${VPS_USER}@${VPS_IP}" 2>/dev/null || true
    rm -f "${SSH_CONTROL_PATH}"
}
trap cleanup_ssh EXIT

MODE_DESC="Update"
if $INIT_MODE && $SETUP_BOTS; then MODE_DESC="INIT + Setup Bots";
elif $INIT_MODE; then MODE_DESC="INIT (first deploy)";
elif $SETUP_BOTS; then MODE_DESC="Setup Bots"; fi

echo ""
echo "================================================"
echo "  UnsaltedButter.ai — Deploy"
echo "  Target: ${VPS_USER}@${VPS_IP}"
echo "  Mode:   ${MODE_DESC}"
echo "================================================"
echo ""

# Test SSH connection
${SSH_CMD} "echo 'SSH OK'" || err "Cannot SSH to ${VPS_USER}@${VPS_IP}"

# =============================================================================
# 1. rsync web app
# =============================================================================
log "Syncing web app to VPS..."
rsync -avz --delete \
    -e "${RSYNC_SSH}" \
    --exclude 'node_modules' \
    --exclude '.next' \
    --exclude '.env.local' \
    --exclude '.env.production' \
    "${PROJECT_ROOT}/web/" \
    "${VPS_USER}@${VPS_IP}:${REMOTE_DIR}/web/"

# =============================================================================
# 2. rsync scripts (for schema + nginx config)
# =============================================================================
log "Syncing scripts..."
rsync -avz \
    -e "${RSYNC_SSH}" \
    "${PROJECT_ROOT}/scripts/" \
    "${VPS_USER}@${VPS_IP}:${REMOTE_DIR}/scripts/"

# =============================================================================
# 3. rsync nostr-bot
# =============================================================================
log "Syncing nostr-bot..."
rsync -avz \
    -e "${RSYNC_SSH}" \
    --exclude 'venv' \
    --exclude '__pycache__' \
    --exclude '.env' \
    --exclude '*.pyc' \
    "${PROJECT_ROOT}/nostr-bot/" \
    "${VPS_USER}@${VPS_IP}:${REMOTE_DIR}/nostr-bot/"

# =============================================================================
# 4. [init] Generate .env.production
# =============================================================================
if $INIT_MODE; then
    log "Generating .env.production with real secrets..."

    ${SSH_CMD} bash << 'REMOTE_ENV'
set -euo pipefail

REMOTE_DIR="/home/butter/unsaltedbutter"
ENV_FILE="${REMOTE_DIR}/web/.env.production"

if [[ -f "${ENV_FILE}" ]]; then
    echo "WARNING: .env.production already exists — skipping generation"
    echo "Delete it first if you want to regenerate: rm ${ENV_FILE}"
    exit 0
fi

# Read DB password from setup-vps.sh output
DB_PASS=$(cat /home/butter/.unsaltedbutter/db_password)

# Generate secrets
JWT_SECRET=$(openssl rand -hex 32)
AGENT_API_KEY=$(openssl rand -hex 32)

cat > "${ENV_FILE}" << EOF
# Auto-generated by deploy.sh --init on $(date -u +%Y-%m-%dT%H:%M:%SZ)
DATABASE_URL=postgresql://butter:${DB_PASS}@localhost:5432/unsaltedbutter
JWT_SECRET=${JWT_SECRET}
ENCRYPTION_KEY_PATH=/etc/unsaltedbutter/encryption.keyfile
BTCPAY_URL=https://pay.unsaltedbutter.ai
BTCPAY_API_KEY=CONFIGURE_AFTER_BTCPAY_SETUP
BTCPAY_STORE_ID=CONFIGURE_AFTER_BTCPAY_SETUP
BTCPAY_WEBHOOK_SECRET=CONFIGURE_AFTER_BTCPAY_SETUP
AGENT_API_KEY=${AGENT_API_KEY}
NEXT_PUBLIC_APP_URL=https://unsaltedbutter.ai
NODE_ENV=production
OPERATOR_USER_ID=
EOF

chmod 600 "${ENV_FILE}"
echo ".env.production created"
REMOTE_ENV
fi

# =============================================================================
# 5. [init] Apply database schema + migrations
# =============================================================================
if $INIT_MODE; then
    log "Applying database schema..."

    ${SSH_CMD} bash << 'REMOTE_SCHEMA'
set -euo pipefail

REMOTE_DIR="/home/butter/unsaltedbutter"
DB_PASS=$(cat /home/butter/.unsaltedbutter/db_password)
export PGPASSWORD="${DB_PASS}"

echo "Applying schema.sql..."
psql -h localhost -U butter -d unsaltedbutter -f "${REMOTE_DIR}/scripts/schema.sql"

# These migrations are for upgrading older schemas. On a fresh DB (schema.sql
# already has everything), they'll fail harmlessly on duplicate objects.
echo "Applying migrate-path-d.sql..."
psql -h localhost -U butter -d unsaltedbutter -f "${REMOTE_DIR}/scripts/migrate-path-d.sql" || echo "  (skipped — already in schema.sql)"

echo "Applying migrate-nostr-bot.sql..."
psql -h localhost -U butter -d unsaltedbutter -f "${REMOTE_DIR}/scripts/migrate-nostr-bot.sql" || echo "  (skipped — already in schema.sql)"

# This one uses IF NOT EXISTS, so it always succeeds
echo "Applying migrate-service-plans.sql..."
psql -h localhost -U butter -d unsaltedbutter -f "${REMOTE_DIR}/scripts/migrate-service-plans.sql"

echo "Schema applied successfully"
REMOTE_SCHEMA
fi

# =============================================================================
# 6. [setup-bots] Nostr bot + update checker — one-time setup
# =============================================================================
if $SETUP_BOTS; then
    log "Setting up nostr bot + update checker..."

    ${SSH_CMD} bash << 'REMOTE_BOTS'
set -euo pipefail

REMOTE_DIR="/home/butter/unsaltedbutter"
NOSTR_ENV="$HOME/.unsaltedbutter/nostr.env"
MIN_PYTHON="3.11"

# ── Find Python ──────────────────────────────────────────────
PYTHON=""
for cmd in python3.13 python3.12 python3.11 python3; do
    if command -v "$cmd" &>/dev/null; then
        ver="$("$cmd" -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')"
        if "$cmd" -c "
import sys
min_parts = [int(x) for x in '${MIN_PYTHON}'.split('.')]
cur_parts = [int(x) for x in '${ver}'.split('.')]
sys.exit(0 if cur_parts >= min_parts else 1)
" 2>/dev/null; then
            PYTHON="$cmd"
            break
        fi
    fi
done

if [[ -z "$PYTHON" ]]; then
    echo "ERROR: Python >= $MIN_PYTHON not found. Install it first."
    exit 1
fi
echo "Python: $PYTHON"

# ── Shared nostr.env ─────────────────────────────────────────
mkdir -p "$HOME/.unsaltedbutter"

if [[ -f "$NOSTR_ENV" ]]; then
    echo "Config: $NOSTR_ENV (exists — not overwriting)"
else
    DB_PASS=$(cat "$HOME/.unsaltedbutter/db_password")
    cp "${REMOTE_DIR}/scripts/nostr.env.example" "$NOSTR_ENV"
    # Fill in the real DATABASE_URL
    sed -i "s|DATABASE_URL=postgresql://butter:PASSWORD@localhost:5432/unsaltedbutter|DATABASE_URL=postgresql://butter:${DB_PASS}@localhost:5432/unsaltedbutter|" "$NOSTR_ENV"
    chmod 600 "$NOSTR_ENV"
    echo "Config: $NOSTR_ENV (created — DATABASE_URL filled in)"
    echo ""
    echo ">>> EDIT $NOSTR_ENV — set NOSTR_NSEC and other values before starting the bot. <<<"
    echo ""
fi

# ── Nostr bot venv ───────────────────────────────────────────
NOSTR_VENV="$HOME/venvs/nostr-bot"
if [[ -d "$NOSTR_VENV" ]]; then
    echo "Nostr bot venv: exists"
else
    mkdir -p "$HOME/venvs"
    "$PYTHON" -m venv "$NOSTR_VENV"
    echo "Nostr bot venv: created"
fi
echo "Installing nostr-bot dependencies..."
"$NOSTR_VENV/bin/pip" install --upgrade pip --quiet
"$NOSTR_VENV/bin/pip" install -r "${REMOTE_DIR}/nostr-bot/requirements.txt" --quiet
echo "Nostr bot dependencies installed."

# ── Nostr bot systemd service ────────────────────────────────
SERVICE_FILE="/etc/systemd/system/unsaltedbutter-bot.service"
if [[ -f "$SERVICE_FILE" ]]; then
    echo "Systemd service: exists (updating)"
fi

sudo tee "$SERVICE_FILE" > /dev/null << UNIT
[Unit]
Description=UnsaltedButter Nostr Bot
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
Type=simple
User=$(whoami)
WorkingDirectory=${REMOTE_DIR}/nostr-bot
ExecStart=${NOSTR_VENV}/bin/python bot.py
Restart=always
RestartSec=10
EnvironmentFile=${NOSTR_ENV}

# Hardening
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=$HOME/logs
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
UNIT

sudo systemctl daemon-reload
sudo systemctl enable unsaltedbutter-bot
echo "Systemd service: installed and enabled"

# ── Update checker venv ──────────────────────────────────────
UC_VENV="$HOME/venvs/update-checker"
if [[ -d "$UC_VENV" ]]; then
    echo "Update checker venv: exists"
else
    "$PYTHON" -m venv "$UC_VENV"
    echo "Update checker venv: created"
fi
echo "Installing update-checker dependencies..."
"$UC_VENV/bin/pip" install --upgrade pip --quiet
"$UC_VENV/bin/pip" install -r "${REMOTE_DIR}/scripts/update-checker-requirements.txt" --quiet
echo "Update checker dependencies installed."

# ── Update checker cron ──────────────────────────────────────
mkdir -p "$HOME/logs"
CRON_LINE="0 10 * * * ${UC_VENV}/bin/python ${REMOTE_DIR}/scripts/update-checker.py >> $HOME/logs/update-checker.log 2>&1"
if crontab -l 2>/dev/null | grep -qF "update-checker.py"; then
    (crontab -l 2>/dev/null | grep -vF "update-checker.py"; echo "$CRON_LINE") | crontab -
    echo "Cron: updated"
else
    (crontab -l 2>/dev/null; echo "$CRON_LINE") | crontab -
    echo "Cron: installed"
fi
echo "Update checker: daily 10 AM UTC"

# ── Sudoers for apt-get update ───────────────────────────────
SUDOERS="/etc/sudoers.d/update-checker"
if [[ ! -f "$SUDOERS" ]]; then
    echo "$(whoami) ALL=(ALL) NOPASSWD: /usr/bin/apt-get update -qq" | sudo tee "$SUDOERS" > /dev/null
    sudo chmod 440 "$SUDOERS"
    echo "Sudoers: created"
else
    echo "Sudoers: exists"
fi

# ── Summary ──────────────────────────────────────────────────
echo ""
echo "=== Bot Setup Complete ==="
echo ""
echo "  Shared config:     $NOSTR_ENV"
echo "  Nostr bot venv:    $NOSTR_VENV"
echo "  Update checker:    $UC_VENV"
echo "  Nostr bot service: unsaltedbutter-bot.service"
echo "  Update checker:    cron daily 10 AM UTC"
echo ""
echo "  NEXT: Edit $NOSTR_ENV with:"
echo "    NOSTR_NSEC        (bot's secret key)"
echo "    ZAP_PROVIDER_PUBKEY (Lightning provider's nostr pubkey)"
echo "    BOT_LUD16         (Lightning address)"
echo "  Then: sudo systemctl start unsaltedbutter-bot"
REMOTE_BOTS
fi

# =============================================================================
# 7. npm ci + build
# =============================================================================
log "Installing dependencies and building..."

${SSH_CMD} bash << 'REMOTE_BUILD'
set -euo pipefail

cd /home/butter/unsaltedbutter/web

echo "Running npm ci..."
npm ci

echo "Building Next.js..."
# Source .env.production for NEXT_PUBLIC_* vars, but override NODE_ENV
# so npm ci (above) doesn't skip dev dependencies
if [[ -f .env.production ]]; then
    set -a
    source .env.production
    set +a
fi
npm run build

echo "Build complete"
REMOTE_BUILD

# =============================================================================
# 8. nginx setup
# =============================================================================
log "Configuring nginx..."

${SSH_CMD} bash << 'REMOTE_NGINX'
set -euo pipefail

REMOTE_DIR="/home/butter/unsaltedbutter"
NGINX_CONF="/etc/nginx/sites-available/unsaltedbutter"

# Only install nginx config on first deploy (--init) or if certbot hasn't
# touched it yet. Certbot adds "managed by Certbot" comments — if those
# exist, the config has SSL blocks we don't want to overwrite.
if [[ -f "${NGINX_CONF}" ]] && grep -q "managed by Certbot" "${NGINX_CONF}"; then
    echo "nginx config has SSL (certbot) — skipping overwrite"
else
    sudo cp "${REMOTE_DIR}/scripts/nginx/unsaltedbutter.conf" "${NGINX_CONF}"
    sudo ln -sf "${NGINX_CONF}" /etc/nginx/sites-enabled/unsaltedbutter
    sudo rm -f /etc/nginx/sites-enabled/default
    echo "nginx config installed"
fi

# Test and reload
sudo nginx -t
sudo systemctl reload nginx

echo "nginx configured"
REMOTE_NGINX

# =============================================================================
# 9. [init] SSL with certbot
# =============================================================================
if $INIT_MODE; then
    log "Setting up SSL certificates..."
    warn "Certbot will prompt you for email + agreement. Answer the prompts."

    ${SSH_CMD} -t bash << 'REMOTE_SSL'
sudo certbot --nginx -d unsaltedbutter.ai -d pay.unsaltedbutter.ai
REMOTE_SSL

    log "SSL configured"
fi

# =============================================================================
# 10. PM2 start/restart
# =============================================================================
log "Starting app with PM2..."

${SSH_CMD} bash << 'REMOTE_PM2'
set -euo pipefail

cd /home/butter/unsaltedbutter/web

# Stop existing if running
pm2 delete unsaltedbutter 2>/dev/null || true

# Start with ecosystem config
pm2 start ecosystem.config.cjs

# Save PM2 process list for auto-restart on reboot
pm2 save

echo "PM2 started"
REMOTE_PM2

# =============================================================================
# 11. Restart nostr-bot (if service exists)
# =============================================================================
${SSH_CMD} bash << 'REMOTE_BOT_RESTART'
if systemctl is-enabled unsaltedbutter-bot &>/dev/null; then
    if systemctl is-active unsaltedbutter-bot &>/dev/null; then
        sudo systemctl restart unsaltedbutter-bot
        echo "Nostr bot restarted"
    else
        echo "Nostr bot service is enabled but not running (start manually after configuring .env)"
    fi
else
    echo "Nostr bot service not installed (run with --setup-bots)"
fi
REMOTE_BOT_RESTART

# =============================================================================
# 12. Notify operator via Nostr DM
# =============================================================================
log "Sending deploy notification..."
${SSH_CMD} bash << 'REMOTE_NOTIFY'
UC_VENV="$HOME/venvs/update-checker"
if [[ -d "$UC_VENV" ]] && [[ -f "$HOME/.unsaltedbutter/nostr.env" ]]; then
    "$UC_VENV/bin/python" "$HOME/unsaltedbutter/scripts/notify-deploy.py" 2>&1 || echo "Deploy DM failed (non-fatal)"
else
    echo "Skipping deploy DM (venv or config missing)"
fi
REMOTE_NOTIFY

# =============================================================================
# 13. Verify
# =============================================================================
log "Verifying deployment..."
sleep 8

${SSH_CMD} bash << 'REMOTE_VERIFY'
set -euo pipefail

echo "=== PM2 Status ==="
pm2 list

echo ""
echo "=== Port Check ==="
if ss -tlnp | grep -q ":3000"; then
    echo "Next.js listening on :3000 ✓"
else
    echo "WARNING: Next.js not listening on :3000"
fi

echo ""
echo "=== nginx Status ==="
sudo systemctl is-active nginx && echo "nginx is running ✓"

echo ""
echo "=== Nostr Bot ==="
if systemctl is-enabled unsaltedbutter-bot &>/dev/null; then
    if systemctl is-active unsaltedbutter-bot &>/dev/null; then
        echo "unsaltedbutter-bot is running ✓"
    else
        echo "unsaltedbutter-bot is enabled but not running"
    fi
else
    echo "unsaltedbutter-bot not installed"
fi

echo ""
echo "=== Update Checker ==="
if crontab -l 2>/dev/null | grep -qF "update-checker.py"; then
    echo "Cron job installed ✓"
else
    echo "Cron job not installed"
fi
REMOTE_VERIFY

echo ""
echo "================================================"
echo "  Deploy Complete"
echo "================================================"
echo ""
echo "  App:     https://unsaltedbutter.ai"
echo "  BTCPay:  https://pay.unsaltedbutter.ai"
echo ""
if $INIT_MODE; then
    echo "  NEXT STEPS:"
    echo "  1. Visit https://unsaltedbutter.ai — verify it loads"
    echo "  2. Wait for Bitcoin sync to complete"
    echo "  3. Visit https://pay.unsaltedbutter.ai → create admin account"
    echo "  4. Create store, generate API key, set webhook"
    echo "  5. Update .env.production with BTCPay credentials:"
    echo "     ssh ${VPS_USER}@${VPS_IP} nano ${REMOTE_DIR}/web/.env.production"
    echo "  6. Restart: ssh ${VPS_USER}@${VPS_IP} 'pm2 restart unsaltedbutter'"
    echo ""
fi
if $SETUP_BOTS; then
    echo "  NEXT STEPS (bots):"
    echo "  1. SSH in and edit the shared Nostr config:"
    echo "     ssh ${VPS_USER}@${VPS_IP} nano ~/.unsaltedbutter/nostr.env"
    echo "  2. Set NOSTR_NSEC, ZAP_PROVIDER_PUBKEY, BOT_LUD16"
    echo "  3. Start the bot:"
    echo "     ssh ${VPS_USER}@${VPS_IP} sudo systemctl start unsaltedbutter-bot"
    echo "  4. Test update checker:"
    echo "     ssh ${VPS_USER}@${VPS_IP} ~/venvs/update-checker/bin/python ~/unsaltedbutter/scripts/update-checker.py --dry-run"
    echo ""
fi
