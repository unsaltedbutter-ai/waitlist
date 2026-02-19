"""Shared pytest configuration for orchestrator tests."""

from __future__ import annotations

import sys
from pathlib import Path

# Add the orchestrator root to sys.path so tests can import modules directly.
_ORCHESTRATOR_ROOT = str(Path(__file__).resolve().parent.parent)
if _ORCHESTRATOR_ROOT not in sys.path:
    sys.path.insert(0, _ORCHESTRATOR_ROOT)
