"""
Extract text from an X.com post URL via Chrome automation.

Opens Chrome, navigates to the URL, selects all text (Cmd+A),
copies to clipboard (Cmd+C), and returns the raw clipboard contents.
The actual post body extraction from the raw clipboard dump is handled
by text_parser.py (LLM-based).

All GUI actions are serialized via gui_lock (Mac Studio display).
"""

from __future__ import annotations

import logging
import shutil
import subprocess
import tempfile
import time

from agent.browser import (
    CHROME_ARGS,
    CHROME_PATH,
    BrowserSession,
    _wait_for_window,
    _write_chrome_prefs,
)
from agent.input import keyboard, window

from tts_agent.gui_lock import gui_lock

log = logging.getLogger(__name__)

# Longer page load for X.com (JS-heavy SPA)
PAGE_LOAD_WAIT = 5.0


def extract_clipboard_text(url: str) -> str:
    """Open Chrome, navigate to URL, Cmd+A, Cmd+C, return clipboard text.

    Launches a fresh Chrome profile, navigates to the tweet URL, waits
    for the page to load, selects all text, copies to clipboard, reads
    clipboard, then tears down the browser.

    Returns the raw clipboard text (not yet parsed for tweet body).
    Raises RuntimeError on failure.
    """
    session = _create_session()
    try:
        _navigate(session, url)
        time.sleep(PAGE_LOAD_WAIT)
        return _select_all_copy(session)
    finally:
        _close_session(session)


def _create_session() -> BrowserSession:
    """Launch Chrome with a fresh temp profile for text extraction."""
    profile_dir = tempfile.mkdtemp(prefix="ub-tts-chrome-")
    _write_chrome_prefs(profile_dir)

    cmd = [CHROME_PATH, f"--user-data-dir={profile_dir}"] + CHROME_ARGS + ["about:blank"]
    process = subprocess.Popen(
        cmd,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )

    win_info = _wait_for_window("Google Chrome", pid=process.pid, timeout=10.0)
    if win_info is None:
        process.kill()
        shutil.rmtree(profile_dir, ignore_errors=True)
        raise RuntimeError("Chrome launched but no window appeared within 10s")

    session = BrowserSession(
        pid=process.pid,
        process=process,
        profile_dir=profile_dir,
        window_id=win_info["id"],
        bounds={
            "x": win_info["x"],
            "y": win_info["y"],
            "width": win_info["width"],
            "height": win_info["height"],
        },
    )

    with gui_lock:
        window.focus_window_by_pid(process.pid)
        time.sleep(0.1)

    log.info("Chrome session created (pid=%d)", process.pid)
    return session


def _navigate(session: BrowserSession, url: str) -> None:
    """Navigate Chrome to a URL using keyboard shortcuts."""
    with gui_lock:
        window.focus_window_by_pid(session.pid)
        time.sleep(0.05)

        keyboard.hotkey("command", "l")
        time.sleep(0.05)

        keyboard.hotkey("command", "a")
        time.sleep(0.03)

        subprocess.run(["pbcopy"], input=url.encode(), check=True)
        keyboard.hotkey("command", "v")
        time.sleep(0.03)

        keyboard.press_key("enter")

    log.info("Navigating to %s", url)


def _select_all_copy(session: BrowserSession) -> str:
    """Cmd+A, Cmd+C, read clipboard. Returns clipboard text."""
    with gui_lock:
        window.focus_window_by_pid(session.pid)
        time.sleep(0.1)

        keyboard.hotkey("command", "a")
        time.sleep(0.3)

        keyboard.hotkey("command", "c")
        time.sleep(0.3)

    # Read clipboard (outside gui_lock)
    result = subprocess.run(
        ["pbpaste"],
        capture_output=True,
        text=True,
        timeout=5,
    )

    text = result.stdout
    log.info("Clipboard captured: %d characters", len(text))
    return text


def _close_session(session: BrowserSession) -> None:
    """Kill Chrome and delete the temp profile."""
    import os
    import signal

    try:
        os.kill(session.pid, signal.SIGTERM)
    except OSError:
        pass

    deadline = time.monotonic() + 3.0
    while time.monotonic() < deadline:
        try:
            os.kill(session.pid, 0)
        except OSError:
            break
        time.sleep(0.2)
    else:
        try:
            os.kill(session.pid, signal.SIGKILL)
        except OSError:
            pass

    shutil.rmtree(session.profile_dir, ignore_errors=True)
    log.info("Chrome session closed (pid=%d)", session.pid)
