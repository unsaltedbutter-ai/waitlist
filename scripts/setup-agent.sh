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
ENV_FILE="$COMPONENT_DIR/.env"
MIN_PYTHON="3.11"

# ── Helpers ───────────────────────────────────────────────────

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
    if find_python; then
        echo "Python:  $PYTHON ($PYTHON_VERSION)"
    else
        echo "Python:  NOT FOUND (need >= $MIN_PYTHON)"
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

    # Env file
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
    if find_python; then
        echo "Python: $PYTHON ($PYTHON_VERSION)"
    else
        echo "ERROR: Python >= $MIN_PYTHON not found."
        echo "Install via: brew install python@3.12"
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

    # 5. Env file
    NEEDS_CONFIG=false
    if [ ! -f "$ENV_FILE" ]; then
        cp "$COMPONENT_DIR/.env.example" "$ENV_FILE"
        echo ""
        echo "Created $ENV_FILE from .env.example."
        echo ">>> EDIT $ENV_FILE with your actual values before running. <<<"
        NEEDS_CONFIG=true
    else
        echo "Config: $ENV_FILE (exists)"
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
    if "$VENV_DIR/bin/python" -c "import config; import pyautogui; import httpx; print('All imports OK')" 2>&1; then
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
    echo "Config:     $ENV_FILE"
    echo ""

    if [ "$NEEDS_CONFIG" = true ]; then
        echo "NEXT STEPS:"
        echo "  1. Edit $ENV_FILE:"
        echo "     - STUDIO_URL  (Mac Studio inference endpoint)"
        echo "     - AGENT_PORT  (port for orchestrator dispatch, default 8421)"
        echo "  2. Grant Accessibility + Screen Recording permissions in System Settings"
        echo "  3. Run: cd $COMPONENT_DIR && venv/bin/python agent.py"
    else
        echo "Run: cd $COMPONENT_DIR && venv/bin/python agent.py"
    fi
    echo ""
    echo "Reminder: Agent requires Accessibility and Screen Recording permissions"
    echo "          in System Settings > Privacy & Security."
}

main "$@"
