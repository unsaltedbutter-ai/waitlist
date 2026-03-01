"""
Screenshot capture via macOS screencapture.

Captures a specific window by its CGWindowID using
`screencapture -l <windowID>`. No full-screen grabs,
no desktop background bleed.
"""

from __future__ import annotations

import base64
import io
import os
import subprocess
import tempfile
import time

from agent.input import window

# Chrome's tab bar + address bar height in logical (non-Retina) pixels.
# Physical pixel crop = int(CHROME_HEIGHT_LOGICAL * retina_scale).
# NOTE: This module-level default may be stale if dotenv loads after import.
# crop_browser_chrome() re-reads os.environ at call time to pick up late values.
CHROME_HEIGHT_LOGICAL = int(os.getenv('CHROME_HEIGHT', '88'))


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


def png_dimensions(b64: str) -> tuple[int, int]:
    """Extract (width, height) from a base64-encoded PNG without full decode.

    Reads the IHDR chunk: bytes 16-19 are width, 20-23 are height (big-endian).
    """
    import struct
    raw = base64.b64decode(b64[:200])  # IHDR is within the first ~33 bytes
    if raw[:8] != b'\x89PNG\r\n\x1a\n':
        raise ValueError('Not a valid PNG')
    width, height = struct.unpack('>II', raw[16:24])
    return width, height


def b64_to_image(b64: str) -> 'Image.Image':
    """Decode a base64-encoded PNG into a PIL Image."""
    from PIL import Image

    raw = base64.b64decode(b64)
    return Image.open(io.BytesIO(raw))


def crop_browser_chrome(screenshot_b64: str) -> tuple[str, int]:
    """Remove browser chrome (tab bar + address bar) from a screenshot.

    Crops the top N physical pixels corresponding to CHROME_HEIGHT_LOGICAL
    scaled by the display's Retina factor.

    Args:
        screenshot_b64: Base64-encoded PNG of the full Chrome window.

    Returns:
        (cropped_b64, chrome_height_px): cropped base64 PNG and the number
        of physical pixels that were removed. The caller needs chrome_height_px
        to convert page-relative VLM coords back to screen coords.
    """
    from PIL import Image

    # Re-read at call time: dotenv loads agent.env after module import,
    # so the module-level CHROME_HEIGHT_LOGICAL may still be the default.
    chrome_logical = int(os.environ.get('CHROME_HEIGHT', '88'))
    scale = window.get_retina_scale()
    chrome_px = int(chrome_logical * scale)

    # No stripping requested
    if chrome_px <= 0:
        return screenshot_b64, 0

    raw = base64.b64decode(screenshot_b64)
    img = Image.open(io.BytesIO(raw))

    # Guard: don't crop if the image is too short
    if img.height <= chrome_px:
        return screenshot_b64, 0

    cropped = img.crop((0, chrome_px, img.width, img.height))
    buf = io.BytesIO()
    cropped.save(buf, format='PNG')
    cropped_b64 = base64.b64encode(buf.getvalue()).decode('ascii')
    return cropped_b64, chrome_px
