"""Agent configuration: constants, timeouts, paths."""

from __future__ import annotations

import os
from pathlib import Path

AGENT_PORT = int(os.getenv('AGENT_PORT', '8421'))
MAX_CONCURRENT_AGENT_JOBS = int(os.getenv('MAX_CONCURRENT_AGENT_JOBS', '3'))

# --- VLM (production executor) ---
VLM_URL = os.getenv('VLM_URL', '')
VLM_KEY = os.getenv('VLM_KEY', '')
VLM_MODEL = os.getenv('VLM_MODEL', 'qwen3-vl-32b')

SERVICE_URLS: dict[str, str] = {
    'netflix': 'https://www.netflix.com/',
    'hulu': 'https://secure.hulu.com/account/login',
    'disney_plus': 'https://www.disneyplus.com/login',
    'paramount': 'https://www.paramountplus.com/account/signin/',
    'peacock': 'https://www.peacocktv.com/signin',
    'max': 'https://play.max.com/login',
}

ACCOUNT_URLS: dict[str, str] = {
    'netflix': 'https://www.netflix.com/account',
    'hulu': 'https://secure.hulu.com/account',
    'disney_plus': 'https://www.disneyplus.com/account',
    'paramount': 'https://www.paramountplus.com/account/',
    'peacock': 'https://www.peacocktv.com/account',
    'max': 'https://play.max.com/account',
}

# --- Paths ---

def _resolve_playbook_dir() -> Path:
    """Resolve playbook directory: env var > private package > local examples."""
    env = os.environ.get('PLAYBOOK_DIR')
    if env:
        p = Path(env)
        if p.is_dir():
            return p
    try:
        from unsaltedbutter_prompts.dev.playbooks import get_playbook_dir  # type: ignore[import-untyped]
        return get_playbook_dir()
    except ImportError:
        pass
    return Path(__file__).parent / 'playbooks'


PLAYBOOK_DIR = _resolve_playbook_dir()
PLAYBOOK_REF_DIR = PLAYBOOK_DIR / 'ref'
SCREENSHOT_DIR = Path('/tmp/ub-screenshots')

# --- Timeouts (seconds) ---
STEP_TIMEOUT = 60.0
TOTAL_EXECUTION_TIMEOUT = 300.0
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
