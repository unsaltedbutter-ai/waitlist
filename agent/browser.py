"""
Browser lifecycle management.

Launch Chrome with fresh temp profiles, manage the process,
navigate, and tear down after. No headless, no webdriver,
no automation flags.
"""

from __future__ import annotations

import shutil
import signal
import subprocess
import tempfile
import time
from dataclasses import dataclass, field

from agent.input import keyboard, window

CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

CHROME_ARGS = [
    '--no-first-run',
    '--no-default-browser-check',
]


@dataclass
class BrowserSession:
    pid: int
    process: subprocess.Popen
    profile_dir: str
    window_id: int = 0
    bounds: dict = field(default_factory=dict)


def create_session(width: int = 1280, height: int = 900) -> BrowserSession:
    """
    Launch Chrome with a fresh temp profile.

    Creates a disposable profile dir, launches Chrome to about:blank,
    waits for the window to appear, resizes it, and returns the session.
    """
    profile_dir = tempfile.mkdtemp(prefix='ub-chrome-')

    cmd = [CHROME_PATH, f'--user-data-dir={profile_dir}'] + CHROME_ARGS + ['about:blank']
    process = subprocess.Popen(
        cmd,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )

    # Poll for the Chrome window to appear (up to 10s)
    win_info = _wait_for_window('Google Chrome', timeout=10.0)
    if win_info is None:
        # Chrome didn't produce a window; kill and clean up
        process.kill()
        shutil.rmtree(profile_dir, ignore_errors=True)
        raise RuntimeError('Chrome launched but no window appeared within 10s')

    session = BrowserSession(
        pid=process.pid,
        process=process,
        profile_dir=profile_dir,
        window_id=win_info['id'],
        bounds={
            'x': win_info['x'],
            'y': win_info['y'],
            'width': win_info['width'],
            'height': win_info['height'],
        },
    )

    # Resize to requested dimensions
    window.resize_window_by_drag('Google Chrome', width, height)
    time.sleep(0.5)

    # Refresh bounds after resize
    get_session_window(session)

    return session


def close_session(session: BrowserSession) -> None:
    """
    Shut down Chrome and delete the temp profile.

    SIGTERM first, wait up to 3s, then SIGKILL if still alive.
    Always removes the profile directory.
    """
    try:
        session.process.send_signal(signal.SIGTERM)
        session.process.wait(timeout=3)
    except subprocess.TimeoutExpired:
        session.process.kill()
        session.process.wait(timeout=2)
    except OSError:
        pass  # already dead

    shutil.rmtree(session.profile_dir, ignore_errors=True)

    # Verify process is gone
    if session.process.poll() is None:
        session.process.kill()


def navigate(session: BrowserSession, url: str) -> None:
    """
    Navigate Chrome to a URL using keyboard shortcuts.

    Focuses Chrome, Cmd+L to address bar, Cmd+A to select all,
    types the URL, presses Enter, waits for initial load.
    """
    window.focus_window('Google Chrome')
    time.sleep(0.3)

    keyboard.hotkey('command', 'l')
    time.sleep(0.2)

    keyboard.hotkey('command', 'a')
    time.sleep(0.1)

    keyboard.type_text(url, speed='fast', accuracy='high')
    time.sleep(0.1)

    keyboard.press_key('enter')

    # Wait for page to start loading
    time.sleep(2.5)


def get_session_window(session: BrowserSession) -> dict:
    """
    Re-fetch Chrome's window bounds and update the session.

    Returns the current bounds dict: {x, y, width, height}.
    """
    win_info = window.get_window_bounds('Google Chrome')
    if win_info is None:
        raise RuntimeError('Chrome window not found')

    session.window_id = win_info['id']
    session.bounds = {
        'x': win_info['x'],
        'y': win_info['y'],
        'width': win_info['width'],
        'height': win_info['height'],
    }
    return session.bounds


def _wait_for_window(app_name: str, timeout: float = 10.0) -> dict | None:
    """Poll for a window to appear. Returns window info or None on timeout."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        windows = window.list_windows(app_name)
        if windows:
            return windows[0]
        time.sleep(0.5)
    return None
