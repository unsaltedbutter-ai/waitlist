#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
AGENT_DIR="$SCRIPT_DIR"
VENV_DIR="$AGENT_DIR/venv"

echo "=== UnsaltedButter Agent Setup ==="
echo ""

# 1. Check for Xcode Command Line Tools
if ! xcode-select -p &>/dev/null; then
    echo "Xcode Command Line Tools not found. Installing..."
    echo "(This is the ~2GB toolchain, not the full 30GB Xcode IDE)"
    xcode-select --install
    echo ""
    echo "After the installer finishes, re-run this script."
    exit 1
fi
echo "[ok] Xcode Command Line Tools installed"

# 2. Ensure Python >= 3.11 (install via Homebrew if needed)
MIN_MAJOR=3
MIN_MINOR=11
PYTHON_BIN=""

# Check python3.13, python3.12, python3.11, then fall back to python3
for candidate in python3.13 python3.12 python3.11 python3; do
    if command -v "$candidate" &>/dev/null; then
        ver=$("$candidate" -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')")
        major="${ver%%.*}"
        minor="${ver#*.}"
        if [ "$major" -ge "$MIN_MAJOR" ] && [ "$minor" -ge "$MIN_MINOR" ]; then
            PYTHON_BIN="$(command -v "$candidate")"
            break
        fi
    fi
done

if [ -z "$PYTHON_BIN" ]; then
    echo "Python >= ${MIN_MAJOR}.${MIN_MINOR} not found. Installing via Homebrew..."

    if ! command -v brew &>/dev/null; then
        echo "Homebrew not found. Installing Homebrew first..."
        /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
        eval "$(/opt/homebrew/bin/brew shellenv)"
    fi

    brew install python@3.13
    PYTHON_BIN="$(command -v python3.13)"

    if [ -z "$PYTHON_BIN" ]; then
        echo "[error] brew install succeeded but python3.13 not found on PATH."
        echo "Try: eval \"\$(/opt/homebrew/bin/brew shellenv)\" and re-run."
        exit 1
    fi
fi

echo "[ok] $("$PYTHON_BIN" --version) ($PYTHON_BIN)"

# 3. Create venv (fresh each time)
if [ -d "$VENV_DIR" ]; then
    echo "Removing existing venv..."
    rm -rf "$VENV_DIR"
fi

echo "Creating venv at $VENV_DIR..."
"$PYTHON_BIN" -m venv "$VENV_DIR"
echo "[ok] venv created"

# 4. Install dependencies
echo "Installing dependencies..."
"$VENV_DIR/bin/pip" install --upgrade pip --quiet
"$VENV_DIR/bin/pip" install -r "$AGENT_DIR/requirements.txt" --quiet
echo "[ok] dependencies installed"

# 5. Make CLI scripts executable
chmod +x "$AGENT_DIR/bin/"*
echo "[ok] bin/ scripts are executable"

# 6. Verify key imports
echo ""
echo "Verifying imports..."
"$VENV_DIR/bin/python" -c "
import pyautogui
import Quartz
from AppKit import NSWorkspace
print('[ok] pyautogui, Quartz, AppKit all importable')
"

# 7. Permission reminders
echo ""
echo "========================================="
echo "  IMPORTANT: macOS Permissions Required"
echo "========================================="
echo ""
echo "1. Accessibility access (required for mouse/keyboard control):"
echo "   System Settings > Privacy & Security > Accessibility"
echo "   Add: Terminal (or whatever terminal app you use)"
echo ""
echo "2. Screen Recording access (required for whereami window detection):"
echo "   System Settings > Privacy & Security > Screen Recording"
echo "   Add: Terminal (or whatever terminal app you use)"
echo ""
echo "Without these permissions, mouse/keyboard operations will silently fail."
echo ""
echo "========================================="
echo "  Setup Complete"
echo "========================================="
echo ""
echo "Usage:"
echo "  source $VENV_DIR/bin/activate"
echo "  $AGENT_DIR/bin/whereami"
echo "  $AGENT_DIR/bin/move 500 300"
echo "  $AGENT_DIR/bin/click"
echo "  $AGENT_DIR/bin/type \"hello world\" --speed slow"
echo ""
