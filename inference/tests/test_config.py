"""Tests for inference server configuration.

Run: python -m pytest inference/tests/test_config.py -v
"""

from __future__ import annotations

import os
from unittest.mock import patch

import pytest

from inference.config import Config


class TestConfigDefaults:
    """Config.load() should produce sensible defaults."""

    def test_default_port(self) -> None:
        with patch.dict(os.environ, {}, clear=True):
            config = Config.load()
        assert config.port == 8420

    def test_default_host(self) -> None:
        with patch.dict(os.environ, {}, clear=True):
            config = Config.load()
        assert config.host == "0.0.0.0"

    def test_default_backend_is_mock(self) -> None:
        with patch.dict(os.environ, {}, clear=True):
            config = Config.load()
        assert config.model_backend == "mock"

    def test_default_log_level(self) -> None:
        with patch.dict(os.environ, {}, clear=True):
            config = Config.load()
        assert config.log_level == "INFO"

    def test_default_context_length(self) -> None:
        with patch.dict(os.environ, {}, clear=True):
            config = Config.load()
        assert config.context_length == 8192

    def test_default_password_guard_enabled(self) -> None:
        with patch.dict(os.environ, {}, clear=True):
            config = Config.load()
        assert config.password_guard_enabled is True

    def test_default_max_image_dimension(self) -> None:
        with patch.dict(os.environ, {}, clear=True):
            config = Config.load()
        assert config.max_image_dimension == 2560


class TestConfigOverrides:
    """Config.load() should respect environment variable overrides."""

    def test_custom_port(self) -> None:
        with patch.dict(os.environ, {"INFERENCE_PORT": "9999"}, clear=True):
            config = Config.load()
        assert config.port == 9999

    def test_custom_backend(self) -> None:
        with patch.dict(os.environ, {"MODEL_BACKEND": "llama_cpp"}, clear=True):
            config = Config.load()
        assert config.model_backend == "llama_cpp"

    def test_custom_temperature(self) -> None:
        with patch.dict(os.environ, {"TEMPERATURE": "0.5"}, clear=True):
            config = Config.load()
        assert config.temperature == 0.5

    def test_password_guard_disabled(self) -> None:
        with patch.dict(os.environ, {"PASSWORD_GUARD_ENABLED": "false"}, clear=True):
            config = Config.load()
        assert config.password_guard_enabled is False

    def test_password_guard_enabled_yes(self) -> None:
        with patch.dict(os.environ, {"PASSWORD_GUARD_ENABLED": "yes"}, clear=True):
            config = Config.load()
        assert config.password_guard_enabled is True

    def test_gpu_layers_all(self) -> None:
        with patch.dict(os.environ, {"GPU_LAYERS": "-1"}, clear=True):
            config = Config.load()
        assert config.gpu_layers == -1

    def test_gpu_layers_partial(self) -> None:
        with patch.dict(os.environ, {"GPU_LAYERS": "20"}, clear=True):
            config = Config.load()
        assert config.gpu_layers == 20


class TestConfigFrozen:
    """Config should be immutable after creation."""

    def test_cannot_set_attribute(self) -> None:
        with patch.dict(os.environ, {}, clear=True):
            config = Config.load()
        with pytest.raises(AttributeError):
            config.port = 9999  # type: ignore[misc]
