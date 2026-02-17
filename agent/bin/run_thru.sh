#!/usr/bin/env bash
# Smoke test: browser lifecycle + screenshot capture
# Run from the agent/bin/ directory or anywhere (uses script-relative paths).

set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"

step() {
    echo ""
    echo "=== $1 ==="
    echo ""
}

pause() {
    sleep "${1:-2}"
}

step "1/7  Launch Chrome (1280x900)"
"$DIR/chrome" open --width 1280 --height 900
pause 1

step "2/7  Check session status"
"$DIR/chrome" status
pause 1

step "3/7  Navigate to netflix.com"
"$DIR/chrome" navigate https://www.netflix.com
pause 3

step "4/7  Confirm Chrome window is listed"
"$DIR/windows" "Google Chrome"
pause 1

step "5/7  Capture screenshot"
SCREENSHOT=$("$DIR/screenshot")
echo "Saved: $SCREENSHOT"
open "$SCREENSHOT"
pause 2

step "6/7  Close Chrome and clean up"
"$DIR/chrome" close
pause 1

step "7/7  Verify temp profile is gone"
REMAINING=$(ls -d /tmp/ub-chrome-* 2>/dev/null || true)
if [ -z "$REMAINING" ]; then
    echo "Clean: no leftover profile dirs"
else
    echo "WARNING: leftover dirs found:"
    echo "$REMAINING"
fi

echo ""
echo "Done."
