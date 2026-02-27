"""Agent configuration: constants, timeouts, paths."""

from __future__ import annotations

import os
from pathlib import Path

AGENT_PORT = int(os.getenv('AGENT_PORT', '8421'))
MAX_CONCURRENT_AGENT_JOBS = int(os.getenv('MAX_CONCURRENT_AGENT_JOBS', '3'))

# --- VLM (production executor) ---
# WARNING: These module-level constants are read at import time, BEFORE
# dotenv loads agent.env. They may be stale. Use get_vlm_config() for
# values that are guaranteed to reflect the loaded env files.
VLM_URL = os.getenv('VLM_URL', '')
VLM_KEY = os.getenv('VLM_KEY', '')
VLM_MODEL = os.getenv('VLM_MODEL', 'qwen3-vl-32b')
VLM_MAX_WIDTH = int(os.getenv('VLM_MAX_WIDTH', '960'))
VLM_COORD_NORMALIZE = os.getenv('VLM_COORD_NORMALIZE', 'true').lower() in ('1', 'true', 'yes')
VLM_COORD_YX = os.getenv('VLM_COORD_YX', '').lower() in ('1', 'true', 'yes')
VLM_COORD_SQUARE_PAD = os.getenv('VLM_COORD_SQUARE_PAD', '').lower() in ('1', 'true', 'yes')


def get_vlm_config() -> dict:
    """Read VLM configuration from os.environ at call time.

    Module-level VLM_* constants are set at import time, before dotenv
    loads agent.env, so they may be stale. This function reads os.environ
    after dotenv has run. Call it from code that runs after main().
    """
    def _bool(key: str, default: str) -> bool:
        return os.environ.get(key, default).lower() in ('1', 'true', 'yes')

    return {
        'url': os.environ.get('VLM_URL', ''),
        'key': os.environ.get('VLM_KEY', ''),
        'model': os.environ.get('VLM_MODEL', 'qwen3-vl-32b'),
        'max_width': int(os.environ.get('VLM_MAX_WIDTH', '960')),
        'coord_normalize': _bool('VLM_COORD_NORMALIZE', 'true'),
        'coord_yx': _bool('VLM_COORD_YX', ''),
        'coord_square_pad': _bool('VLM_COORD_SQUARE_PAD', ''),
    }

SERVICE_URLS: dict[str, str] = {
    'netflix': 'https://www.netflix.com/',
    'hulu': 'https://secure.hulu.com/account/login',
    'disney_plus': 'https://www.disneyplus.com/login',
    'paramount': 'https://www.paramountplus.com/account/signin/',
    'peacock': 'https://www.peacocktv.com/signin',
    'max': 'https://play.max.com/login',
}

# Scroll clicks to apply after navigating to the login page, before the
# first screenshot. Useful when the service homepage has a distracting nav
# link (e.g. Netflix "Sign In") that pulls the VLM away from the hero CTA.
# 0 or absent = no scroll.
PRE_LOGIN_SCROLL: dict[str, int] = {
    'netflix': 3,
}

# Zoom-out steps after navigating to the account page. Default is 2 (80%).
# Only override for services that need more zoom to get the cancel/resume
# button above the fold.
ACCOUNT_ZOOM_DEFAULT = 2
ACCOUNT_ZOOM_STEPS: dict[str, int] = {
    'netflix': 4,  # 67%: Cancel Membership is buried below the fold
}

ACCOUNT_URLS: dict[str, str] = {
    'netflix': 'https://www.netflix.com/account',
    'hulu': 'https://secure.hulu.com/account',
    'disney_plus': 'https://www.disneyplus.com/account',
    'paramount': 'https://www.paramountplus.com/account/',
    'peacock': 'https://www.peacocktv.com/account',
    'max': 'https://play.max.com/account',
}

# Whether to navigate directly to the account URL after sign-in.
# Set to False for services that redirect back to a profile picker
# or otherwise block direct account URL access.
ACCOUNT_URL_JUMP: dict[str, bool] = {
    'netflix': True,
    'hulu': True,
    'disney_plus': False,
    'paramount': True,
    'peacock': True,
    'max': True,
}

# --- Paths ---

SCREENSHOT_DIR = Path('/tmp/ub-screenshots')

# --- Timeouts (seconds) ---
TOTAL_EXECUTION_TIMEOUT = 300.0
PAGE_LOAD_WAIT = 2.5
# SETTLE_DELAY: read at runtime via os.environ.get('SETTLE_DELAY', '2.5')
# in VLMExecutor.__init__ to avoid stale import-time reads.
