"""Inference server configuration.

Loads from environment variables. Defaults are tuned for Mac Studio M3 Ultra
running Qwen3-VL-32B (Q4) via llama.cpp or MLX.

Env file: ~/.unsaltedbutter/inference.env
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

_inference_env = Path.home() / ".unsaltedbutter" / "inference.env"
if _inference_env.exists():
    load_dotenv(_inference_env)


@dataclass(frozen=True)
class Config:
    """Immutable inference server configuration."""

    # Server
    host: str
    port: int
    log_level: str

    # Model
    model_path: str
    model_backend: str  # "llama_cpp", "mlx", or "mock"
    context_length: int
    max_tokens: int
    temperature: float
    gpu_layers: int

    # Image processing
    max_image_dimension: int  # resize images larger than this (longest edge)

    # Safety
    password_guard_enabled: bool

    @classmethod
    def load(cls) -> Config:
        """Load configuration from environment variables."""
        return cls(
            host=os.environ.get("INFERENCE_HOST", "0.0.0.0"),
            port=int(os.environ.get("INFERENCE_PORT", "8420")),
            log_level=os.environ.get("LOG_LEVEL", "INFO").upper(),
            model_path=os.environ.get(
                "MODEL_PATH",
                str(Path.home() / "models" / "qwen3-vl-32b-q4_k_m.gguf"),
            ),
            model_backend=os.environ.get("MODEL_BACKEND", "mock"),
            context_length=int(os.environ.get("CONTEXT_LENGTH", "8192")),
            max_tokens=int(os.environ.get("MAX_TOKENS", "1024")),
            temperature=float(os.environ.get("TEMPERATURE", "0.1")),
            gpu_layers=int(os.environ.get("GPU_LAYERS", "-1")),  # -1 = all
            max_image_dimension=int(os.environ.get("MAX_IMAGE_DIMENSION", "2560")),
            password_guard_enabled=os.environ.get(
                "PASSWORD_GUARD_ENABLED", "true"
            ).lower() in ("true", "1", "yes"),
        )
