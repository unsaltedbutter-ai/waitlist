"""Tests for model loading, response parsing, image preprocessing, and mock backend.

Run: python -m pytest inference/tests/test_model.py -v
"""

from __future__ import annotations

import base64
import io
import json

import pytest
from PIL import Image

from inference.config import Config
from inference.model import (
    CheckpointResponse,
    FindElementResponse,
    InferActionResponse,
    MockBackend,
    _extract_json,
    create_backend,
    parse_checkpoint,
    parse_find_element,
    parse_infer_action,
    preprocess_image,
)


# ---------------------------------------------------------------------------
# JSON extraction from VLM output
# ---------------------------------------------------------------------------

class TestExtractJson:
    """VLMs return JSON in various wrappers. We must handle them all."""

    def test_clean_json(self) -> None:
        raw = '{"x1": 100, "y1": 200, "x2": 300, "y2": 400, "confidence": 0.9}'
        result = _extract_json(raw)
        assert result["x1"] == 100

    def test_json_with_whitespace(self) -> None:
        raw = '  \n  {"x1": 10, "y1": 20, "x2": 30, "y2": 40, "confidence": 0.5}\n  '
        result = _extract_json(raw)
        assert result["x1"] == 10

    def test_json_in_markdown_fence(self) -> None:
        raw = '```json\n{"x1": 50, "y1": 60, "x2": 150, "y2": 160, "confidence": 0.8}\n```'
        result = _extract_json(raw)
        assert result["x1"] == 50

    def test_json_in_fence_without_lang(self) -> None:
        raw = '```\n{"on_track": true, "confidence": 0.95, "reasoning": "OK"}\n```'
        result = _extract_json(raw)
        assert result["on_track"] is True

    def test_json_with_preamble(self) -> None:
        raw = 'Here is the result:\n{"x1": 10, "y1": 20, "x2": 30, "y2": 40, "confidence": 0.7}'
        result = _extract_json(raw)
        assert result["x1"] == 10

    def test_json_with_trailing_text(self) -> None:
        raw = '{"action": "click", "target_x": 500, "target_y": 300, "text": "", "confidence": 0.8, "reasoning": "button"}\nI hope this helps!'
        result = _extract_json(raw)
        assert result["action"] == "click"

    def test_invalid_json_raises(self) -> None:
        with pytest.raises(ValueError, match="Could not extract JSON"):
            _extract_json("This is not JSON at all")

    def test_empty_string_raises(self) -> None:
        with pytest.raises(ValueError, match="Could not extract JSON"):
            _extract_json("")

    def test_nested_braces_in_reasoning(self) -> None:
        raw = '{"on_track": true, "confidence": 0.9, "reasoning": "Page shows {cancel} dialog"}'
        result = _extract_json(raw)
        assert result["on_track"] is True
        assert "{cancel}" in result["reasoning"]


# ---------------------------------------------------------------------------
# Response parsers
# ---------------------------------------------------------------------------

class TestParseFindElement:
    """Parse find_element VLM output into structured response."""

    def test_valid(self) -> None:
        raw = json.dumps({
            "x1": 100, "y1": 200, "x2": 300, "y2": 400, "confidence": 0.92
        })
        result = parse_find_element(raw, inference_ms=150)
        assert isinstance(result, FindElementResponse)
        assert result.x1 == 100
        assert result.y2 == 400
        assert result.confidence == 0.92
        assert result.inference_ms == 150

    def test_missing_confidence(self) -> None:
        raw = json.dumps({"x1": 10, "y1": 20, "x2": 30, "y2": 40})
        result = parse_find_element(raw, inference_ms=100)
        assert result.confidence == 0.0

    def test_float_coordinates_truncated(self) -> None:
        raw = json.dumps({"x1": 10.7, "y1": 20.3, "x2": 30.9, "y2": 40.1, "confidence": 0.8})
        result = parse_find_element(raw, inference_ms=100)
        assert result.x1 == 10
        assert result.y2 == 40


class TestParseCheckpoint:
    """Parse checkpoint VLM output into structured response."""

    def test_on_track(self) -> None:
        raw = json.dumps({
            "on_track": True, "confidence": 0.95,
            "reasoning": "Login page is visible with email and password fields.",
        })
        result = parse_checkpoint(raw, inference_ms=200)
        assert isinstance(result, CheckpointResponse)
        assert result.on_track is True
        assert result.confidence == 0.95
        assert "Login page" in result.reasoning

    def test_off_track(self) -> None:
        raw = json.dumps({
            "on_track": False, "confidence": 0.3,
            "reasoning": "Expected cancel page but see the home page.",
        })
        result = parse_checkpoint(raw, inference_ms=180)
        assert result.on_track is False

    def test_missing_fields_default(self) -> None:
        raw = json.dumps({"on_track": True})
        result = parse_checkpoint(raw, inference_ms=100)
        assert result.confidence == 0.0
        assert result.reasoning == ""


class TestParseInferAction:
    """Parse infer_action VLM output into structured response."""

    def test_click(self) -> None:
        raw = json.dumps({
            "action": "click", "target_x": 500, "target_y": 300,
            "text": "", "confidence": 0.85,
            "reasoning": "Cancel button is at center-right.",
        })
        result = parse_infer_action(raw, inference_ms=250)
        assert isinstance(result, InferActionResponse)
        assert result.action == "click"
        assert result.target_x == 500
        assert result.text == ""

    def test_type_text(self) -> None:
        raw = json.dumps({
            "action": "type_text", "target_x": 400, "target_y": 200,
            "text": "alice@example.com", "confidence": 0.9,
            "reasoning": "Email field is focused.",
        })
        result = parse_infer_action(raw, inference_ms=300)
        assert result.action == "type_text"
        assert result.text == "alice@example.com"

    def test_missing_fields_default(self) -> None:
        raw = json.dumps({"action": "scroll_down"})
        result = parse_infer_action(raw, inference_ms=100)
        assert result.action == "scroll_down"
        assert result.target_x == 0
        assert result.target_y == 0
        assert result.text == ""
        assert result.confidence == 0.0


# ---------------------------------------------------------------------------
# Image preprocessing
# ---------------------------------------------------------------------------

class TestPreprocessImage:
    """Image decoding, mode conversion, and resizing."""

    def test_small_image_unchanged(self, sample_screenshot_b64: str) -> None:
        img = preprocess_image(sample_screenshot_b64, max_dimension=2560)
        assert img.size == (100, 80)
        assert img.mode == "RGB"

    def test_large_image_resized(self, large_screenshot_b64: str) -> None:
        img = preprocess_image(large_screenshot_b64, max_dimension=1280)
        w, h = img.size
        assert max(w, h) == 1280
        # Aspect ratio preserved
        assert abs(w / h - 2560 / 1800) < 0.01

    def test_rgba_converted_to_rgb(self, rgba_screenshot_b64: str) -> None:
        img = preprocess_image(rgba_screenshot_b64, max_dimension=2560)
        assert img.mode == "RGB"

    def test_invalid_base64_raises(self) -> None:
        with pytest.raises(Exception):
            preprocess_image("not-valid-base64!!!", max_dimension=2560)

    def test_exact_max_dimension_not_resized(self) -> None:
        """Image with longest edge exactly at max_dimension should not be resized."""
        img = Image.new("RGB", (2560, 1440))
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        b64 = base64.b64encode(buf.getvalue()).decode("ascii")
        result = preprocess_image(b64, max_dimension=2560)
        assert result.size == (2560, 1440)


# ---------------------------------------------------------------------------
# Mock backend
# ---------------------------------------------------------------------------

class TestMockBackend:
    """MockBackend returns deterministic results for testing."""

    def test_find_element(self, sample_screenshot_b64: str) -> None:
        backend = MockBackend()
        img = preprocess_image(sample_screenshot_b64, max_dimension=2560)
        raw = backend.infer(
            "You are a visual UI element locator.",
            "Find this UI element: Sign In button",
            img,
        )
        data = json.loads(raw)
        assert "x1" in data
        assert "x2" in data
        assert data["confidence"] > 0.0

    def test_checkpoint(self, sample_screenshot_b64: str) -> None:
        backend = MockBackend()
        img = preprocess_image(sample_screenshot_b64, max_dimension=2560)
        raw = backend.infer(
            "You are a visual page state verifier.",
            "Does the page match: login form visible?",
            img,
        )
        data = json.loads(raw)
        assert data["on_track"] is True
        assert data["confidence"] > 0.0

    def test_infer_action(self, sample_screenshot_b64: str) -> None:
        backend = MockBackend()
        img = preprocess_image(sample_screenshot_b64, max_dimension=2560)
        raw = backend.infer(
            "You are a browser automation assistant.",
            "What action should be taken?",
            img,
        )
        data = json.loads(raw)
        assert data["action"] == "click"
        assert data["confidence"] > 0.0

    def test_model_info(self) -> None:
        backend = MockBackend()
        info = backend.model_info()
        assert info["backend"] == "mock"
        assert info["calls"] == 0

    def test_call_count_increments(self, sample_screenshot_b64: str) -> None:
        backend = MockBackend()
        img = preprocess_image(sample_screenshot_b64, max_dimension=2560)
        backend.infer("You are a visual UI element locator.", "Find button", img)
        backend.infer("You are a visual UI element locator.", "Find link", img)
        assert backend.model_info()["calls"] == 2


# ---------------------------------------------------------------------------
# Backend factory
# ---------------------------------------------------------------------------

class TestCreateBackend:
    """Factory function selects the right backend."""

    def test_mock_backend(self) -> None:
        config = Config(
            host="0.0.0.0", port=8420, log_level="INFO",
            model_path="/fake/path", model_backend="mock",
            context_length=8192, max_tokens=1024, temperature=0.1,
            gpu_layers=-1, max_image_dimension=2560,
            password_guard_enabled=True,
        )
        backend = create_backend(config)
        assert isinstance(backend, MockBackend)

    def test_unknown_backend_raises(self) -> None:
        config = Config(
            host="0.0.0.0", port=8420, log_level="INFO",
            model_path="/fake/path", model_backend="unknown_backend",
            context_length=8192, max_tokens=1024, temperature=0.1,
            gpu_layers=-1, max_image_dimension=2560,
            password_guard_enabled=True,
        )
        with pytest.raises(ValueError, match="Unknown model backend"):
            create_backend(config)
