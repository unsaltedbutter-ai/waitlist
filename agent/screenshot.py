"""
Screenshot capture via macOS screencapture.

Captures a specific window by its CGWindowID using
`screencapture -l <windowID>`. No full-screen grabs,
no desktop background bleed.
"""

from __future__ import annotations

import base64
import os
import subprocess
import tempfile
import time

from agent.input import window


def capture_window(window_id: int, output_path: str | None = None) -> str:
    """
    Capture a specific window by its CGWindowID.

    Uses `screencapture -l <windowID> -o <path>` where -o suppresses
    the drop shadow. Returns the path to the saved PNG.
    """
    if output_path is None:
        timestamp = int(time.time() * 1000)
        output_path = f'/tmp/ub-screenshot-{timestamp}.png'

    result = subprocess.run(
        ['screencapture', '-l', str(window_id), '-o', output_path],
        capture_output=True,
        text=True,
    )

    if result.returncode != 0:
        raise RuntimeError(f'screencapture failed (exit {result.returncode}): {result.stderr}')

    if not os.path.exists(output_path) or os.path.getsize(output_path) == 0:
        raise RuntimeError(f'screencapture produced no output at {output_path}')

    return output_path


def capture_chrome(app_name: str = 'Google Chrome', output_path: str | None = None) -> str:
    """
    Convenience: find Chrome's window ID and capture it.

    Raises RuntimeError if the app has no visible window.
    """
    win = window.get_window_bounds(app_name)
    if win is None:
        raise RuntimeError(f'No visible window found for {app_name}')

    return capture_window(win['id'], output_path)


def capture_to_bytes(window_id: int) -> bytes:
    """Capture a window and return the PNG data as bytes."""
    tmp_path = None
    try:
        tmp_fd, tmp_path = tempfile.mkstemp(suffix='.png', prefix='ub-cap-')
        os.close(tmp_fd)

        capture_window(window_id, tmp_path)

        with open(tmp_path, 'rb') as f:
            return f.read()
    finally:
        if tmp_path and os.path.exists(tmp_path):
            os.unlink(tmp_path)


def capture_to_base64(window_id: int) -> str:
    """Capture a window and return base64-encoded PNG data."""
    raw = capture_to_bytes(window_id)
    return base64.b64encode(raw).decode('ascii')
