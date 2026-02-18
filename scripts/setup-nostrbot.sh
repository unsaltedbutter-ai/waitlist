#!/usr/bin/env bash
# setup-nostrbot.sh — Install and configure the UnsaltedButter Nostr bot.
# Works on macOS (dev) and Raspberry Pi / Debian (prod).
#
# Usage:
#   ./scripts/setup-nostrbot.sh              # install + configure
#   ./scripts/setup-nostrbot.sh --service    # also install systemd service (Linux only)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BOT_DIR="$PROJECT_ROOT/nostr-bot"
VENV_DIR="$BOT_DIR/venv"
MIN_PYTHON="3.11"

# ── OS detection ──────────────────────────────────────────────

detect_os() {
    case "$(uname -s)" in
        Darwin) OS="macos" ;;
        Linux)  OS="linux" ;;
        *)      echo "Unsupported OS: $(uname -s)" && exit 1 ;;
    esac

    ARCH="$(uname -m)"

    if [ "$OS" = "linux" ] && [ "$ARCH" = "armv7l" ]; then
        echo "WARNING: 32-bit ARM detected. nostr-sdk may not have pre-built wheels."
        echo "Strongly recommend 64-bit Raspberry Pi OS (aarch64) for this bot."
        echo ""
    fi
}

# ── Python detection ──────────────────────────────────────────

find_python() {
    # Try common names in order of preference
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

install_python() {
    echo "Python >= $MIN_PYTHON not found. Installing..."
    if [ "$OS" = "macos" ]; then
        if ! command -v brew &>/dev/null; then
            echo "ERROR: Homebrew not installed. Install it from https://brew.sh"
            exit 1
        fi
        brew install python@3.12
    elif [ "$OS" = "linux" ]; then
        sudo apt-get update -qq
        sudo apt-get install -y python3 python3-venv python3-pip
    fi

    if ! find_python; then
        echo "ERROR: Failed to install Python >= $MIN_PYTHON"
        exit 1
    fi
}

# ── Main ──────────────────────────────────────────────────────

main() {
    local install_service=false
    if [ "${1:-}" = "--service" ]; then
        install_service=true
    fi

    echo "=== UnsaltedButter Nostr Bot Setup ==="
    echo ""

    # 1. OS detection
    detect_os
    echo "OS:   $OS ($ARCH)"

    # 2. Python
    if find_python; then
        echo "Python: $PYTHON ($PYTHON_VERSION)"
    else
        install_python
        echo "Python: $PYTHON ($PYTHON_VERSION) (just installed)"
    fi

    # 3. Ensure venv module is available (Debian/Ubuntu strips it out)
    if [ "$OS" = "linux" ]; then
        if ! "$PYTHON" -m venv --help &>/dev/null; then
            echo "Installing python3-venv..."
            sudo apt-get install -y python3-venv
        fi
    fi

    # 4. Create venv
    if [ -d "$VENV_DIR" ]; then
        echo "Venv:  $VENV_DIR (exists)"
    else
        echo "Creating venv at $VENV_DIR..."
        "$PYTHON" -m venv "$VENV_DIR"
        echo "Venv:  $VENV_DIR (created)"
    fi

    # 5. Install dependencies
    echo ""
    echo "Installing dependencies..."
    "$VENV_DIR/bin/pip" install --upgrade pip --quiet
    "$VENV_DIR/bin/pip" install -r "$BOT_DIR/requirements.txt" --quiet
    echo "Dependencies installed."

    # 6. Create .env from example if it doesn't exist
    if [ ! -f "$BOT_DIR/.env" ]; then
        cp "$BOT_DIR/.env.example" "$BOT_DIR/.env"
        chmod 600 "$BOT_DIR/.env"
        echo ""
        echo "Created .env from .env.example (chmod 600)."
        echo ">>> EDIT $BOT_DIR/.env with your actual values before running the bot. <<<"
        NEEDS_CONFIG=true
    else
        chmod 600 "$BOT_DIR/.env"
        echo ".env:  exists (permissions verified)"
        NEEDS_CONFIG=false
    fi

    # 7. Run tests
    echo ""
    echo "Running tests..."
    if "$VENV_DIR/bin/python" -m pytest "$BOT_DIR" -v --tb=short 2>&1; then
        echo ""
        echo "All tests passed."
    else
        echo ""
        echo "WARNING: Some tests failed. Check output above."
    fi

    # 8. systemd service (Linux only)
    if [ "$install_service" = true ]; then
        if [ "$OS" != "linux" ]; then
            echo ""
            echo "WARNING: --service flag ignored on macOS. systemd is Linux-only."
        else
            install_systemd_service
        fi
    fi

    # 9. Summary
    echo ""
    echo "=== Setup Complete ==="
    echo ""
    echo "Bot directory:  $BOT_DIR"
    echo "Venv:           $VENV_DIR"
    echo "Config:         $BOT_DIR/.env"
    echo ""

    if [ "$NEEDS_CONFIG" = true ]; then
        echo "NEXT STEPS:"
        echo "  1. Edit $BOT_DIR/.env with your real values:"
        echo "     - NOSTR_NSEC          (bot's private key)"
        echo "     - API_BASE_URL       (VPS URL, e.g. https://unsaltedbutter.ai)"
        echo "     - AGENT_HMAC_SECRET  (shared HMAC secret with VPS)"
        echo "     - ZAP_PROVIDER_PUBKEY (Lightning provider's nostr pubkey)"
        echo "     - BOT_LUD16          (Lightning address for zaps)"
        echo "     - VPS_BOT_PUBKEY     (hex pubkey of VPS private Nostr bot)"
        echo "     - OPERATOR_NPUB      (operator's npub for admin commands)"
        echo "  2. Run the bot:"
        echo "     cd $BOT_DIR && venv/bin/python bot.py"
    else
        echo "Run the bot:"
        echo "  cd $BOT_DIR && venv/bin/python bot.py"
    fi

    if [ "$OS" = "linux" ] && [ "$install_service" = true ]; then
        echo ""
        echo "Or use systemd:"
        echo "  sudo systemctl start unsaltedbutter-bot"
        echo "  sudo journalctl -u unsaltedbutter-bot -f"
    elif [ "$OS" = "linux" ] && [ "$install_service" = false ]; then
        echo ""
        echo "To install as a systemd service (auto-start on boot):"
        echo "  ./scripts/setup-nostrbot.sh --service"
    fi
}

install_systemd_service() {
    echo ""
    echo "Installing systemd service..."

    local service_user
    service_user="$(whoami)"
    local service_file="/etc/systemd/system/unsaltedbutter-bot.service"

    sudo tee "$service_file" > /dev/null <<UNIT
[Unit]
Description=UnsaltedButter Nostr Bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$service_user
WorkingDirectory=$BOT_DIR
ExecStart=$VENV_DIR/bin/python bot.py
Restart=always
RestartSec=10
EnvironmentFile=$BOT_DIR/.env

# Hardening
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=$BOT_DIR/logs
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
UNIT

    sudo systemctl daemon-reload
    sudo systemctl enable unsaltedbutter-bot

    echo "Service installed and enabled."
    echo "Start with: sudo systemctl start unsaltedbutter-bot"
}

main "$@"
