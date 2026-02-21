#!/usr/bin/env bash
# setup-launchagent-inference.sh — Install launchd user agent for inference server.
# Idempotent: safe to run repeatedly. Overwrites plist file and reloads.
# macOS only.
#
# What this does:
#   1. Creates ~/Library/LaunchAgents/com.unsaltedbutter.inference.plist
#   2. Loads (or reloads) it into launchd
#
# Runs at login, restarts on crash (KeepAlive), logs to ~/logs/.
#
# Usage:
#   ./scripts/setup-launchagent-inference.sh              # install + load
#   ./scripts/setup-launchagent-inference.sh --uninstall  # stop + remove
#   ./scripts/setup-launchagent-inference.sh --status     # show current state

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LAUNCH_DIR="$HOME/Library/LaunchAgents"
LOG_DIR="$HOME/logs"

LABEL="com.unsaltedbutter.inference"
PLIST="$LAUNCH_DIR/${LABEL}.plist"

# ── Helpers ──────────────────────────────────────────────────

die() { echo "ERROR: $1" >&2; exit 1; }

unload_if_loaded() {
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
}

load_agent() {
    unload_if_loaded
    launchctl bootstrap "gui/$(id -u)" "$PLIST"
    echo "  $LABEL: loaded"
}

# ── Status ───────────────────────────────────────────────────

show_status() {
    echo "=== Inference LaunchAgent Status ==="
    echo ""
    if [ -f "$PLIST" ]; then
        echo "  $LABEL"
        echo "    plist: $PLIST"
        if launchctl print "gui/$(id -u)/$LABEL" &>/dev/null; then
            local pid
            pid=$(launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null | grep -m1 'pid =' | awk '{print $3}' || echo "?")
            echo "    state: running (pid $pid)"
        else
            echo "    state: not loaded"
        fi
    else
        echo "  $LABEL: not installed"
    fi
}

# ── Uninstall ────────────────────────────────────────────────

uninstall() {
    echo "=== Uninstalling Inference LaunchAgent ==="
    unload_if_loaded
    if [ -f "$PLIST" ]; then
        rm "$PLIST"
        echo "  $LABEL: removed"
    else
        echo "  $LABEL: not installed (skip)"
    fi
    echo "Done."
}

# ── Install ──────────────────────────────────────────────────

install() {
    if [ "$(uname -s)" != "Darwin" ]; then
        die "LaunchAgents are macOS only."
    fi

    echo "=== Installing Inference LaunchAgent ==="
    echo ""
    echo "Project: $PROJECT_ROOT"

    # Verify component exists
    [ -f "$PROJECT_ROOT/inference/server.py" ] || die "inference/server.py not found"
    [ -d "$PROJECT_ROOT/inference/venv" ]      || die "inference venv not found (run: cd inference && python3.13 -m venv venv && venv/bin/pip install -r requirements.txt)"

    mkdir -p "$LAUNCH_DIR"
    mkdir -p "$LOG_DIR"

    cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>

    <key>ProgramArguments</key>
    <array>
        <string>${PROJECT_ROOT}/inference/venv/bin/python</string>
        <string>-m</string>
        <string>inference.server</string>
    </array>

    <key>WorkingDirectory</key>
    <string>${PROJECT_ROOT}</string>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>

    <key>ThrottleInterval</key>
    <integer>10</integer>

    <key>StandardOutPath</key>
    <string>${LOG_DIR}/inference-stdout.log</string>

    <key>StandardErrorPath</key>
    <string>${LOG_DIR}/inference-stderr.log</string>
</dict>
</plist>
PLIST
    echo "  $LABEL: plist written"

    echo ""
    load_agent

    echo ""
    echo "=== Done ==="
    echo ""
    echo "Logs:"
    echo "  tail -f ~/logs/inference-stdout.log"
    echo "  tail -f ~/logs/inference-stderr.log"
    echo ""
    echo "Control:"
    echo "  launchctl kickstart -k gui/$(id -u)/$LABEL               # restart"
    echo "  ./scripts/setup-launchagent-inference.sh --status         # check state"
    echo "  ./scripts/setup-launchagent-inference.sh --uninstall      # remove"
}

# ── Main ─────────────────────────────────────────────────────

case "${1:-}" in
    --uninstall) uninstall ;;
    --status)    show_status ;;
    *)           install ;;
esac
