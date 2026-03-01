#!/usr/bin/env bash
# setup-tts-bot.sh — Install and configure the UnsaltedButter TTS Bot (Nostr bot).
# Idempotent: safe to run after every git pull.
# macOS only (runs on Mac Studio).
#
# Usage:
#   ./scripts/setup-tts-bot.sh              # install + configure
#   ./scripts/setup-tts-bot.sh --check      # verify env + deps only (no install)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
COMPONENT_DIR="$PROJECT_ROOT/tts_bot"
VENV_DIR="$COMPONENT_DIR/venv"
ENV_DIR="$HOME/.unsaltedbutter"
SHARED_ENV_FILE="$ENV_DIR/shared.env"
ENV_FILE="$ENV_DIR/tts_bot.env"
PYTHON_VERSION="3.13"
BREW_FORMULA="python@${PYTHON_VERSION}"

# ── Helpers ───────────────────────────────────────────────────

ensure_python() {
    if ! command -v brew &>/dev/null; then
        echo "ERROR: Homebrew not installed. Install from https://brew.sh"
        exit 1
    fi
    if ! brew list "$BREW_FORMULA" &>/dev/null; then
        echo "Installing $BREW_FORMULA via Homebrew..."
        brew install "$BREW_FORMULA"
    fi
    PYTHON="$(brew --prefix "$BREW_FORMULA")/bin/python${PYTHON_VERSION}"
    if ! "$PYTHON" --version &>/dev/null; then
        echo "ERROR: $PYTHON is not working"
        exit 1
    fi
}

# ── Check mode ────────────────────────────────────────────────

check_only() {
    local ok=true

    echo "=== TTS Bot Health Check ==="
    echo ""

    # OS
    if [ "$(uname -s)" != "Darwin" ]; then
        echo "OS:      $(uname -s) (WARNING: TTS Bot requires macOS)"
        ok=false
    else
        echo "OS:      macOS ($(uname -m))"
    fi

    # Python
    if "$VENV_DIR/bin/python" --version &>/dev/null; then
        echo "Python:  $("$VENV_DIR/bin/python" --version) (venv)"
    else
        echo "Python:  venv not found or broken"
        ok=false
    fi

    # Venv
    if [ -d "$VENV_DIR" ]; then
        echo "Venv:    $VENV_DIR (exists)"
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
    for var in API_BASE_URL AGENT_HMAC_SECRET NOSTR_NSEC VPS_BOT_PUBKEY; do
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
        echo "Status: NOT ready (run ./scripts/setup-tts-bot.sh to fix)"
    fi
}

# ── Main ──────────────────────────────────────────────────────

main() {
    local check_mode=false

    while [ $# -gt 0 ]; do
        case "$1" in
            --check) check_mode=true; shift ;;
            *)       echo "Unknown option: $1"; exit 1 ;;
        esac
    done

    if [ "$check_mode" = true ]; then
        check_only
        return
    fi

    echo "=== UnsaltedButter TTS Bot Setup ==="
    echo ""

    # 1. OS check
    if [ "$(uname -s)" != "Darwin" ]; then
        echo "ERROR: TTS Bot requires macOS (runs on Mac Studio)."
        exit 1
    fi
    echo "OS:     macOS ($(uname -m))"

    # 2. Python
    ensure_python
    echo "Python: $("$PYTHON" --version)"

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

    if [ ! -f "$ENV_FILE" ]; then
        cp "$PROJECT_ROOT/env-examples/tts_bot.env.example" "$ENV_FILE"
        chmod 600 "$ENV_FILE"
        echo "Created $ENV_FILE from env-examples/tts_bot.env.example (chmod 600)."
        echo ">>> EDIT $ENV_FILE with your actual values. <<<"
        NEEDS_CONFIG=true
    else
        chmod 600 "$ENV_FILE"
        echo "Config: $ENV_FILE (exists, permissions verified)"
    fi

    # 7. Smoke test
    echo ""
    echo "Running import smoke test..."
    if PYTHONPATH="$PROJECT_ROOT" "$VENV_DIR/bin/python" -c "from tts_bot.config import Config; from tts_bot.url_parser import parse_tweet_url; import httpx; import nostr_sdk; print('All imports OK')" 2>&1; then
        :
    else
        echo "WARNING: Import check failed. Check dependencies."
    fi

    # 8. Summary
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
        echo "  2. Edit $ENV_FILE (TTS Bot Nostr nsec, VPS bot pubkey, pricing)"
        echo "  3. Run: cd $PROJECT_ROOT && tts_bot/venv/bin/python -m tts_bot.tts_bot"
    else
        echo "Run: cd $PROJECT_ROOT && tts_bot/venv/bin/python -m tts_bot.tts_bot"
    fi
}

main "$@"
