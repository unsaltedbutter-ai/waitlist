"""Shared pytest configuration for agent tests."""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock

import pytest

# The agent/ directory is a namespace package (no __init__.py). Modules inside
# use `from agent.xxx import ...` style imports. For that to resolve correctly,
# the PROJECT ROOT (parent of agent/) must be in sys.path, and the agent/
# directory itself must NOT be on sys.path (it would shadow the package).
#
# Strategy: insert project root at the front and remove agent/ itself.
_PROJECT_ROOT = str(Path(__file__).resolve().parent.parent.parent)
_AGENT_DIR = str(Path(__file__).resolve().parent.parent)

# Remove agent/ from sys.path if pytest added it (it adds CWD by default)
sys.path[:] = [p for p in sys.path if p != _AGENT_DIR]

# Add project root at the front
if _PROJECT_ROOT not in sys.path:
    sys.path.insert(0, _PROJECT_ROOT)

# ---------------------------------------------------------------------------
# Mock macOS-only modules before any agent code tries to import them.
# Tests must be runnable on Linux CI where pyautogui, Quartz, AppKit,
# and pyobjc are unavailable.
# ---------------------------------------------------------------------------

# aiohttp stub (server.py imports it; not needed for unit tests)
_aiohttp = MagicMock()
sys.modules.setdefault('aiohttp', _aiohttp)
sys.modules.setdefault('aiohttp.web', _aiohttp.web)

# dotenv stub (server.py imports it)
sys.modules.setdefault('dotenv', MagicMock())

# pyautogui stub
_pyautogui = MagicMock()
_pyautogui.PAUSE = 0
_pyautogui.FAILSAFE = True
_pyautogui.position.return_value = (500, 500)
sys.modules.setdefault('pyautogui', _pyautogui)

# Quartz stub (must exist before any import of agent.input.scroll, mouse, window)
_quartz = MagicMock()
_quartz.kCGWindowListOptionOnScreenOnly = 0
_quartz.kCGWindowListExcludeDesktopElements = 0
_quartz.kCGNullWindowID = 0
_quartz.kCGWindowOwnerName = 'kCGWindowOwnerName'
_quartz.kCGWindowName = 'kCGWindowName'
_quartz.kCGWindowLayer = 'kCGWindowLayer'
_quartz.kCGWindowBounds = 'kCGWindowBounds'
_quartz.kCGWindowOwnerPID = 'kCGWindowOwnerPID'
_quartz.kCGWindowNumber = 'kCGWindowNumber'
_quartz.kCGScrollEventUnitPixel = 1
_quartz.kCGEventLeftMouseDragged = 6
_quartz.kCGEventRightMouseDragged = 7
_quartz.kCGMouseButtonLeft = 0
_quartz.kCGHIDEventTap = 0
sys.modules.setdefault('Quartz', _quartz)

# AppKit stub
_appkit = MagicMock()
sys.modules.setdefault('AppKit', _appkit)

# pynput stub
sys.modules.setdefault('pynput', MagicMock())
sys.modules.setdefault('pynput.keyboard', MagicMock())
sys.modules.setdefault('pynput.mouse', MagicMock())

# Set display scale to 1.0 in test environments (Quartz is mocked)
from agent.input.coords import set_display_scale
set_display_scale(1.0)

# ---------------------------------------------------------------------------
# Shared fixtures
# ---------------------------------------------------------------------------

from agent.playbook import JobContext


@pytest.fixture()
def job_context() -> JobContext:
    """A sample job context with credentials for testing."""
    return JobContext(
        job_id='test-job-001',
        user_id='user-abc',
        service='netflix',
        flow='cancel',
        credentials={
            'email': 'alice@example.com',
            'pass': 's3cretP@ss',
            'name': 'Alice Smith',
            'zip': '90210',
        },
    )


# ---------------------------------------------------------------------------
# Shared VLMExecutor system mocks
# ---------------------------------------------------------------------------

def make_mock_session() -> MagicMock:
    """Create a mock BrowserSession for VLMExecutor tests."""
    session = MagicMock()
    session.pid = 12345
    session.window_id = 42
    session.bounds = {'x': 0, 'y': 0, 'width': 1280, 'height': 900}
    session.profile_dir = '/tmp/ub-chrome-test'
    return session


def apply_vlm_system_mocks(
    monkeypatch: Any,
    *,
    screenshot_b64: str = 'AAAA',
    session: MagicMock | None = None,
) -> MagicMock:
    """Patch all system interactions used by VLMExecutor.

    Mocks browser, input devices, screenshots, subprocess, random, and
    time.sleep so VLMExecutor tests run without real Chrome or macOS APIs.

    Args:
        monkeypatch: pytest monkeypatch fixture.
        screenshot_b64: Base64 string returned by screenshot capture.
        session: Optional pre-built mock session. Creates one if None.

    Returns:
        The mock BrowserSession used by the patches.
    """
    if session is None:
        session = make_mock_session()

    monkeypatch.setattr('agent.vlm_executor.browser.create_session', lambda: session)
    monkeypatch.setattr('agent.vlm_executor.browser.navigate', lambda *a, **kw: None)
    monkeypatch.setattr('agent.vlm_executor.browser.get_session_window', lambda s: s.bounds)
    monkeypatch.setattr('agent.vlm_executor.browser.close_session', lambda s: None)
    monkeypatch.setattr('agent.vlm_executor.ss.capture_to_base64',
                        lambda wid: screenshot_b64)
    monkeypatch.setattr('agent.vlm_executor.crop_browser_chrome',
                        lambda b64: (b64, 88))
    monkeypatch.setattr('agent.vlm_executor.mouse.click',
                        lambda x, y, fast=False: None)
    monkeypatch.setattr('agent.vlm_executor.mouse.move_to',
                        lambda x, y, fast=False: None)
    # Default cursor inside typical test bboxes so restore doesn't fire unexpectedly
    monkeypatch.setattr('agent.vlm_executor.mouse.position', lambda: (200, 225))
    monkeypatch.setattr('agent.vlm_executor.keyboard.hotkey', lambda *a: None)
    monkeypatch.setattr('agent.vlm_executor.keyboard.press_key', lambda k: None)
    monkeypatch.setattr('agent.vlm_executor.keyboard.type_text',
                        lambda *a, **kw: None)
    monkeypatch.setattr('agent.vlm_executor.scroll_mod.scroll',
                        lambda d, c: None)
    monkeypatch.setattr('agent.vlm_executor.coords.image_to_screen',
                        lambda x, y, bounds, chrome_offset=0: (x, y))
    monkeypatch.setattr('agent.vlm_executor.focus_window_by_pid',
                        lambda pid: None)
    monkeypatch.setattr('agent.vlm_executor._clipboard_copy', lambda t: None)
    monkeypatch.setattr('agent.vlm_executor.time.sleep', lambda s: None)
    monkeypatch.setattr('agent.vlm_executor.random.gauss',
                        lambda mu, sigma: mu)
    monkeypatch.setattr('agent.vlm_executor.random.uniform',
                        lambda a, b: a)
    monkeypatch.setattr('agent.vlm_executor.random.random', lambda: 0.5)

    return session


@pytest.fixture()
def mock_vlm_system(monkeypatch) -> MagicMock:
    """Pytest fixture that applies all VLMExecutor system mocks.

    Returns the mock BrowserSession. Request this fixture by name
    in test files that need VLMExecutor mocking.
    """
    return apply_vlm_system_mocks(monkeypatch)
