#!/usr/bin/env bash
# setup-orchestrator.sh — Install and configure the UnsaltedButter orchestrator.
# Idempotent: safe to run after every git pull.
# Works on macOS (dev) and Linux (prod).
#
# Usage:
#   ./scripts/setup-orchestrator.sh              # install + configure
#   ./scripts/setup-orchestrator.sh --service    # also install systemd service (Linux only)
#   ./scripts/setup-orchestrator.sh --check      # verify env + deps only (no install)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
COMPONENT_DIR="$PROJECT_ROOT/orchestrator"
VENV_DIR="$COMPONENT_DIR/venv"
ENV_DIR="$HOME/.unsaltedbutter"
SHARED_ENV_FILE="$ENV_DIR/shared.env"
ENV_FILE="$ENV_DIR/orchestrator.env"
MIN_PYTHON="3.11"
SERVICE_NAME="unsaltedbutter-orchestrator"

# ── Shared helpers ────────────────────────────────────────────

detect_os() {
    case "$(uname -s)" in
        Darwin) OS="macos" ;;
        Linux)  OS="linux" ;;
        *)      echo "Unsupported OS: $(uname -s)" && exit 1 ;;
    esac
    ARCH="$(uname -m)"
}

find_python() {
    for cmd in python3.13 python3.12 python3.11 python3; do
        if command -v "$cmd" &>/dev/null; then
            local ver
            ver="$("$cmd" -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')"
            if python3 -c "
import sys
min_parts = [int(x) for x in '$MIN_PYTHON'.split('.')]
cur_parts = [int(x) for x in '$ver'.split('.')]
sys.exit(0 if cur_parts >= min_parts else 1)
" 2>/dev/null; then
                PYTHON="$cmd"
                PYTHON_VERSION="$ver"
                return 0
            fi
        fi
    done
    return 1
}

# ── Check mode ────────────────────────────────────────────────

check_only() {
    local ok=true

    echo "=== Orchestrator Health Check ==="
    echo ""

    # Python
    if find_python; then
        echo "Python:  $PYTHON ($PYTHON_VERSION)"
    else
        echo "Python:  NOT FOUND (need >= $MIN_PYTHON)"
        ok=false
    fi

    # Venv
    if [ -d "$VENV_DIR" ]; then
        echo "Venv:    $VENV_DIR (exists)"
        # Check key package
        if "$VENV_DIR/bin/pip" show nostr-sdk &>/dev/null; then
            local sdk_ver
            sdk_ver="$("$VENV_DIR/bin/pip" show nostr-sdk 2>/dev/null | grep '^Version:' | awk '{print $2}')"
            echo "         nostr-sdk $sdk_ver"
        else
            echo "         nostr-sdk NOT installed"
            ok=false
        fi
    else
        echo "Venv:    NOT FOUND"
        ok=false
    fi

    # Env files
    if [ -f "$SHARED_ENV_FILE" ]; then
        echo "Shared:  $SHARED_ENV_FILE"
    else
        echo "Shared:  NOT FOUND at $SHARED_ENV_FILE"
        ok=false
    fi
    if [ -f "$ENV_FILE" ]; then
        echo "Config:  $ENV_FILE"
        local perms
        perms="$(stat -f '%A' "$ENV_FILE" 2>/dev/null || stat -c '%a' "$ENV_FILE" 2>/dev/null)"
        if [ "$perms" = "600" ]; then
            echo "         permissions: 600 (good)"
        else
            echo "         permissions: $perms (should be 600)"
        fi
    else
        echo "Config:  NOT FOUND at $ENV_FILE"
        ok=false
    fi
    # Check required vars across both env files
    local missing=()
    for var in API_BASE_URL AGENT_HMAC_SECRET NOSTR_NSEC VPS_BOT_PUBKEY ZAP_PROVIDER_PUBKEY OPERATOR_NPUB; do
        if ! grep -qh "^${var}=.\+" "$SHARED_ENV_FILE" "$ENV_FILE" 2>/dev/null; then
            missing+=("$var")
        fi
    done
    if [ ${#missing[@]} -gt 0 ]; then
        echo "         MISSING: ${missing[*]}"
        ok=false
    else
        echo "         all required vars present"
    fi

    echo ""
    if [ "$ok" = true ]; then
        echo "Status: ready"
    else
        echo "Status: NOT ready (run ./scripts/setup-orchestrator.sh to fix)"
    fi
}

# ── Main ──────────────────────────────────────────────────────

main() {
    local install_service=false
    local check_mode=false

    while [ $# -gt 0 ]; do
        case "$1" in
            --service) install_service=true; shift ;;
            --check)   check_mode=true; shift ;;
            *)         echo "Unknown option: $1"; exit 1 ;;
        esac
    done

    if [ "$check_mode" = true ]; then
        check_only
        return
    fi

    echo "=== UnsaltedButter Orchestrator Setup ==="
    echo ""

    # 1. OS detection
    detect_os
    echo "OS:     $OS ($ARCH)"

    # 2. Python
    if find_python; then
        echo "Python: $PYTHON ($PYTHON_VERSION)"
    else
        echo "ERROR: Python >= $MIN_PYTHON not found."
        echo "Install it before running this script."
        exit 1
    fi

    # 3. Venv
    if [ -d "$VENV_DIR" ]; then
        echo "Venv:   $VENV_DIR (exists)"
    else
        echo "Creating venv at $VENV_DIR..."
        "$PYTHON" -m venv "$VENV_DIR"
        echo "Venv:   $VENV_DIR (created)"
    fi

    # 4. Install dependencies
    echo ""
    echo "Installing dependencies..."
    "$VENV_DIR/bin/pip" install --upgrade pip --quiet
    "$VENV_DIR/bin/pip" install -r "$COMPONENT_DIR/requirements.txt" --quiet
    echo "Dependencies installed."

    # 5. Verify key packages
    local sdk_ver
    sdk_ver="$("$VENV_DIR/bin/pip" show nostr-sdk 2>/dev/null | grep '^Version:' | awk '{print $2}')"
    echo "  nostr-sdk: $sdk_ver"

    # 6. Env files
    mkdir -p "$ENV_DIR"
    NEEDS_CONFIG=false

    # shared.env (common identity, relays, URLs for all Mac Mini components)
    if [ ! -f "$SHARED_ENV_FILE" ]; then
        cp "$PROJECT_ROOT/env-examples/shared.env.example" "$SHARED_ENV_FILE"
        chmod 600 "$SHARED_ENV_FILE"
        echo ""
        echo "Created $SHARED_ENV_FILE from env-examples/shared.env.example (chmod 600)."
        echo ">>> EDIT $SHARED_ENV_FILE with your actual values. <<<"
        NEEDS_CONFIG=true
    else
        chmod 600 "$SHARED_ENV_FILE"
        echo "Shared: $SHARED_ENV_FILE (exists, permissions verified)"
    fi

    # orchestrator.env (component-specific)
    if [ ! -f "$ENV_FILE" ]; then
        cp "$PROJECT_ROOT/env-examples/orchestrator.env.example" "$ENV_FILE"
        chmod 600 "$ENV_FILE"
        echo "Created $ENV_FILE from env-examples/orchestrator.env.example (chmod 600)."
        echo ">>> EDIT $ENV_FILE with your actual values. <<<"
        NEEDS_CONFIG=true
    else
        chmod 600 "$ENV_FILE"
        echo "Config: $ENV_FILE (exists, permissions verified)"
    fi

    # 7. Smoke test (import check, no network)
    echo ""
    echo "Running import smoke test..."
    if "$VENV_DIR/bin/python" -c "import config; import api_client; import nostr_handler; import job_manager; print('All imports OK')" 2>&1; then
        :
    else
        echo "WARNING: Import check failed. Check dependencies."
    fi

    # 8. systemd service (Linux only)
    if [ "$install_service" = true ]; then
        if [ "$OS" != "linux" ]; then
            echo ""
            echo "WARNING: --service flag ignored on macOS."
        else
            install_systemd_service
        fi
    fi

    # 9. Summary
    echo ""
    echo "=== Setup Complete ==="
    echo ""
    echo "Component:  $COMPONENT_DIR"
    echo "Venv:       $VENV_DIR"
    echo "Shared:     $SHARED_ENV_FILE"
    echo "Config:     $ENV_FILE"
    echo ""

    if [ "$NEEDS_CONFIG" = true ]; then
        echo "NEXT STEPS:"
        echo "  1. Edit $SHARED_ENV_FILE (Nostr identity, relays, VPS URL)"
        echo "  2. Edit $ENV_FILE (orchestrator-specific: agent URL, callback port)"
        echo "  3. Run: cd $COMPONENT_DIR && venv/bin/python orchestrator.py"
    else
        echo "Run: cd $COMPONENT_DIR && venv/bin/python orchestrator.py"
    fi

    if [ "$OS" = "linux" ] && [ "$install_service" = true ]; then
        echo ""
        echo "Or use systemd:"
        echo "  sudo systemctl start $SERVICE_NAME"
        echo "  sudo journalctl -u $SERVICE_NAME -f"
    fi
}

install_systemd_service() {
    echo ""
    echo "Installing systemd service..."

    local service_user
    service_user="$(whoami)"
    local service_file="/etc/systemd/system/${SERVICE_NAME}.service"

    sudo tee "$service_file" > /dev/null <<UNIT
[Unit]
Description=UnsaltedButter Orchestrator
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$service_user
WorkingDirectory=$COMPONENT_DIR
ExecStart=$VENV_DIR/bin/python orchestrator.py
Restart=always
RestartSec=10
EnvironmentFile=$SHARED_ENV_FILE
EnvironmentFile=$ENV_FILE

# Hardening
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=$COMPONENT_DIR
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
UNIT

    sudo systemctl daemon-reload
    sudo systemctl enable "$SERVICE_NAME"

    echo "Service installed and enabled."
    echo "Start with: sudo systemctl start $SERVICE_NAME"
}

main "$@"
