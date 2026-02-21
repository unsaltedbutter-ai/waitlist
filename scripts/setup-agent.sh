#!/usr/bin/env bash
# setup-agent.sh — Install and configure the UnsaltedButter Chrome agent.
# Idempotent: safe to run after every git pull.
# macOS only (requires pyautogui, pyobjc).
#
# Usage:
#   ./scripts/setup-agent.sh              # install + configure
#   ./scripts/setup-agent.sh --check      # verify env + deps only (no install)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
COMPONENT_DIR="$PROJECT_ROOT/agent"
VENV_DIR="$COMPONENT_DIR/venv"
ENV_DIR="$HOME/.unsaltedbutter"
SHARED_ENV_FILE="$ENV_DIR/shared.env"
ENV_FILE="$ENV_DIR/agent.env"
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

    echo "=== Agent Health Check ==="
    echo ""

    # OS
    if [ "$(uname -s)" != "Darwin" ]; then
        echo "OS:      $(uname -s) (WARNING: agent requires macOS)"
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
        if "$VENV_DIR/bin/pip" show pyautogui &>/dev/null; then
            echo "         pyautogui installed"
        else
            echo "         pyautogui NOT installed"
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
    else
        echo "Config:  NOT FOUND at $ENV_FILE"
        ok=false
    fi

    # Chrome
    local chrome="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    if [ -x "$chrome" ]; then
        echo "Chrome:  installed"
    else
        echo "Chrome:  NOT FOUND at $chrome"
        ok=false
    fi

    # Accessibility permissions
    echo ""
    echo "Note: Agent requires Accessibility and Screen Recording permissions"
    echo "      in System Settings > Privacy & Security."

    echo ""
    if [ "$ok" = true ]; then
        echo "Status: ready"
    else
        echo "Status: NOT ready (run ./scripts/setup-agent.sh to fix)"
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

    echo "=== UnsaltedButter Agent Setup ==="
    echo ""

    # 1. OS check
    if [ "$(uname -s)" != "Darwin" ]; then
        echo "ERROR: Agent requires macOS (pyautogui + pyobjc)."
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

    # 5. Env files
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

    # agent.env (component-specific)
    if [ ! -f "$ENV_FILE" ]; then
        cp "$PROJECT_ROOT/env-examples/agent.env.example" "$ENV_FILE"
        chmod 600 "$ENV_FILE"
        echo "Created $ENV_FILE from env-examples/agent.env.example (chmod 600)."
        echo ">>> EDIT $ENV_FILE with your actual values. <<<"
        NEEDS_CONFIG=true
    else
        chmod 600 "$ENV_FILE"
        echo "Config: $ENV_FILE (exists, permissions verified)"
    fi

    # 6. Chrome check
    local chrome="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    if [ -x "$chrome" ]; then
        echo "Chrome: installed"
    else
        echo "WARNING: Chrome not found at $chrome"
        echo "  The agent needs Google Chrome installed to run."
    fi

    # 7. Smoke test
    echo ""
    echo "Running import smoke test..."
    if PYTHONPATH="$PROJECT_ROOT" "$VENV_DIR/bin/python" -c "from agent.config import AGENT_PORT; import pyautogui; import httpx; print('All imports OK')" 2>&1; then
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
        echo "  2. Edit $ENV_FILE (agent-specific: STUDIO_URL, CHROME_PATH)"
        echo "  3. Grant Accessibility + Screen Recording permissions in System Settings"
        echo "  4. Run: cd $COMPONENT_DIR && venv/bin/python server.py"
    else
        echo "Run: cd $COMPONENT_DIR && venv/bin/python server.py"
    fi
    echo ""
    echo "Reminder: Agent requires Accessibility and Screen Recording permissions"
    echo "          in System Settings > Privacy & Security."
}

main "$@"
