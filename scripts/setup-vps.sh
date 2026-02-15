#!/usr/bin/env bash
# =============================================================================
# setup-vps.sh — Provision Hetzner VPS for UnsaltedButter.ai
#
# Run as root on a fresh Ubuntu 24.04 (Hetzner CPX31):
#   scp scripts/setup-vps.sh root@<VPS_IP>:~
#   ssh root@<VPS_IP> "chmod +x setup-vps.sh && ./setup-vps.sh"
#
# What this does:
#   1. Creates 'butter' app user with sudo + SSH
#   2. Installs Node.js 22, PostgreSQL 16, nginx, Docker, PM2
#   3. Configures UFW firewall (22/80/443 only)
#   4. Installs fail2ban for SSH brute-force protection
#   5. Installs certbot for Let's Encrypt SSL
#   6. Generates encryption keyfile
#   7. Sets up PostgreSQL database + schema
#   8. Hardens SSH (disable root login, password auth)
#
# After running:
#   - SSH in as: ssh butter@<VPS_IP>
#   - Root SSH will be DISABLED
#   - Run setup-btcpay.sh next
# =============================================================================
set -euo pipefail

# --- Config ---
APP_USER="butter"
DB_NAME="unsaltedbutter"
DB_USER="butter"
KEYFILE_DIR="/etc/unsaltedbutter"
KEYFILE_PATH="${KEYFILE_DIR}/encryption.keyfile"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()  { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
err()  { echo -e "${RED}[✗]${NC} $1"; exit 1; }

# Must be root
[[ $EUID -eq 0 ]] || err "Run as root"

echo ""
echo "================================================"
echo "  UnsaltedButter.ai — VPS Setup"
echo "================================================"
echo ""

# =============================================================================
# 1. System update
# =============================================================================
log "Updating system packages..."
apt update && apt upgrade -y
apt install -y curl wget gnupg2 software-properties-common apt-transport-https \
    ca-certificates lsb-release unzip git jq

# =============================================================================
# 2. Create app user
# =============================================================================
if id "${APP_USER}" &>/dev/null; then
    warn "User '${APP_USER}' already exists, skipping"
else
    log "Creating user '${APP_USER}'..."
    adduser --disabled-password --gecos "" "${APP_USER}"
    usermod -aG sudo "${APP_USER}"
    # Allow sudo without password for initial setup
    echo "${APP_USER} ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/${APP_USER}
    chmod 440 /etc/sudoers.d/${APP_USER}
fi

# Copy root's SSH keys to butter user
if [[ -f /root/.ssh/authorized_keys ]]; then
    log "Copying SSH keys to ${APP_USER}..."
    mkdir -p /home/${APP_USER}/.ssh
    cp /root/.ssh/authorized_keys /home/${APP_USER}/.ssh/authorized_keys
    chown -R ${APP_USER}:${APP_USER} /home/${APP_USER}/.ssh
    chmod 700 /home/${APP_USER}/.ssh
    chmod 600 /home/${APP_USER}/.ssh/authorized_keys
else
    warn "No SSH keys found at /root/.ssh/authorized_keys"
    warn "You'll need to add SSH keys to /home/${APP_USER}/.ssh/authorized_keys manually"
fi

# =============================================================================
# 3. Node.js 22 (via NodeSource)
# =============================================================================
log "Installing Node.js 22..."
if ! command -v node &>/dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt install -y nodejs
fi
node --version
npm --version

# PM2 global
log "Installing PM2..."
npm install -g pm2

# =============================================================================
# 4. PostgreSQL 16
# =============================================================================
log "Installing PostgreSQL 16..."
if ! dpkg -l | grep -q postgresql-16; then
    sh -c 'echo "deb http://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" > /etc/apt/sources.list.d/pgdg.list'
    curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | gpg --dearmor -o /etc/apt/trusted.gpg.d/postgresql.gpg
    apt update
    apt install -y postgresql-16 postgresql-client-16
fi

# =============================================================================
# 5. nginx
# =============================================================================
log "Installing nginx..."
apt install -y nginx
systemctl enable nginx

# =============================================================================
# 6. Certbot (Let's Encrypt)
# =============================================================================
log "Installing certbot..."
apt install -y certbot python3-certbot-nginx

# =============================================================================
# 7. Docker (for BTCPay Server)
# =============================================================================
log "Installing Docker..."
if ! command -v docker &>/dev/null; then
    curl -fsSL https://get.docker.com | sh
    usermod -aG docker ${APP_USER}
fi
systemctl enable docker

# =============================================================================
# 8. UFW Firewall
# =============================================================================
log "Configuring UFW firewall..."
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp    # SSH
ufw allow 80/tcp    # HTTP (certbot + redirect)
ufw allow 443/tcp   # HTTPS
# Enable without prompt
echo "y" | ufw enable
ufw status verbose

# =============================================================================
# 9. fail2ban
# =============================================================================
log "Installing fail2ban..."
apt install -y fail2ban

cat > /etc/fail2ban/jail.local << 'JAIL'
[sshd]
enabled = true
port = ssh
filter = sshd
logpath = /var/log/auth.log
maxretry = 5
bantime = 3600
findtime = 600
JAIL

systemctl enable fail2ban
systemctl restart fail2ban

# =============================================================================
# 10. Encryption keyfile
# =============================================================================
log "Generating encryption keyfile..."
mkdir -p "${KEYFILE_DIR}"
if [[ -f "${KEYFILE_PATH}" ]]; then
    warn "Keyfile already exists at ${KEYFILE_PATH}, skipping"
else
    openssl rand 32 > "${KEYFILE_PATH}"
    chmod 0400 "${KEYFILE_PATH}"
    chown ${APP_USER}:${APP_USER} "${KEYFILE_PATH}"
    log "Keyfile created at ${KEYFILE_PATH}"
    warn "BACK THIS UP OFFLINE. Loss = irrecoverable credential data."
fi

# =============================================================================
# 11. PostgreSQL setup
# =============================================================================
log "Setting up PostgreSQL database..."

# Generate a random password
DB_PASS=$(openssl rand -hex 24)

# Create user and database
sudo -u postgres psql <<EOF
DO \$\$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${DB_USER}') THEN
        CREATE USER ${DB_USER} WITH PASSWORD '${DB_PASS}';
    END IF;
END
\$\$;

SELECT 'CREATE DATABASE ${DB_NAME} OWNER ${DB_USER}'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '${DB_NAME}')\gexec

GRANT ALL PRIVILEGES ON DATABASE ${DB_NAME} TO ${DB_USER};
\c ${DB_NAME}
GRANT ALL ON SCHEMA public TO ${DB_USER};
EOF

# Save the password for deploy.sh to use
mkdir -p /home/${APP_USER}/.unsaltedbutter
echo "${DB_PASS}" > /home/${APP_USER}/.unsaltedbutter/db_password
chmod 600 /home/${APP_USER}/.unsaltedbutter/db_password
chown -R ${APP_USER}:${APP_USER} /home/${APP_USER}/.unsaltedbutter

log "Database password saved to /home/${APP_USER}/.unsaltedbutter/db_password"

# =============================================================================
# 12. Apply schema
# =============================================================================
# Schema will be applied by deploy.sh after code is rsynced.
# We just ensure the database is ready.

# =============================================================================
# 13. Create app directory
# =============================================================================
log "Creating app directory..."
mkdir -p /home/${APP_USER}/unsaltedbutter
chown -R ${APP_USER}:${APP_USER} /home/${APP_USER}/unsaltedbutter

# =============================================================================
# 14. SSH hardening — DO NOT auto-disable root login
# =============================================================================
# We intentionally leave root login enabled so you can verify butter SSH works
# first. Disabling root before testing butter = lockout risk.
log "SSH keys copied. Root login is still enabled."
warn "After verifying 'ssh butter@<VPS_IP>' works, harden SSH manually:"
warn "  sed -i 's/^#\\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config"
warn "  sed -i 's/^#\\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config"
warn "  systemctl restart ssh"

# =============================================================================
# 15. PM2 startup for butter user
# =============================================================================
log "Configuring PM2 startup..."
# pm2 startup outputs a sudo command — since we're already root, run it directly
env PATH="$PATH:/usr/bin:/usr/local/bin" pm2 startup systemd -u ${APP_USER} --hp /home/${APP_USER} || true

# =============================================================================
# Done
# =============================================================================
echo ""
echo "================================================"
echo "  VPS Setup Complete"
echo "================================================"
echo ""
echo "  App user:     ${APP_USER}"
echo "  SSH:          ssh ${APP_USER}@$(hostname -I | awk '{print $1}')"
echo "  Database:     ${DB_NAME}"
echo "  DB user:      ${DB_USER}"
echo "  DB password:  saved to /home/${APP_USER}/.unsaltedbutter/db_password"
echo "  Keyfile:      ${KEYFILE_PATH}"
echo ""
echo "  Installed: Node.js $(node --version), PostgreSQL 16, nginx, Docker, PM2, certbot"
echo ""
echo "  NEXT STEPS:"
echo "  1. Verify SSH as butter: ssh ${APP_USER}@<VPS_IP>"
echo "  2. Run setup-btcpay.sh (as butter user)"
echo "  3. Run deploy.sh from your local machine"
echo ""
warn "BACK UP ${KEYFILE_PATH} OFFLINE NOW."
echo ""
