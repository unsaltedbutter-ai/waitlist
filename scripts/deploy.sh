#!/usr/bin/env bash
# =============================================================================
# deploy.sh: Deploy UnsaltedButter to VPS
#
# Run from your local machine (from the project root):
#   ./scripts/deploy.sh <VPS_IP>
#
# First deploy (--init flag applies schema + generates .env.production):
#   ./scripts/deploy.sh <VPS_IP> --init
#
# Set up cron jobs + daily cron timer (run once after --init, idempotent):
#   ./scripts/deploy.sh <VPS_IP> --setup-bots
#
# What this does:
#   1. rsync web/ to VPS
#   2. rsync scripts/ (for schema + nginx config)
#   3. [--init] scp SCHEMA.sql to VPS
#   4. [--init] Generate .env.production with real secrets
#   5. [--init] Apply database schema (v4, complete)
#   6. [--setup-bots] Install cron jobs (update-checker, health-check, lnd-balance, backup) + daily cron timer (systemd)
#   7. npm ci && npm run build
#   8. Install/configure nginx
#   9. [--init] Run certbot for SSL
#  10. PM2 restart
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
DEPLOY_DIRTY=false

for arg in "${@:2}"; do
    case "$arg" in
        --init)         INIT_MODE=true ;;
        --setup-bots)   SETUP_BOTS=true ;;
        --dirty)        DEPLOY_DIRTY=true ;;
        *)              err "Unknown flag: $arg" ;;
    esac
done

if [[ -z "${VPS_IP}" ]]; then
    echo "Usage: ./scripts/deploy.sh <VPS_IP> [--init] [--setup-bots] [--dirty]"
    echo ""
    echo "  <VPS_IP>      IP address of the Hetzner VPS"
    echo "  --init        First deploy: generate .env.production, apply schema, setup SSL"
    echo "  --setup-bots  One-time: install update-checker (cron) + daily cron timer (systemd)"
    echo "  --dirty       Allow deploying with uncommitted changes (not recommended)"
    exit 1
fi

# Refuse to deploy uncommitted changes unless --dirty is passed
if ! $DEPLOY_DIRTY; then
    if ! git -C "${PROJECT_ROOT}" diff --quiet 2>/dev/null || \
       ! git -C "${PROJECT_ROOT}" diff --cached --quiet 2>/dev/null; then
        err "Uncommitted changes detected. Commit first, or use --dirty to override."
    fi
    if [[ -n "$(git -C "${PROJECT_ROOT}" ls-files --others --exclude-standard 2>/dev/null)" ]]; then
        warn "Untracked files present (not blocking deploy, but consider committing them)"
    fi
fi

# SSH multiplexing: reuse one TCP connection for all SSH/rsync calls.
# Prevents UFW rate-limit (22/limit) from refusing connections.
# Path must be short (Unix domain sockets have a 104-char limit on macOS).
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
echo "  UnsaltedButter.ai: Deploy"
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
# (removed: nostr-bot rsync, bot now runs on home network orchestrator)
# =============================================================================

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
    echo "WARNING: .env.production already exists, skipping generation"
    echo "Delete it first if you want to regenerate: rm ${ENV_FILE}"
    exit 0
fi

# Read DB password from setup-vps.sh output
DB_PASS=$(cat /home/butter/.unsaltedbutter/db_password)

# Generate secrets
JWT_SECRET=$(openssl rand -hex 32)
AGENT_HMAC_SECRET=$(openssl rand -hex 32)
CRON_SECRET=$(openssl rand -hex 32)
VPS_NOSTR_PRIVKEY=$(openssl rand -hex 32)

cat > "${ENV_FILE}" << EOF
# Auto-generated by deploy.sh --init on $(date -u +%Y-%m-%dT%H:%M:%SZ)
DATABASE_URL=postgresql://butter:${DB_PASS}@localhost:5432/unsaltedbutter
JWT_SECRET=${JWT_SECRET}
ENCRYPTION_KEY_PATH=/etc/unsaltedbutter/encryption.keyfile
BTCPAY_URL=https://pay.unsaltedbutter.ai
BTCPAY_API_KEY=CONFIGURE_AFTER_BTCPAY_SETUP
BTCPAY_STORE_ID=CONFIGURE_AFTER_BTCPAY_SETUP
BTCPAY_WEBHOOK_SECRET=CONFIGURE_AFTER_BTCPAY_SETUP
AGENT_HMAC_SECRET=${AGENT_HMAC_SECRET}
CRON_SECRET=${CRON_SECRET}
VPS_NOSTR_PRIVKEY=${VPS_NOSTR_PRIVKEY}
ORCHESTRATOR_NPUB=
NEXT_PUBLIC_APP_URL=https://unsaltedbutter.ai
NODE_ENV=production
OPERATOR_USER_ID=
EOF

chmod 600 "${ENV_FILE}"
echo ".env.production created"
REMOTE_ENV
fi

# =============================================================================
# 5. [init] Apply database schema (SCHEMA.sql is the complete v4 schema)
# =============================================================================
if $INIT_MODE; then
    log "Copying SCHEMA.sql to VPS..."
    scp ${SSH_OPTS} \
        "${PROJECT_ROOT}/unsalted-butter-handoff/docs/SCHEMA.sql" \
        "${VPS_USER}@${VPS_IP}:${REMOTE_DIR}/scripts/SCHEMA.sql"

    log "Applying database schema..."

    ${SSH_CMD} bash << 'REMOTE_SCHEMA'
set -euo pipefail

REMOTE_DIR="/home/butter/unsaltedbutter"
DB_PASS=$(cat /home/butter/.unsaltedbutter/db_password)
export PGPASSWORD="${DB_PASS}"

echo "Applying SCHEMA.sql (v4 pay-per-action)..."
psql -h localhost -U butter -d unsaltedbutter -f "${REMOTE_DIR}/scripts/SCHEMA.sql"

echo "Schema applied successfully"
REMOTE_SCHEMA
fi

# =============================================================================
# 6. [setup-bots] Cron jobs + daily cron timer (one-time setup, idempotent)
# =============================================================================
if $SETUP_BOTS; then
    log "Setting up cron jobs + daily cron timer..."

    ${SSH_CMD} bash << 'REMOTE_BOTS'
set -euo pipefail

REMOTE_DIR="/home/butter/unsaltedbutter"
MIN_PYTHON="3.11"

# -- Find Python -----------------------------------------------
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

mkdir -p "$HOME/.unsaltedbutter"

# -- Update checker venv ----------------------------------------
UC_VENV="$HOME/venvs/update-checker"
if [[ -d "$UC_VENV" ]]; then
    echo "Update checker venv: exists"
else
    mkdir -p "$HOME/venvs"
    "$PYTHON" -m venv "$UC_VENV"
    echo "Update checker venv: created"
fi
echo "Installing update-checker dependencies..."
"$UC_VENV/bin/pip" install --upgrade pip --quiet
"$UC_VENV/bin/pip" install -r "${REMOTE_DIR}/scripts/update-checker-requirements.txt" --quiet
echo "Update checker dependencies installed."

# -- install_cron helper ----------------------------------------
install_cron() {
    local match="$1"
    local cron_line="$2"
    if crontab -l 2>/dev/null | grep -qF "$match"; then
        (crontab -l 2>/dev/null | grep -vF "$match"; echo "$cron_line") | crontab -
        echo "Cron ($match): updated"
    else
        (crontab -l 2>/dev/null; echo "$cron_line") | crontab -
        echo "Cron ($match): installed"
    fi
}

# -- Clean old ~/scripts/ cron entries -----------------------------
# Remove entries pointing to /home/butter/scripts/ (old ad-hoc path).
# Won't match /home/butter/unsaltedbutter/scripts/ (the repo path).
crontab -l 2>/dev/null | grep -vF '/home/butter/scripts/' | crontab - 2>/dev/null || true
echo "Old ~/scripts/ cron entries cleaned"

# -- Install all cron jobs -----------------------------------------
mkdir -p "$HOME/logs"

install_cron "update-checker.py" \
    "0 10 * * * ${UC_VENV}/bin/python ${REMOTE_DIR}/scripts/update-checker.py >> \$HOME/logs/update-checker.log 2>&1"

install_cron "health-check.sh" \
    "*/15 * * * * ${REMOTE_DIR}/scripts/health-check.sh >> \$HOME/logs/health.log 2>&1"

install_cron "lnd-balance.sh" \
    "0 6 * * * ${REMOTE_DIR}/scripts/lnd-balance.sh >> \$HOME/logs/lnd-balance.log 2>&1"

install_cron "backup-daily.sh" \
    "0 3 * * * ${REMOTE_DIR}/scripts/backup-daily.sh >> \$HOME/logs/backup.log 2>&1"

install_cron "backup-offsite.sh" \
    "0 4 * * * ${REMOTE_DIR}/scripts/backup-offsite.sh 2>&1"

install_cron "lightning-backup.sh" \
    "0 */6 * * * ${REMOTE_DIR}/scripts/lightning-backup.sh >> \$HOME/logs/scb.log 2>&1"

echo "Cron jobs: update-checker (10:00), health-check (*/15), lnd-balance (06:00), backup (03:00), offsite (04:00), lightning-backup (*/6h)"

# -- Sudoers for apt-get update ---------------------------------
SUDOERS="/etc/sudoers.d/update-checker"
if [[ ! -f "$SUDOERS" ]]; then
    echo "$(whoami) ALL=(ALL) NOPASSWD: /usr/bin/apt-get update -qq" | sudo tee "$SUDOERS" > /dev/null
    sudo chmod 440 "$SUDOERS"
    echo "Sudoers: created"
else
    echo "Sudoers: exists"
fi

# -- Daily cron timer (systemd) ---------------------------------
# Calls /api/cron/daily at 10:00 UTC (5:00 AM EST) every day
CRON_SECRET=$(grep '^CRON_SECRET=' "${REMOTE_DIR}/web/.env.production" | cut -d= -f2)
if [[ -z "$CRON_SECRET" ]]; then
    echo "ERROR: CRON_SECRET not found in .env.production. Run --init first."
    exit 1
fi

sudo tee /etc/systemd/system/unsaltedbutter-daily-cron.service > /dev/null << UNIT
[Unit]
Description=UnsaltedButter Daily Cron Job
After=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/bin/curl -s -f -X POST -H "Authorization: Bearer ${CRON_SECRET}" http://localhost:3000/api/cron/daily
TimeoutStartSec=120
UNIT

sudo tee /etc/systemd/system/unsaltedbutter-daily-cron.timer > /dev/null << UNIT
[Unit]
Description=UnsaltedButter Daily Cron Timer

[Timer]
OnCalendar=*-*-* 10:00:00
Persistent=true

[Install]
WantedBy=timers.target
UNIT

sudo systemctl daemon-reload
sudo systemctl enable unsaltedbutter-daily-cron.timer
sudo systemctl start unsaltedbutter-daily-cron.timer
echo "Daily cron timer: installed and started (10:00 UTC / 5:00 AM EST)"

# -- Summary ----------------------------------------------------
echo ""
echo "=== Setup Complete ==="
echo ""
echo "  Venv:                $UC_VENV"
echo "  update-checker.py    daily 10:00 UTC"
echo "  health-check.sh      every 15 min"
echo "  lnd-balance.sh       daily 06:00 UTC"
echo "  backup-daily.sh      daily 03:00 UTC"
echo "  backup-offsite.sh    daily 04:00 UTC"
echo "  lightning-backup.sh  every 6 hours"
echo "  daily cron timer     unsaltedbutter-daily-cron.timer (10:00 UTC)"
echo ""
echo "  Test nostr-alert:"
echo "    ${UC_VENV}/bin/python ${REMOTE_DIR}/scripts/nostr-alert.py --dry-run --key test 'Test alert'"
echo ""
REMOTE_BOTS
fi

# =============================================================================
# 7. npm ci + build
# =============================================================================
GIT_HASH=$(git -C "${PROJECT_ROOT}" rev-parse --short HEAD 2>/dev/null || echo "unknown")
log "Installing dependencies and building (${GIT_HASH})..."

${SSH_CMD} bash << REMOTE_BUILD
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
export GIT_HASH="${GIT_HASH}"
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
# touched it yet. Certbot adds "managed by Certbot" comments, and if those
# exist, the config has SSL blocks we don't want to overwrite.
if [[ -f "${NGINX_CONF}" ]] && grep -q "managed by Certbot" "${NGINX_CONF}"; then
    echo "nginx config has SSL (certbot), skipping overwrite"
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
# 9. [init] SSL with certbot (skipped if certs already exist)
# =============================================================================
if $INIT_MODE; then
    CERT_EXISTS=$(${SSH_CMD} "sudo test -f /etc/letsencrypt/live/unsaltedbutter.ai/fullchain.pem && echo yes || echo no")
    if [[ "${CERT_EXISTS}" == "yes" ]]; then
        log "SSL certificates already exist, skipping certbot"
    else
        log "Setting up SSL certificates..."
        warn "Certbot will prompt you for email + agreement. Answer the prompts."

        ${SSH_CMD} -t bash << 'REMOTE_SSL'
sudo certbot --nginx -d unsaltedbutter.ai -d pay.unsaltedbutter.ai
REMOTE_SSL

        log "SSL configured"
    fi
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
# 11. Notify operator via Nostr DM
# =============================================================================
log "Sending deploy notification (${GIT_HASH})..."
${SSH_CMD} bash << REMOTE_NOTIFY
UC_VENV="\$HOME/venvs/update-checker"
if [[ -d "\$UC_VENV" ]] && [[ -f "\$HOME/.unsaltedbutter/nostr.env" ]]; then
    "\$UC_VENV/bin/python" "\$HOME/unsaltedbutter/scripts/notify-deploy.py" "Deploy complete: ${GIT_HASH}" 2>&1 || echo "Deploy DM failed (non-fatal)"
else
    echo "Skipping deploy DM (venv or config missing)"
fi
REMOTE_NOTIFY

# =============================================================================
# 12. Verify
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
echo "=== Cron Jobs ==="
for script in update-checker.py health-check.sh lnd-balance.sh backup-daily.sh backup-offsite.sh lightning-backup.sh; do
    if crontab -l 2>/dev/null | grep -qF "$script"; then
        echo "$script ✓"
    else
        echo "$script NOT installed"
    fi
done

echo ""
echo "=== Daily Cron Timer ==="
if systemctl is-active unsaltedbutter-daily-cron.timer &>/dev/null; then
    echo "unsaltedbutter-daily-cron.timer is active ✓"
else
    echo "unsaltedbutter-daily-cron.timer not active"
fi
REMOTE_VERIFY

echo ""
echo "================================================"
echo "  Deploy Complete"
echo "         $(date '+%Y-%m-%d %H:%M:%S')"
echo "         ${GIT_HASH}"
echo "================================================"
echo ""
echo "  App:     https://unsaltedbutter.ai"
echo "  BTCPay:  https://pay.unsaltedbutter.ai"
echo ""
if $INIT_MODE; then
    echo "  NEXT STEPS:"
    echo "  1. Visit https://unsaltedbutter.ai and verify it loads"
    echo "  2. Wait for Bitcoin sync to complete"
    echo "  3. Visit https://pay.unsaltedbutter.ai → create admin account"
    echo "  4. Create store, generate API key, set webhook"
    echo "  5. Update .env.production with BTCPay credentials:"
    echo "     ssh ${VPS_USER}@${VPS_IP} nano ${REMOTE_DIR}/web/.env.production"
    echo "  6. Restart: ssh ${VPS_USER}@${VPS_IP} 'pm2 restart unsaltedbutter'"
    echo ""
fi
if $SETUP_BOTS; then
    echo "  NEXT STEPS (setup-bots):"
    echo "  1. Test nostr-alert:"
    echo "     ssh ${VPS_USER}@${VPS_IP} ~/venvs/update-checker/bin/python ~/unsaltedbutter/scripts/nostr-alert.py --dry-run --key test 'Test alert'"
    echo "  2. Test update checker:"
    echo "     ssh ${VPS_USER}@${VPS_IP} ~/venvs/update-checker/bin/python ~/unsaltedbutter/scripts/update-checker.py --dry-run"
    echo "  3. Verify cron jobs:"
    echo "     ssh ${VPS_USER}@${VPS_IP} crontab -l"
    echo "  4. Verify daily cron timer:"
    echo "     ssh ${VPS_USER}@${VPS_IP} systemctl list-timers unsaltedbutter-daily-cron.timer"
    echo ""
fi
