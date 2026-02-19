"""Shared pytest configuration for agent tests."""

from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import MagicMock

import pytest

# The agent/ directory is a namespace package (no __init__.py). Modules inside
# use `from agent.xxx import ...` style imports. For that to resolve correctly,
# the PROJECT ROOT (parent of agent/) must be in sys.path, and the agent/
# directory itself must NOT shadow the package (agent.py lives inside agent/
# and would shadow the package if agent/ were on sys.path).
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

# aiohttp stub (agent.py imports it; not needed for unit tests)
_aiohttp = MagicMock()
sys.modules.setdefault('aiohttp', _aiohttp)
sys.modules.setdefault('aiohttp.web', _aiohttp.web)

# dotenv stub (agent.py imports it)
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

# ---------------------------------------------------------------------------
# Shared fixtures
# ---------------------------------------------------------------------------

from agent.inference import (
    CheckpointResult,
    FindElementResult,
    MockInferenceClient,
)
from agent.playbook import JobContext, Playbook, PlaybookStep


@pytest.fixture()
def mock_inference() -> MockInferenceClient:
    """A MockInferenceClient with default image dimensions."""
    return MockInferenceClient(image_width=2560, image_height=1800)


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


@pytest.fixture()
def simple_playbook() -> Playbook:
    """A minimal playbook with navigate, click, and verify_success steps."""
    return Playbook(
        service='netflix',
        flow='cancel',
        version=1,
        notes='Test playbook',
        last_validated=None,
        steps=(
            PlaybookStep(
                action='navigate',
                url='https://www.netflix.com/login',
            ),
            PlaybookStep(
                action='click',
                target_description='Sign In button',
                ref_region=(500, 300, 700, 350),
            ),
            PlaybookStep(
                action='verify_success',
                checkpoint=True,
                checkpoint_prompt='Is the cancel confirmed?',
            ),
        ),
    )
