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

# 2. Check Python 3
if ! command -v python3 &>/dev/null; then
    echo "[error] python3 not found. Install it via Xcode CLT or Homebrew."
    exit 1
fi
PYTHON_VERSION=$(python3 --version 2>&1)
echo "[ok] $PYTHON_VERSION"

# 3. Create venv (fresh each time)
if [ -d "$VENV_DIR" ]; then
    echo "Removing existing venv..."
    rm -rf "$VENV_DIR"
fi

echo "Creating venv at $VENV_DIR..."
python3 -m venv "$VENV_DIR"
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
