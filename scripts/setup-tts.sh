#!/usr/bin/env bash
# setup-tts.sh — Install and configure the UnsaltedButter TTS Service (Kokoro-82M).
# Idempotent: safe to run after every git pull.
# macOS only (Apple Silicon, MLX backend). Runs on Mac Studio.
#
# Installs all prerequisites automatically via Homebrew:
#   - python@3.13, ffmpeg
#   - Python packages: kokoro, fastapi, uvicorn, numpy
#
# Usage:
#   ./scripts/setup-tts.sh              # install + configure
#   ./scripts/setup-tts.sh --check      # verify env + deps only (no install)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
COMPONENT_DIR="$PROJECT_ROOT/tts"
VENV_DIR="$COMPONENT_DIR/venv"
ENV_DIR="$HOME/.unsaltedbutter"
SHARED_ENV_FILE="$ENV_DIR/shared.env"
ENV_FILE="$ENV_DIR/tts.env"
# kokoro requires Python >=3.10,<3.13 so TTS uses 3.12
PYTHON_VERSION="3.12"
BREW_FORMULA="python@${PYTHON_VERSION}"

# System-level brew packages required
BREW_DEPS=("ffmpeg")

# ── Helpers ───────────────────────────────────────────────────

ensure_brew() {
    if ! command -v brew &>/dev/null; then
        echo "ERROR: Homebrew not installed."
        echo "  Install from https://brew.sh:"
        echo '  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'
        exit 1
    fi
}

ensure_python() {
    ensure_brew
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

ensure_brew_deps() {
    for pkg in "${BREW_DEPS[@]}"; do
        if ! command -v "$pkg" &>/dev/null; then
            echo "Installing $pkg via Homebrew..."
            brew install "$pkg"
        fi
    done
}

# ── Check mode ────────────────────────────────────────────────

check_only() {
    local ok=true

    echo "=== TTS Service Health Check ==="
    echo ""

    # OS + arch
    if [ "$(uname -s)" != "Darwin" ]; then
        echo "OS:      $(uname -s) (FAIL: TTS Service requires macOS)"
        ok=false
    else
        echo "OS:      macOS ($(uname -m))"
    fi
    if [ "$(uname -m)" != "arm64" ]; then
        echo "ARCH:    $(uname -m) (FAIL: Kokoro MLX requires Apple Silicon)"
        echo "         This must run on an Apple Silicon Mac (M1/M2/M3/M4)."
        ok=false
    fi

    # Homebrew
    if command -v brew &>/dev/null; then
        echo "Brew:    $(brew --version | head -1)"
    else
        echo "Brew:    NOT FOUND"
        echo "         Install from https://brew.sh"
        ok=false
    fi

    # Python
    if "$VENV_DIR/bin/python" --version &>/dev/null; then
        echo "Python:  $("$VENV_DIR/bin/python" --version) (venv)"
    else
        echo "Python:  venv not found or broken"
        echo "         Run: ./scripts/setup-tts.sh"
        ok=false
    fi

    # ffmpeg
    if command -v ffmpeg &>/dev/null; then
        echo "ffmpeg:  $(ffmpeg -version 2>&1 | head -1 | awk '{print $3}')"
    else
        echo "ffmpeg:  NOT FOUND (required for WAV-to-MP3 conversion)"
        echo "         Run: brew install ffmpeg"
        ok=false
    fi

    # Venv packages
    if [ -d "$VENV_DIR" ]; then
        echo "Venv:    $VENV_DIR (exists)"

        local missing_pkgs=()
        for pkg in kokoro fastapi uvicorn numpy; do
            if "$VENV_DIR/bin/pip" show "$pkg" &>/dev/null; then
                local ver
                ver="$("$VENV_DIR/bin/pip" show "$pkg" 2>/dev/null | grep '^Version:' | awk '{print $2}')"
                echo "         $pkg $ver"
            else
                echo "         $pkg NOT installed"
                missing_pkgs+=("$pkg")
            fi
        done
        if [ ${#missing_pkgs[@]} -gt 0 ]; then
            ok=false
        fi
    else
        echo "Venv:    NOT FOUND"
        echo "         Run: ./scripts/setup-tts.sh"
        ok=false
    fi

    # Kokoro import test (catches missing native deps like mlx)
    if [ -d "$VENV_DIR" ] && "$VENV_DIR/bin/pip" show kokoro &>/dev/null; then
        if PYTHONPATH="$PROJECT_ROOT" "$VENV_DIR/bin/python" -c "from kokoro import KPipeline; print('kokoro import OK')" 2>/dev/null; then
            echo "Import:  kokoro KPipeline OK"
        else
            echo "Import:  kokoro KPipeline FAILED"
            echo "         kokoro is installed but cannot be imported."
            echo "         Check that mlx and its dependencies are working."
            ok=false
        fi
    fi

    # Env file
    if [ -f "$ENV_FILE" ]; then
        echo "Config:  $ENV_FILE"
    else
        echo "Config:  NOT FOUND at $ENV_FILE (optional, defaults are fine)"
    fi

    echo ""
    if [ "$ok" = true ]; then
        echo "Status: ready"
    else
        echo ""
        echo "Status: NOT ready (run ./scripts/setup-tts.sh to fix)"
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

    echo "=== UnsaltedButter TTS Service Setup ==="
    echo ""

    # 1. OS + arch check
    if [ "$(uname -s)" != "Darwin" ]; then
        echo "ERROR: TTS Service requires macOS (Apple Silicon + MLX)."
        exit 1
    fi
    echo "OS:     macOS ($(uname -m))"
    if [ "$(uname -m)" != "arm64" ]; then
        echo ""
        echo "ERROR: Kokoro MLX backend requires Apple Silicon (arm64)."
        echo "  This script must run on a Mac with an M1/M2/M3/M4 chip."
        echo "  Current architecture: $(uname -m)"
        exit 1
    fi

    # 2. Homebrew
    ensure_brew
    echo "Brew:   $(brew --version | head -1)"

    # 3. Python
    ensure_python
    echo "Python: $("$PYTHON" --version)"

    # 4. System dependencies (ffmpeg)
    echo ""
    echo "Checking system dependencies..."
    ensure_brew_deps
    echo "ffmpeg: $(ffmpeg -version 2>&1 | head -1 | awk '{print $3}')"

    # 5. Venv
    if [ -d "$VENV_DIR" ]; then
        echo "Venv:   $VENV_DIR (exists)"
    else
        echo "Creating venv at $VENV_DIR..."
        "$PYTHON" -m venv "$VENV_DIR"
        echo "Venv:   $VENV_DIR (created)"
    fi

    # 6. Install Python dependencies
    echo ""
    echo "Installing Python dependencies..."
    "$VENV_DIR/bin/pip" install --upgrade pip --quiet
    "$VENV_DIR/bin/pip" install -r "$COMPONENT_DIR/requirements.txt" --quiet
    echo "Dependencies installed."

    # 7. Verify key packages
    echo ""
    echo "Installed packages:"
    for pkg in kokoro fastapi uvicorn numpy; do
        local ver
        ver="$("$VENV_DIR/bin/pip" show "$pkg" 2>/dev/null | grep '^Version:' | awk '{print $2}')"
        echo "  $pkg: $ver"
    done

    # 8. Env file (optional for TTS, defaults are sensible)
    mkdir -p "$ENV_DIR"
    NEEDS_CONFIG=false

    if [ ! -f "$ENV_FILE" ]; then
        cp "$PROJECT_ROOT/env-examples/tts.env.example" "$ENV_FILE"
        chmod 600 "$ENV_FILE"
        echo ""
        echo "Created $ENV_FILE from env-examples/tts.env.example (chmod 600)."
        echo "  Defaults are fine for most setups. Edit to change voices/port."
        NEEDS_CONFIG=true
    else
        chmod 600 "$ENV_FILE"
        echo "Config: $ENV_FILE (exists, permissions verified)"
    fi

    # 9. Smoke test (import check, no model load)
    echo ""
    echo "Running import smoke test..."
    if PYTHONPATH="$PROJECT_ROOT" "$VENV_DIR/bin/python" -c "
import fastapi
import uvicorn
import numpy
from kokoro import KPipeline
print('All imports OK (kokoro, fastapi, uvicorn, numpy)')
" 2>&1; then
        :
    else
        echo ""
        echo "WARNING: Import check failed."
        echo "  If kokoro import failed, you may need to install mlx manually:"
        echo "    $VENV_DIR/bin/pip install mlx"
        echo "  Then re-run this script."
    fi

    # 10. Summary
    echo ""
    echo "=== Setup Complete ==="
    echo ""
    echo "Component:  $COMPONENT_DIR"
    echo "Venv:       $VENV_DIR"
    echo "Config:     $ENV_FILE"
    echo ""

    echo "Run: cd $PROJECT_ROOT && tts/venv/bin/python -m tts.server"
    echo ""
    echo "Note: First request will download and load the Kokoro model (~600 MB)."
    echo "      Subsequent requests use the cached model."
}

main "$@"
