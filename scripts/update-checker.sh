#!/usr/bin/env bash
# update-checker.sh — Set up and manage the daily update checker.
#
# Usage:
#   ./update-checker.sh              # run the checker (dry-run)
#   ./update-checker.sh --run        # run the checker (sends DM)
#   ./update-checker.sh --install    # create venv, install deps, set up cron
#   ./update-checker.sh --uninstall  # remove cron job

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VENV_DIR="$HOME/venvs/update-checker"
CHECKER="$SCRIPT_DIR/update-checker.py"
REQUIREMENTS="$SCRIPT_DIR/update-checker-requirements.txt"
ENV_EXAMPLE="$SCRIPT_DIR/update-checker.env.example"
ENV_FILE="$HOME/.update-checker.env"
LOG_DIR="$HOME/logs"
LOG_FILE="$LOG_DIR/update-checker.log"
CRON_SCHEDULE="0 10 * * *"  # 10 AM UTC (6 AM EST)
MIN_PYTHON="3.11"

# ── Helpers ──────────────────────────────────────────────────

find_python() {
    for cmd in python3.13 python3.12 python3.11 python3; do
        if command -v "$cmd" &>/dev/null; then
            local ver
            ver="$("$cmd" -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')"
            if "$cmd" -c "
import sys
min_parts = [int(x) for x in '$MIN_PYTHON'.split('.')]
cur_parts = [int(x) for x in '$ver'.split('.')]
sys.exit(0 if cur_parts >= min_parts else 1)
" 2>/dev/null; then
                PYTHON="$cmd"
                return 0
            fi
        fi
    done
    return 1
}

cron_line() {
    echo "$CRON_SCHEDULE $VENV_DIR/bin/python $CHECKER >> $LOG_FILE 2>&1"
}

# ── Install ──────────────────────────────────────────────────

do_install() {
    echo "=== Update Checker — Install ==="
    echo ""

    # Python
    if ! find_python; then
        echo "ERROR: Python >= $MIN_PYTHON not found."
        exit 1
    fi
    echo "Python: $PYTHON"

    # Venv
    if [ -d "$VENV_DIR" ]; then
        echo "Venv:   $VENV_DIR (exists)"
    else
        echo "Creating venv at $VENV_DIR..."
        mkdir -p "$(dirname "$VENV_DIR")"
        "$PYTHON" -m venv "$VENV_DIR"
    fi

    # Dependencies
    echo "Installing dependencies..."
    "$VENV_DIR/bin/pip" install --upgrade pip --quiet
    "$VENV_DIR/bin/pip" install -r "$REQUIREMENTS" --quiet
    echo "Dependencies installed."

    # .env
    if [ ! -f "$ENV_FILE" ]; then
        cp "$ENV_EXAMPLE" "$ENV_FILE"
        chmod 600 "$ENV_FILE"
        echo ""
        echo "Created $ENV_FILE from example (chmod 600)."
        echo ">>> EDIT $ENV_FILE — set NOSTR_NSEC before first run. <<<"
    else
        echo "Config: $ENV_FILE (exists)"
    fi

    # Log dir
    mkdir -p "$LOG_DIR"

    # Sudoers for apt-get update (no password prompt in cron)
    local sudoers_file="/etc/sudoers.d/update-checker"
    if [ ! -f "$sudoers_file" ]; then
        echo ""
        echo "Adding sudoers rule for passwordless apt-get update..."
        echo "$(whoami) ALL=(ALL) NOPASSWD: /usr/bin/apt-get update -qq" | sudo tee "$sudoers_file" > /dev/null
        sudo chmod 440 "$sudoers_file"
        echo "Sudoers: $sudoers_file (created)"
    else
        echo "Sudoers: $sudoers_file (exists)"
    fi

    # Cron
    local line
    line="$(cron_line)"
    if crontab -l 2>/dev/null | grep -qF "update-checker.py"; then
        echo ""
        echo "Cron: already installed (updating)"
        (crontab -l 2>/dev/null | grep -vF "update-checker.py"; echo "$line") | crontab -
    else
        echo ""
        echo "Installing cron job..."
        (crontab -l 2>/dev/null; echo "$line") | crontab -
    fi
    echo "Cron: $CRON_SCHEDULE (daily 10 AM UTC / 6 AM EST)"

    # Summary
    echo ""
    echo "=== Install Complete ==="
    echo ""
    echo "  Config:  $ENV_FILE"
    echo "  Venv:    $VENV_DIR"
    echo "  Log:     $LOG_FILE"
    echo "  State:   ~/.update-checker-state.json"
    echo ""
    echo "Test with:"
    echo "  $VENV_DIR/bin/python $CHECKER --dry-run"
}

# ── Uninstall ────────────────────────────────────────────────

do_uninstall() {
    echo "Removing update-checker cron job..."
    if crontab -l 2>/dev/null | grep -qF "update-checker.py"; then
        crontab -l 2>/dev/null | grep -vF "update-checker.py" | crontab -
        echo "Cron job removed."
    else
        echo "No cron job found."
    fi
}

# ── Run ──────────────────────────────────────────────────────

do_run() {
    local flag="${1:-}"
    if [ ! -d "$VENV_DIR" ]; then
        echo "ERROR: Venv not found at $VENV_DIR. Run with --install first."
        exit 1
    fi
    exec "$VENV_DIR/bin/python" "$CHECKER" $flag
}

# ── Main ─────────────────────────────────────────────────────

case "${1:-}" in
    --install)   do_install ;;
    --uninstall) do_uninstall ;;
    --run)       do_run ;;
    *)           do_run "--dry-run" ;;
esac
