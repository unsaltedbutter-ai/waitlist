"""Tests for model loading, response parsing, image preprocessing, and mock backend.

Run: python -m pytest inference/tests/test_model.py -v
"""

from __future__ import annotations

import base64
import io
import json
import sys
from unittest.mock import MagicMock, patch

import pytest
from PIL import Image

from inference.config import Config
from inference.model import (
    CheckpointResponse,
    FindElementResponse,
    InferActionResponse,
    MockBackend,
    OpenAIBackend,
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

    def test_openai_backend(self) -> None:
        config = Config(
            host="0.0.0.0", port=8420, log_level="INFO",
            model_path="/fake/path", model_backend="openai",
            context_length=8192, max_tokens=1024, temperature=0.1,
            gpu_layers=-1, max_image_dimension=2560,
            password_guard_enabled=True,
            vlm_base_url="https://api.example.com",
            vlm_api_key="test-key",
            vlm_model="test-model",
        )
        backend = create_backend(config)
        assert isinstance(backend, OpenAIBackend)

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


# ---------------------------------------------------------------------------
# OpenAI-compatible backend
# ---------------------------------------------------------------------------

class TestOpenAIBackend:
    """OpenAI-compatible backend for remote or local VLM endpoints."""

    @staticmethod
    def _make_config(**overrides) -> Config:
        defaults = dict(
            host="0.0.0.0", port=8420, log_level="INFO",
            model_path="/fake/model.gguf", model_backend="openai",
            context_length=8192, max_tokens=1024, temperature=0.1,
            gpu_layers=-1, max_image_dimension=2560,
            password_guard_enabled=True,
            vlm_base_url="https://api.example.com",
            vlm_api_key="test-key",
            vlm_model="test-model",
        )
        defaults.update(overrides)
        return Config(**defaults)

    def test_missing_base_url_raises(self) -> None:
        config = self._make_config(vlm_base_url="")
        with pytest.raises(ValueError, match="VLM_BASE_URL"):
            OpenAIBackend(config)

    def test_is_local_false_for_remote(self) -> None:
        config = self._make_config(vlm_base_url="https://api.ppq.ai")
        backend = OpenAIBackend(config)
        assert backend._is_local() is False

    def test_is_local_true_for_localhost(self) -> None:
        config = self._make_config(vlm_base_url="http://localhost:8080")
        with patch.object(OpenAIBackend, "_ensure_local_server"):
            backend = OpenAIBackend(config)
        assert backend._is_local() is True

    def test_is_local_true_for_127(self) -> None:
        config = self._make_config(vlm_base_url="http://127.0.0.1:8080")
        with patch.object(OpenAIBackend, "_ensure_local_server"):
            backend = OpenAIBackend(config)
        assert backend._is_local() is True

    def test_infer_sends_correct_request(self, sample_screenshot_b64: str) -> None:
        config = self._make_config()
        backend = OpenAIBackend(config)
        img = preprocess_image(sample_screenshot_b64, max_dimension=2560)

        mock_resp = MagicMock()
        mock_resp.json.return_value = {
            "choices": [{"message": {"content": '{"x1": 10}'}}],
        }

        with patch.object(backend._client, "post", return_value=mock_resp) as mock_post:
            result = backend.infer("system prompt", "user prompt", img)

        assert result == '{"x1": 10}'
        mock_post.assert_called_once()
        payload = mock_post.call_args.kwargs["json"]
        assert payload["model"] == "test-model"
        assert payload["max_tokens"] == 1024
        assert payload["temperature"] == 0.1
        assert len(payload["messages"]) == 2
        assert payload["messages"][0]["role"] == "system"
        user_content = payload["messages"][1]["content"]
        assert len(user_content) == 2
        assert user_content[0]["type"] == "image_url"
        assert user_content[0]["image_url"]["url"].startswith("data:image/png;base64,")
        assert user_content[1] == {"type": "text", "text": "user prompt"}

    def test_infer_raises_on_http_error(self, sample_screenshot_b64: str) -> None:
        config = self._make_config()
        backend = OpenAIBackend(config)
        img = preprocess_image(sample_screenshot_b64, max_dimension=2560)

        import httpx as _httpx
        mock_resp = MagicMock()
        mock_resp.raise_for_status.side_effect = _httpx.HTTPStatusError(
            "Server Error", request=MagicMock(), response=MagicMock(status_code=500),
        )

        with patch.object(backend._client, "post", return_value=mock_resp):
            with pytest.raises(_httpx.HTTPStatusError):
                backend.infer("sys", "usr", img)

    def test_model_info(self) -> None:
        config = self._make_config()
        backend = OpenAIBackend(config)
        info = backend.model_info()
        assert info == {
            "backend": "openai",
            "model": "test-model",
            "base_url": "https://api.example.com",
            "is_local": False,
        }

    def test_shutdown_kills_local_process(self) -> None:
        config = self._make_config(vlm_base_url="http://localhost:8080")
        with patch.object(OpenAIBackend, "_ensure_local_server"):
            backend = OpenAIBackend(config)

        mock_proc = MagicMock()
        backend._local_process = mock_proc
        backend.shutdown()

        mock_proc.terminate.assert_called_once()
        mock_proc.wait.assert_called_once_with(timeout=10)
        assert backend._local_process is None

    def test_shutdown_noop_without_process(self) -> None:
        config = self._make_config()
        backend = OpenAIBackend(config)
        backend.shutdown()  # Should not raise

    def test_ensure_local_server_skips_when_running(self) -> None:
        """If health check passes, don't start a subprocess."""
        config = self._make_config(vlm_base_url="http://localhost:8080")

        with patch("httpx.Client") as MockClient:
            mock_client = MockClient.return_value
            mock_client.get.return_value = MagicMock(status_code=200)
            backend = OpenAIBackend(config)

        assert backend._local_process is None

    def test_ensure_local_server_starts_subprocess(self) -> None:
        """If health check fails, start llama.cpp and poll until ready."""
        config = self._make_config(vlm_base_url="http://localhost:8080")

        call_count = 0

        def mock_get(url):
            nonlocal call_count
            call_count += 1
            if call_count <= 1:
                raise ConnectionError("refused")
            return MagicMock(status_code=200)

        mock_proc = MagicMock()
        mock_proc.poll.return_value = None

        with patch("httpx.Client") as MockClient, \
             patch("subprocess.Popen", return_value=mock_proc) as mock_popen:
            mock_client = MockClient.return_value
            mock_client.get.side_effect = mock_get
            backend = OpenAIBackend(config)

        mock_popen.assert_called_once()
        cmd = mock_popen.call_args[0][0]
        assert cmd[0] == sys.executable
        assert "--model" in cmd
        assert "/fake/model.gguf" in cmd
        assert "--n_gpu_layers" in cmd
        assert "--port" in cmd
        assert "8080" in cmd

    def test_auth_header_set_when_api_key_provided(self) -> None:
        config = self._make_config(vlm_api_key="sk-test-123")
        backend = OpenAIBackend(config)
        assert backend._client.headers["authorization"] == "Bearer sk-test-123"

    def test_no_auth_header_when_no_api_key(self) -> None:
        config = self._make_config(vlm_api_key="")
        backend = OpenAIBackend(config)
        assert "authorization" not in backend._client.headers
