"""
Browser lifecycle management.

Launch Chrome with fresh temp profiles, manage the process,
navigate, and tear down after. No headless, no webdriver,
no automation flags.
"""

from __future__ import annotations

import os
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
    process: subprocess.Popen | None  # None when restored from disk
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

    # Poll for the Chrome window to appear (up to 10s), scoped to this PID
    win_info = _wait_for_window('Google Chrome', pid=process.pid, timeout=10.0)
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

    # Focus and resize to requested dimensions (fast: no human-like timing)
    window.focus_window_by_pid(process.pid)
    time.sleep(0.05)
    window.resize_window_by_drag('Google Chrome', width, height, fast=True)
    time.sleep(0.2)

    # Refresh bounds after resize
    get_session_window(session)

    return session


def close_session(session: BrowserSession) -> None:
    """
    Shut down Chrome and delete the temp profile.

    SIGTERM first, wait up to 3s, then SIGKILL if still alive.
    Always removes the profile directory.
    """
    _kill_pid(session.pid)
    shutil.rmtree(session.profile_dir, ignore_errors=True)


def _kill_pid(pid: int) -> None:
    """SIGTERM a process, wait up to 3s, SIGKILL if still alive."""
    try:
        os.kill(pid, signal.SIGTERM)
    except OSError:
        return  # already dead

    deadline = time.monotonic() + 3.0
    while time.monotonic() < deadline:
        try:
            os.kill(pid, 0)  # probe
        except OSError:
            return  # gone
        time.sleep(0.2)

    # Still alive after 3s
    try:
        os.kill(pid, signal.SIGKILL)
    except OSError:
        pass


def navigate(session: BrowserSession, url: str, fast: bool = False) -> None:
    """
    Navigate Chrome to a URL using keyboard shortcuts.

    Focuses the specific Chrome instance by PID, Cmd+L to address bar,
    Cmd+A to select all, types the URL, presses Enter, waits for initial load.

    fast: minimal timing (for initial navigation before human behavior matters)
    """
    window.focus_window_by_pid(session.pid)
    time.sleep(0.05 if fast else 0.3)

    keyboard.hotkey('command', 'l')
    time.sleep(0.05 if fast else 0.2)

    keyboard.hotkey('command', 'a')
    time.sleep(0.03 if fast else 0.1)

    keyboard.type_text(url, speed='instant' if fast else 'fast', accuracy='high')
    time.sleep(0.03 if fast else 0.1)

    keyboard.press_key('enter')

    # Wait for page to start loading
    time.sleep(2.0 if fast else 2.5)


def get_session_window(session: BrowserSession) -> dict:
    """
    Re-fetch Chrome's window bounds and update the session.
    Uses the session PID to find the correct Chrome instance.

    Returns the current bounds dict: {x, y, width, height}.
    """
    win_info = window.get_window_bounds('Google Chrome', pid=session.pid)
    if win_info is None:
        raise RuntimeError(f'Chrome window not found for PID {session.pid}')

    session.window_id = win_info['id']
    session.bounds = {
        'x': win_info['x'],
        'y': win_info['y'],
        'width': win_info['width'],
        'height': win_info['height'],
    }
    return session.bounds


def _wait_for_window(
    app_name: str, pid: int | None = None, timeout: float = 10.0,
) -> dict | None:
    """Poll for a window to appear. Returns window info or None on timeout."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        windows = window.list_windows(app_name, pid=pid)
        if windows:
            return windows[0]
        time.sleep(0.5)
    return None
