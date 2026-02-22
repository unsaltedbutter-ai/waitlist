#!/usr/bin/env bash
# setup-launchagents.sh — Install launchd user agents for orchestrator + agent.
# Idempotent: safe to run repeatedly. Overwrites plist files and reloads.
# macOS only (LaunchAgents require Aqua/GUI session for pyautogui).
#
# What this does:
#   1. Creates ~/Library/LaunchAgents/com.unsaltedbutter.orchestrator.plist
#   2. Creates ~/Library/LaunchAgents/com.unsaltedbutter.agent.plist
#   3. Loads (or reloads) both into launchd
#
# Both run in the GUI session, restart on crash (KeepAlive), and log to ~/logs/.
# The orchestrator starts immediately; the agent waits 10s to let it initialize.
#
# Usage:
#   ./scripts/setup-launchagents.sh              # install + load
#   ./scripts/setup-launchagents.sh --uninstall  # stop + remove
#   ./scripts/setup-launchagents.sh --status     # show current state

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LAUNCH_DIR="$HOME/Library/LaunchAgents"
LOG_DIR="$HOME/logs"

ORCH_LABEL="com.unsaltedbutter.orchestrator"
AGENT_LABEL="com.unsaltedbutter.agent"
ORCH_PLIST="$LAUNCH_DIR/${ORCH_LABEL}.plist"
AGENT_PLIST="$LAUNCH_DIR/${AGENT_LABEL}.plist"

# ── Helpers ──────────────────────────────────────────────────

die() { echo "ERROR: $1" >&2; exit 1; }

unload_if_loaded() {
    local label="$1"
    # bootout returns 0 if successful, non-zero if not loaded (both are fine)
    launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
}

load_agent() {
    local plist="$1"
    local label="$2"
    unload_if_loaded "$label"
    launchctl bootstrap "gui/$(id -u)" "$plist"
    echo "  $label: loaded"
}

# ── Status ───────────────────────────────────────────────────

show_status() {
    echo "=== LaunchAgent Status ==="
    echo ""
    for label in "$ORCH_LABEL" "$AGENT_LABEL"; do
        local plist="$LAUNCH_DIR/${label}.plist"
        if [ -f "$plist" ]; then
            echo "  $label"
            echo "    plist: $plist"
            # launchctl print exits 0 if the service exists
            if launchctl print "gui/$(id -u)/$label" &>/dev/null; then
                local pid
                pid=$(launchctl print "gui/$(id -u)/$label" 2>/dev/null | grep -m1 'pid =' | awk '{print $3}' || echo "?")
                echo "    state: running (pid $pid)"
            else
                echo "    state: not loaded"
            fi
        else
            echo "  $label: not installed"
        fi
    done
}

# ── Uninstall ────────────────────────────────────────────────

uninstall() {
    echo "=== Uninstalling LaunchAgents ==="
    for label in "$ORCH_LABEL" "$AGENT_LABEL"; do
        unload_if_loaded "$label"
        local plist="$LAUNCH_DIR/${label}.plist"
        if [ -f "$plist" ]; then
            rm "$plist"
            echo "  $label: removed"
        else
            echo "  $label: not installed (skip)"
        fi
    done
    echo "Done."
}

# ── Install ──────────────────────────────────────────────────

install() {
    if [ "$(uname -s)" != "Darwin" ]; then
        die "LaunchAgents are macOS only."
    fi

    echo "=== Installing LaunchAgents ==="
    echo ""
    echo "Project: $PROJECT_ROOT"

    # Verify components exist
    [ -f "$PROJECT_ROOT/orchestrator/orchestrator.py" ] || die "orchestrator.py not found"
    [ -f "$PROJECT_ROOT/agent/server.py" ]              || die "agent/server.py not found"
    [ -d "$PROJECT_ROOT/orchestrator/venv" ]            || die "orchestrator venv not found (run setup-orchestrator.sh first)"
    [ -d "$PROJECT_ROOT/agent/venv" ]                   || die "agent venv not found (run setup-agent.sh first)"

    mkdir -p "$LAUNCH_DIR"
    mkdir -p "$LOG_DIR"

    # -- Orchestrator plist --
    cat > "$ORCH_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${ORCH_LABEL}</string>

    <key>ProgramArguments</key>
    <array>
        <string>${PROJECT_ROOT}/orchestrator/venv/bin/python</string>
        <string>orchestrator.py</string>
    </array>

    <key>WorkingDirectory</key>
    <string>${PROJECT_ROOT}/orchestrator</string>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>

    <key>ThrottleInterval</key>
    <integer>10</integer>

    <key>StandardOutPath</key>
    <string>${LOG_DIR}/orchestrator-stdout.log</string>

    <key>StandardErrorPath</key>
    <string>${LOG_DIR}/orchestrator-stderr.log</string>
</dict>
</plist>
PLIST
    echo "  $ORCH_LABEL: plist written"

    # -- Agent plist --
    # PYTHONPATH must include project root so "from agent.xxx import yyy" works.
    # 10s delay (ThrottleInterval) gives orchestrator time to start.
    cat > "$AGENT_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${AGENT_LABEL}</string>

    <key>ProgramArguments</key>
    <array>
        <string>${PROJECT_ROOT}/agent/venv/bin/python</string>
        <string>server.py</string>
    </array>

    <key>WorkingDirectory</key>
    <string>${PROJECT_ROOT}/agent</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>PYTHONPATH</key>
        <string>${PROJECT_ROOT}</string>
    </dict>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>

    <key>ThrottleInterval</key>
    <integer>10</integer>

    <key>LimitLoadToSessionType</key>
    <string>Aqua</string>

    <key>StandardOutPath</key>
    <string>${LOG_DIR}/agent-stdout.log</string>

    <key>StandardErrorPath</key>
    <string>${LOG_DIR}/agent-stderr.log</string>
</dict>
</plist>
PLIST
    echo "  $AGENT_LABEL: plist written"

    # -- Load both --
    echo ""
    load_agent "$ORCH_PLIST" "$ORCH_LABEL"
    load_agent "$AGENT_PLIST" "$AGENT_LABEL"

    echo ""
    echo "=== Done ==="
    echo ""
    echo "Logs:"
    echo "  tail -f ~/logs/orchestrator-stdout.log"
    echo "  tail -f ~/logs/agent-stdout.log"
    echo ""
    echo "Control:"
    echo "  launchctl kickstart -k gui/$(id -u)/$ORCH_LABEL   # restart orchestrator"
    echo "  launchctl kickstart -k gui/$(id -u)/$AGENT_LABEL  # restart agent"
    echo "  ./scripts/setup-launchagents.sh --status           # check state"
    echo "  ./scripts/setup-launchagents.sh --uninstall        # remove"
}

# ── Main ─────────────────────────────────────────────────────

case "${1:-}" in
    --uninstall) uninstall ;;
    --status)    show_status ;;
    *)           install ;;
esac
