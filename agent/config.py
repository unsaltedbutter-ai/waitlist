"""Agent configuration: constants, timeouts, paths."""

from __future__ import annotations

import os
from pathlib import Path

# --- Inference (Mac Studio) ---
INFERENCE_URL = os.getenv('STUDIO_URL', 'http://192.168.1.100:8420')
AGENT_PORT = int(os.getenv('AGENT_PORT', '8421'))

# --- Paths ---
PLAYBOOK_DIR = Path(__file__).parent / 'playbooks'
PLAYBOOK_REF_DIR = PLAYBOOK_DIR / 'ref'
SCREENSHOT_DIR = Path('/tmp/ub-screenshots')

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

# Sensitive (never screenshot after typing these)
SENSITIVE_VARS = frozenset({'{pass}', '{gift}', '{cc}', '{cvv}', '{exp}'})

# All template vars
ALL_VARS = NORMAL_VARS | SENSITIVE_VARS

# Special key sequences (stripped from value, become press_key steps)
KEY_VARS = frozenset({'{tab}', '{return}'})

# Display hint for recording prompts
VARS_HINT = '{email} {pass} {gift} {name} {zip} {birth} {gender} {cc} {cvv} {exp} {tab} {return}'
