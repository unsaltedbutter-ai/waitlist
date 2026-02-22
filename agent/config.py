"""Agent configuration: constants, timeouts, paths."""

from __future__ import annotations

import os
from pathlib import Path

# --- Inference (Mac Studio) ---
INFERENCE_URL = os.getenv('STUDIO_URL', 'http://192.168.1.100:8420')
AGENT_PORT = int(os.getenv('AGENT_PORT', '8421'))

# --- Paths ---

def _resolve_playbook_dir() -> Path:
    """Resolve playbook directory: env var > private package > local examples."""
    env = os.environ.get('PLAYBOOK_DIR')
    if env:
        p = Path(env)
        if p.is_dir():
            return p
    try:
        from unsaltedbutter_prompts.playbooks import get_playbook_dir  # type: ignore[import-untyped]
        return get_playbook_dir()
    except ImportError:
        pass
    return Path(__file__).parent / 'playbooks'


PLAYBOOK_DIR = _resolve_playbook_dir()
PLAYBOOK_REF_DIR = PLAYBOOK_DIR / 'ref'
SCREENSHOT_DIR = Path('/tmp/ub-screenshots')

# --- Page-based playbook paths ---

def _resolve_pages_dir() -> Path:
    """Resolve page playbooks directory: env var > private package > local examples."""
    env = os.environ.get('PAGE_PLAYBOOKS_DIR')
    if env:
        p = Path(env)
        if p.is_dir():
            return p
    try:
        from unsaltedbutter_prompts.playbooks import get_pages_dir  # type: ignore[import-untyped]
        return get_pages_dir()
    except (ImportError, AttributeError):
        pass
    return Path(__file__).parent / 'playbooks' / 'pages'


def _resolve_flows_dir() -> Path:
    """Resolve flow configs directory: env var > private package > local examples."""
    env = os.environ.get('FLOWS_DIR')
    if env:
        p = Path(env)
        if p.is_dir():
            return p
    try:
        from unsaltedbutter_prompts.playbooks import get_flows_dir  # type: ignore[import-untyped]
        return get_flows_dir()
    except (ImportError, AttributeError):
        pass
    return Path(__file__).parent / 'playbooks' / 'flows'


PAGES_DIR = _resolve_pages_dir()
FLOWS_DIR = _resolve_flows_dir()
PAGE_HASH_DB = Path(os.getenv(
    'PAGE_HASH_DB',
    str(Path.home() / '.unsaltedbutter' / 'page_hashes.db'),
))
def _resolve_ref_screenshots_dir() -> Path:
    """Resolve ref screenshots directory: env var > private package > local."""
    env = os.environ.get('REF_SCREENSHOTS_DIR')
    if env:
        p = Path(env)
        if p.is_dir():
            return p
    try:
        from unsaltedbutter_prompts.playbooks import get_ref_screenshots_dir  # type: ignore[import-untyped]
        return get_ref_screenshots_dir()
    except (ImportError, AttributeError):
        pass
    return Path(__file__).parent / 'playbooks' / 'ref_screenshots'

REF_SCREENSHOTS_DIR = _resolve_ref_screenshots_dir()
REVIEW_QUEUE_DIR = Path(os.getenv(
    'REVIEW_QUEUE_DIR',
    str(Path.home() / '.unsaltedbutter' / 'review_queue'),
))

# --- Timeouts (seconds) ---
STEP_TIMEOUT = 60.0
TOTAL_EXECUTION_TIMEOUT = 300.0
INFERENCE_TIMEOUT = 45.0
PAGE_LOAD_WAIT = 2.5

# --- Recording ---
RECORD_DWELL_THRESHOLD_SEC = 3.0
RECORD_DWELL_RADIUS_PX = 5

# --- Template variables ---
# Normal (not sensitive)
NORMAL_VARS = frozenset({'{email}', '{name}', '{zip}', '{birth}', '{gender}'})

# Sensitive (never logged, never sent to VLM)
SENSITIVE_VARS = frozenset({'{pass}', '{cvv}'})

# All template vars
ALL_VARS = NORMAL_VARS | SENSITIVE_VARS

# Special key sequences (stripped from value, become press_key steps)
KEY_VARS = frozenset({'{tab}', '{return}'})

# Display hint for recording prompts
VARS_HINT = '{email} {pass} {cvv} {name} {zip} {birth} {gender} {tab} {return}'
