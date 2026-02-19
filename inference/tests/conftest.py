"""Shared pytest configuration for inference server tests."""

from __future__ import annotations

import base64
import io
import sys
from pathlib import Path

import pytest
from PIL import Image

# Add project root to sys.path so `from inference.xxx import ...` works.
_PROJECT_ROOT = str(Path(__file__).resolve().parent.parent.parent)
if _PROJECT_ROOT not in sys.path:
    sys.path.insert(0, _PROJECT_ROOT)


# ---------------------------------------------------------------------------
# Shared fixtures
# ---------------------------------------------------------------------------

@pytest.fixture()
def sample_screenshot_b64() -> str:
    """A minimal valid PNG image encoded as base64 (100x80 white)."""
    img = Image.new("RGB", (100, 80), color=(255, 255, 255))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("ascii")


@pytest.fixture()
def large_screenshot_b64() -> str:
    """A 2560x1800 PNG (Retina-sized) encoded as base64."""
    img = Image.new("RGB", (2560, 1800), color=(200, 200, 200))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("ascii")


@pytest.fixture()
def rgba_screenshot_b64() -> str:
    """An RGBA PNG (transparency) encoded as base64."""
    img = Image.new("RGBA", (200, 150), color=(255, 0, 0, 128))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("ascii")
