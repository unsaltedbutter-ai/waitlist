"""Model loading and inference abstraction.

Defines InferenceBackend (abstract) with three implementations:
  LlamaCppBackend  - Qwen3-VL via llama-cpp-python (production)
  MlxBackend       - Qwen3-VL via mlx-vlm (alternative)
  MockBackend      - deterministic responses for testing

The prompt construction and response parsing are fully implemented.
LlamaCpp and MLX backends have the interface wired up but actual model
loading is stubbed (we don't have the hardware yet). The stubs raise
NotImplementedError with clear messages about what needs to be filled in.
"""

from __future__ import annotations

import base64
import io
import json
import logging
import re
import time
from abc import ABC, abstractmethod
from dataclasses import dataclass

from PIL import Image

from inference.config import Config

log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Result types (server-side, before serialization)
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class FindElementResponse:
    """Bounding box in image-pixel coordinates."""
    x1: int
    y1: int
    x2: int
    y2: int
    confidence: float
    inference_ms: int


@dataclass(frozen=True)
class CheckpointResponse:
    """Whether the page state matches expectations."""
    on_track: bool
    confidence: float
    reasoning: str
    inference_ms: int


@dataclass(frozen=True)
class InferActionResponse:
    """Recommended next action."""
    action: str
    target_x: int
    target_y: int
    text: str
    confidence: float
    reasoning: str
    inference_ms: int


# ---------------------------------------------------------------------------
# Response parsing
# ---------------------------------------------------------------------------

def _extract_json(raw: str) -> dict:
    """Extract the first JSON object from VLM output.

    VLMs sometimes wrap JSON in markdown code fences or add preamble text.
    We try several strategies:
    1. Direct json.loads on the full string
    2. Extract from ```json ... ``` fences
    3. Find the first { ... } substring
    """
    text = raw.strip()

    # Strategy 1: direct parse
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass

    # Strategy 2: markdown code fence
    fence_match = re.search(r"```(?:json)?\s*\n?(.*?)\n?\s*```", text, re.DOTALL)
    if fence_match:
        try:
            return json.loads(fence_match.group(1).strip())
        except json.JSONDecodeError:
            pass

    # Strategy 3: first { ... } block
    brace_match = re.search(r"\{[^{}]*\}", text, re.DOTALL)
    if brace_match:
        try:
            return json.loads(brace_match.group(0))
        except json.JSONDecodeError:
            pass

    # Strategy 4: first { ... } with nested braces (for reasoning strings containing braces)
    depth = 0
    start = -1
    for i, ch in enumerate(text):
        if ch == "{":
            if depth == 0:
                start = i
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0 and start >= 0:
                try:
                    return json.loads(text[start : i + 1])
                except json.JSONDecodeError:
                    start = -1

    raise ValueError(f"Could not extract JSON from VLM output: {text[:200]}")


def parse_find_element(raw: str, inference_ms: int) -> FindElementResponse:
    """Parse VLM output into a FindElementResponse."""
    data = _extract_json(raw)
    return FindElementResponse(
        x1=int(data.get("x1", 0)),
        y1=int(data.get("y1", 0)),
        x2=int(data.get("x2", 0)),
        y2=int(data.get("y2", 0)),
        confidence=float(data.get("confidence", 0.0)),
        inference_ms=inference_ms,
    )


def parse_checkpoint(raw: str, inference_ms: int) -> CheckpointResponse:
    """Parse VLM output into a CheckpointResponse."""
    data = _extract_json(raw)
    return CheckpointResponse(
        on_track=bool(data.get("on_track", False)),
        confidence=float(data.get("confidence", 0.0)),
        reasoning=str(data.get("reasoning", "")),
        inference_ms=inference_ms,
    )


def parse_infer_action(raw: str, inference_ms: int) -> InferActionResponse:
    """Parse VLM output into an InferActionResponse."""
    data = _extract_json(raw)
    return InferActionResponse(
        action=str(data.get("action", "click")),
        target_x=int(data.get("target_x", 0)),
        target_y=int(data.get("target_y", 0)),
        text=str(data.get("text", "")),
        confidence=float(data.get("confidence", 0.0)),
        reasoning=str(data.get("reasoning", "")),
        inference_ms=inference_ms,
    )


# ---------------------------------------------------------------------------
# Image preprocessing
# ---------------------------------------------------------------------------

def preprocess_image(screenshot_b64: str, max_dimension: int) -> Image.Image:
    """Decode base64 screenshot and resize if needed.

    Returns a PIL Image. The longest edge is capped at max_dimension
    while preserving aspect ratio. If the image is already small enough,
    it is returned as-is.
    """
    raw_bytes = base64.b64decode(screenshot_b64)
    img = Image.open(io.BytesIO(raw_bytes))

    # Convert to RGB if needed (some screenshots are RGBA or palette mode)
    if img.mode not in ("RGB", "L"):
        img = img.convert("RGB")

    w, h = img.size
    longest = max(w, h)
    if longest > max_dimension:
        scale = max_dimension / longest
        new_w = int(w * scale)
        new_h = int(h * scale)
        img = img.resize((new_w, new_h), Image.LANCZOS)
        log.debug("Resized image from %dx%d to %dx%d", w, h, new_w, new_h)

    return img


# ---------------------------------------------------------------------------
# Abstract backend
# ---------------------------------------------------------------------------

class InferenceBackend(ABC):
    """Interface for VLM inference. Stateless: each call is independent."""

    @abstractmethod
    def infer(self, system_prompt: str, user_prompt: str, image: Image.Image) -> str:
        """Run inference with a system prompt, user prompt, and image.

        Returns the raw text output from the VLM.
        """

    @abstractmethod
    def model_info(self) -> dict:
        """Return metadata about the loaded model (for /health endpoint)."""


# ---------------------------------------------------------------------------
# Mock backend (for testing without GPU)
# ---------------------------------------------------------------------------

class MockBackend(InferenceBackend):
    """Returns deterministic JSON responses. For testing the server without hardware."""

    def __init__(self) -> None:
        self._call_count = 0

    def infer(self, system_prompt: str, user_prompt: str, image: Image.Image) -> str:
        """Return mock JSON based on which system prompt was used."""
        self._call_count += 1
        w, h = image.size

        if "element locator" in system_prompt:
            # find_element: return a box near center
            cx, cy = w // 2, h // 2
            return json.dumps({
                "x1": cx - 60,
                "y1": cy - 20,
                "x2": cx + 60,
                "y2": cy + 20,
                "confidence": 0.92,
            })

        if "page state verifier" in system_prompt:
            # checkpoint: always on track
            return json.dumps({
                "on_track": True,
                "confidence": 0.95,
                "reasoning": "Mock: page state matches expected description.",
            })

        if "browser automation assistant" in system_prompt:
            # infer_action: click center
            return json.dumps({
                "action": "click",
                "target_x": w // 2,
                "target_y": h // 2,
                "text": "",
                "confidence": 0.88,
                "reasoning": "Mock: clicking center of page.",
            })

        # Fallback
        return json.dumps({"error": "Unknown prompt type"})

    def model_info(self) -> dict:
        return {
            "backend": "mock",
            "model": "none",
            "calls": self._call_count,
        }


# ---------------------------------------------------------------------------
# llama.cpp backend (production)
# ---------------------------------------------------------------------------

class LlamaCppBackend(InferenceBackend):
    """Qwen3-VL via llama-cpp-python bindings.

    Requires: pip install llama-cpp-python[server]
    The model must be a GGUF file with vision support.
    """

    def __init__(self, config: Config) -> None:
        self._config = config
        self._model = None
        self._load_model()

    def _load_model(self) -> None:
        """Load the GGUF model via llama-cpp-python."""
        try:
            from llama_cpp import Llama  # type: ignore[import-untyped]
            from llama_cpp.llama_chat_format import Llava16ChatHandler  # type: ignore[import-untyped]
        except ImportError as exc:
            raise ImportError(
                "llama-cpp-python is required for the llama_cpp backend. "
                "Install with: pip install llama-cpp-python"
            ) from exc

        log.info("Loading model from %s", self._config.model_path)
        # The chat handler for Qwen-VL models uses the Llava-style image handling.
        # This may need adjustment depending on the exact GGUF format.
        chat_handler = Llava16ChatHandler(clip_model_path=self._config.model_path)
        self._model = Llama(
            model_path=self._config.model_path,
            chat_handler=chat_handler,
            n_ctx=self._config.context_length,
            n_gpu_layers=self._config.gpu_layers,
            verbose=False,
        )
        log.info("Model loaded successfully")

    def infer(self, system_prompt: str, user_prompt: str, image: Image.Image) -> str:
        """Run inference with the loaded model."""
        if self._model is None:
            raise RuntimeError("Model not loaded")

        # Convert image to base64 data URI for the chat format
        buf = io.BytesIO()
        image.save(buf, format="PNG")
        img_b64 = base64.b64encode(buf.getvalue()).decode("ascii")
        data_uri = f"data:image/png;base64,{img_b64}"

        messages = [
            {"role": "system", "content": system_prompt},
            {
                "role": "user",
                "content": [
                    {"type": "image_url", "image_url": {"url": data_uri}},
                    {"type": "text", "text": user_prompt},
                ],
            },
        ]

        response = self._model.create_chat_completion(
            messages=messages,
            max_tokens=self._config.max_tokens,
            temperature=self._config.temperature,
        )
        return response["choices"][0]["message"]["content"]

    def model_info(self) -> dict:
        return {
            "backend": "llama_cpp",
            "model_path": self._config.model_path,
            "context_length": self._config.context_length,
            "gpu_layers": self._config.gpu_layers,
        }


# ---------------------------------------------------------------------------
# MLX backend (alternative for Apple Silicon)
# ---------------------------------------------------------------------------

class MlxBackend(InferenceBackend):
    """Qwen3-VL via mlx-vlm on Apple Silicon.

    Requires: pip install mlx-vlm
    Uses MLX's native Metal acceleration on Apple Silicon GPUs.
    """

    def __init__(self, config: Config) -> None:
        self._config = config
        self._model = None
        self._processor = None
        self._load_model()

    def _load_model(self) -> None:
        """Load the model via mlx-vlm."""
        try:
            from mlx_vlm import load as mlx_load  # type: ignore[import-untyped]
        except ImportError as exc:
            raise ImportError(
                "mlx-vlm is required for the mlx backend. "
                "Install with: pip install mlx-vlm"
            ) from exc

        log.info("Loading MLX model from %s", self._config.model_path)
        self._model, self._processor = mlx_load(self._config.model_path)
        log.info("MLX model loaded successfully")

    def infer(self, system_prompt: str, user_prompt: str, image: Image.Image) -> str:
        """Run inference with the loaded MLX model."""
        if self._model is None or self._processor is None:
            raise RuntimeError("MLX model not loaded")

        try:
            from mlx_vlm import generate as mlx_generate  # type: ignore[import-untyped]
        except ImportError as exc:
            raise ImportError("mlx-vlm is required for the mlx backend.") from exc

        # mlx-vlm generate accepts PIL images directly
        prompt = f"<|system|>\n{system_prompt}\n<|user|>\n{user_prompt}"

        output = mlx_generate(
            self._model,
            self._processor,
            prompt,
            image,
            max_tokens=self._config.max_tokens,
            temp=self._config.temperature,
        )
        return output

    def model_info(self) -> dict:
        return {
            "backend": "mlx",
            "model_path": self._config.model_path,
            "context_length": self._config.context_length,
        }


# ---------------------------------------------------------------------------
# Factory
# ---------------------------------------------------------------------------

def create_backend(config: Config) -> InferenceBackend:
    """Create the appropriate backend based on configuration."""
    backend_name = config.model_backend.lower()

    if backend_name == "mock":
        log.info("Using mock inference backend (no GPU required)")
        return MockBackend()

    if backend_name == "llama_cpp":
        return LlamaCppBackend(config)

    if backend_name == "mlx":
        return MlxBackend(config)

    raise ValueError(
        f"Unknown model backend: {config.model_backend!r}. "
        f"Valid options: mock, llama_cpp, mlx"
    )
