#!/usr/bin/env bash
# setup-inference.sh — Install and configure the UnsaltedButter inference server.
# Idempotent: safe to run after every git pull.
# macOS only (Mac Studio M3 Ultra with llama.cpp or MLX).
#
# Usage:
#   ./scripts/setup-inference.sh              # install + configure
#   ./scripts/setup-inference.sh --check      # verify env + deps only (no install)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
COMPONENT_DIR="$PROJECT_ROOT/inference"
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

    echo "=== Inference Server Health Check ==="
    echo ""

    # OS
    if [ "$(uname -s)" != "Darwin" ]; then
        echo "OS:      $(uname -s) (WARNING: inference server targets macOS Apple Silicon)"
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
        if "$VENV_DIR/bin/pip" show fastapi &>/dev/null; then
            echo "         fastapi installed"
        else
            echo "         fastapi NOT installed"
            ok=false
        fi
    else
        echo "Venv:    NOT FOUND"
        ok=false
    fi

    # Env file
    if [ -f "$ENV_FILE" ]; then
        echo "Config:  $ENV_FILE"
        local backend
        backend="$(grep '^MODEL_BACKEND=' "$ENV_FILE" 2>/dev/null | cut -d= -f2)"
        echo "         backend: ${backend:-not set}"
    else
        echo "Config:  NOT FOUND at $ENV_FILE"
        ok=false
    fi

    # Model file (if llama_cpp backend)
    local model_path
    model_path="$(grep '^MODEL_PATH=' "$ENV_FILE" 2>/dev/null | cut -d= -f2 || echo "")"
    model_path="${model_path/#\~/$HOME}"
    if [ -n "$model_path" ] && [ -f "$model_path" ]; then
        local model_size
        model_size="$(du -h "$model_path" | cut -f1)"
        echo "Model:   $model_path ($model_size)"
    elif [ -n "$model_path" ]; then
        echo "Model:   NOT FOUND at $model_path"
        echo "         (expected when hardware is not yet set up)"
    fi

    echo ""
    if [ "$ok" = true ]; then
        echo "Status: ready (backend: ${backend:-unknown})"
    else
        echo "Status: NOT ready (run ./scripts/setup-inference.sh to fix)"
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

    echo "=== UnsaltedButter Inference Server Setup ==="
    echo ""

    # 1. OS check
    if [ "$(uname -s)" != "Darwin" ]; then
        echo "WARNING: Inference server is designed for macOS Apple Silicon."
        echo "Continuing anyway (mock backend works anywhere)."
    fi
    echo "OS:     $(uname -s) ($(uname -m))"

    # 2. Python
    if find_python; then
        echo "Python: $PYTHON ($PYTHON_VERSION)"
    else
        echo "ERROR: Python >= $MIN_PYTHON not found."
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
        local backend
        backend="$(grep '^MODEL_BACKEND=' "$ENV_FILE" 2>/dev/null | cut -d= -f2)"
        echo "         backend: ${backend:-not set}"
    fi

    # 6. Smoke test
    echo ""
    echo "Running import smoke test..."
    if "$VENV_DIR/bin/python" -c "import config; import fastapi; import uvicorn; print('All imports OK')" 2>&1; then
        :
    else
        echo "WARNING: Import check failed. Check dependencies."
    fi

    # 7. Summary
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
        echo "     - MODEL_BACKEND  (mock, llama_cpp, or mlx)"
        echo "     - MODEL_PATH     (path to GGUF model file)"
        echo "  2. Download the model (if using llama_cpp):"
        echo "     mkdir -p ~/models"
        echo "     # Download qwen3-vl-32b-q4_k_m.gguf to ~/models/"
        echo "  3. Run: cd $COMPONENT_DIR && venv/bin/python -m uvicorn server:app --host 0.0.0.0 --port 8420"
    else
        echo "Run: cd $COMPONENT_DIR && venv/bin/python -m uvicorn server:app --host 0.0.0.0 --port 8420"
        echo ""
        echo "Mock mode (no GPU required):"
        echo "  MODEL_BACKEND=mock in .env"
    fi
}

main "$@"
