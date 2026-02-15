#!/usr/bin/env bash
# =============================================================================
# setup-btcpay.sh — Install BTCPay Server + LND via Docker
#
# Run as butter user on the VPS (after setup-vps.sh):
#   ssh butter@<VPS_IP>
#   ~/unsaltedbutter/scripts/setup-btcpay.sh
#
# What this does:
#   1. Clones btcpayserver-docker
#   2. Configures for mainnet + LND + pruned bitcoind
#   3. No reverse proxy (system nginx handles SSL)
#   4. Starts all containers (bitcoind + LND + NBXplorer + BTCPay)
#
# After running:
#   - BTCPay listens on localhost:23000
#   - Bitcoin initial sync takes 6-24 hours
#   - nginx will proxy pay.unsaltedbutter.ai → localhost:23000
#   - Visit https://pay.unsaltedbutter.ai to create admin account
# =============================================================================
set -euo pipefail

# --- Config ---
BTCPAY_DIR="/home/butter/btcpayserver-docker"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()  { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
err()  { echo -e "${RED}[✗]${NC} $1"; exit 1; }

# Don't run as root
[[ $EUID -ne 0 ]] || err "Run as butter user, not root"

# Check Docker access
docker ps &>/dev/null || err "Cannot access Docker. Run: sudo usermod -aG docker \$(whoami) && newgrp docker"

echo ""
echo "================================================"
echo "  UnsaltedButter.ai — BTCPay Server Setup"
echo "================================================"
echo ""

# =============================================================================
# 1. Clone btcpayserver-docker
# =============================================================================
if [[ -d "${BTCPAY_DIR}" ]]; then
    log "btcpayserver-docker already exists, pulling latest..."
    cd "${BTCPAY_DIR}"
    git pull
else
    log "Cloning btcpayserver-docker..."
    git clone https://github.com/btcpayserver/btcpayserver-docker.git "${BTCPAY_DIR}"
    cd "${BTCPAY_DIR}"
fi

# =============================================================================
# 2. Configure environment
# =============================================================================
log "Configuring BTCPay environment..."

# BTCPay environment variables
export BTCPAY_HOST="pay.unsaltedbutter.ai"
export NBITCOIN_NETWORK="mainnet"
export BTCPAYGEN_CRYPTO1="btc"
export BTCPAYGEN_LIGHTNING="lnd"
export BTCPAYGEN_REVERSEPROXY="none"
export BTCPAYGEN_ADDITIONAL_FRAGMENTS="opt-save-storage-s"
export BTCPAY_ENABLE_SSH=false

# Persist environment for future use
cat > "${BTCPAY_DIR}/.env" << 'ENV'
BTCPAY_HOST=pay.unsaltedbutter.ai
NBITCOIN_NETWORK=mainnet
BTCPAYGEN_CRYPTO1=btc
BTCPAYGEN_LIGHTNING=lnd
BTCPAYGEN_REVERSEPROXY=none
BTCPAYGEN_ADDITIONAL_FRAGMENTS=opt-save-storage-s
BTCPAY_ENABLE_SSH=false
ENV

log "Environment saved to ${BTCPAY_DIR}/.env"

# =============================================================================
# 3. Run BTCPay setup script
# =============================================================================
log "Running BTCPay setup (this generates docker-compose)..."
cd "${BTCPAY_DIR}"
. ./btcpay-setup.sh -i

# =============================================================================
# 4. Verify containers are running
# =============================================================================
log "Checking container status..."
sleep 10
cd "${BTCPAY_DIR}"

if docker compose ps 2>/dev/null | grep -q "Up"; then
    log "BTCPay containers are running"
elif docker-compose ps 2>/dev/null | grep -q "Up"; then
    log "BTCPay containers are running"
else
    warn "Some containers may not be up yet. Check with: cd ${BTCPAY_DIR} && docker compose ps"
fi

# =============================================================================
# 5. Show useful commands
# =============================================================================
echo ""
echo "================================================"
echo "  BTCPay Server Setup Complete"
echo "================================================"
echo ""
echo "  BTCPay URL:     http://localhost:23000 (via nginx: https://pay.unsaltedbutter.ai)"
echo "  Network:        mainnet"
echo "  Lightning:      LND"
echo "  Bitcoin:        pruned (~50GB)"
echo ""
echo "  USEFUL COMMANDS:"
echo "  cd ${BTCPAY_DIR}"
echo "  docker compose ps                    # container status"
echo "  docker compose logs -f               # all logs"
echo "  docker compose logs -f lnd_bitcoin   # LND logs"
echo "  docker compose logs -f bitcoind      # bitcoind sync progress"
echo ""
echo "  BITCOIN SYNC STATUS:"
echo "  docker exec \$(docker ps -q -f name=bitcoind) bitcoin-cli getblockchaininfo | jq '.verificationprogress'"
echo ""
echo "  LND STATUS:"
echo "  docker exec \$(docker ps -q -f name=lnd_bitcoin) lncli getinfo"
echo ""
echo "  NEXT STEPS:"
echo "  1. Wait for Bitcoin sync (6-24 hours). Everything else works while it syncs."
echo "  2. Run deploy.sh from your local machine to deploy the web app."
echo "  3. Set up nginx SSL (certbot) — deploy.sh handles this."
echo "  4. Visit https://pay.unsaltedbutter.ai → create admin account (first account = admin)."
echo ""
warn "Bitcoin sync takes 6-24 hours. You can continue with other setup in the meantime."
echo ""
