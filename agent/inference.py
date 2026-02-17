"""Inference client: VLM integration for element finding, checkpoints, and freeform inference.

Defines the contract between the agent (Mac Mini) and the inference server (Mac Studio).
The Mac Studio's FastAPI server will implement /api/find_element, /api/checkpoint,
and /api/infer_action endpoints.
"""

from __future__ import annotations

import random
from abc import ABC, abstractmethod
from dataclasses import dataclass

import httpx

from agent.config import INFERENCE_TIMEOUT, INFERENCE_URL


# ---------------------------------------------------------------------------
# Result types
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class FindElementResult:
    """VLM response: where a UI element is in image-pixel coordinates."""
    x: int
    y: int
    confidence: float  # 0.0 to 1.0


@dataclass(frozen=True)
class CheckpointResult:
    """VLM response: whether the page state matches expectations."""
    on_track: bool
    confidence: float
    reasoning: str


@dataclass(frozen=True)
class InferActionResult:
    """VLM response: freeform action inference (fallback mode)."""
    action: str          # click, type_text, scroll, etc.
    target_x: int
    target_y: int
    text: str            # for type_text actions
    confidence: float
    reasoning: str


# ---------------------------------------------------------------------------
# Abstract base class
# ---------------------------------------------------------------------------

class InferenceClient(ABC):
    """Interface for VLM inference. Implementations talk to the Mac Studio or mock."""

    @abstractmethod
    def find_element(
        self,
        screenshot_b64: str,
        description: str,
        context: str = '',
    ) -> FindElementResult:
        """Locate a UI element in the screenshot. Returns image-pixel coords."""

    @abstractmethod
    def checkpoint(
        self,
        screenshot_b64: str,
        prompt: str,
        context: str = '',
    ) -> CheckpointResult:
        """Verify page state matches expectations."""

    @abstractmethod
    def infer_action(
        self,
        screenshot_b64: str,
        context: str = '',
    ) -> InferActionResult:
        """Full inference fallback: decide what to do next."""


# ---------------------------------------------------------------------------
# HTTP client (talks to Mac Studio FastAPI)
# ---------------------------------------------------------------------------

class HttpInferenceClient(InferenceClient):
    """POST to the Mac Studio inference server."""

    def __init__(self, base_url: str = INFERENCE_URL, timeout: float = INFERENCE_TIMEOUT):
        self._base_url = base_url.rstrip('/')
        self._client = httpx.Client(timeout=timeout)

    def find_element(
        self,
        screenshot_b64: str,
        description: str,
        context: str = '',
    ) -> FindElementResult:
        resp = self._client.post(
            f'{self._base_url}/api/find_element',
            json={
                'screenshot': screenshot_b64,
                'description': description,
                'context': context,
            },
        )
        resp.raise_for_status()
        data = resp.json()
        return FindElementResult(
            x=data['x'],
            y=data['y'],
            confidence=data.get('confidence', 0.0),
        )

    def checkpoint(
        self,
        screenshot_b64: str,
        prompt: str,
        context: str = '',
    ) -> CheckpointResult:
        resp = self._client.post(
            f'{self._base_url}/api/checkpoint',
            json={
                'screenshot': screenshot_b64,
                'prompt': prompt,
                'context': context,
            },
        )
        resp.raise_for_status()
        data = resp.json()
        return CheckpointResult(
            on_track=data['on_track'],
            confidence=data.get('confidence', 0.0),
            reasoning=data.get('reasoning', ''),
        )

    def infer_action(
        self,
        screenshot_b64: str,
        context: str = '',
    ) -> InferActionResult:
        resp = self._client.post(
            f'{self._base_url}/api/infer_action',
            json={
                'screenshot': screenshot_b64,
                'context': context,
            },
        )
        resp.raise_for_status()
        data = resp.json()
        return InferActionResult(
            action=data.get('action', 'click'),
            target_x=data.get('target_x', 0),
            target_y=data.get('target_y', 0),
            text=data.get('text', ''),
            confidence=data.get('confidence', 0.0),
            reasoning=data.get('reasoning', ''),
        )

    def close(self) -> None:
        self._client.close()


# ---------------------------------------------------------------------------
# Mock client (for testing without GPU)
# ---------------------------------------------------------------------------

class MockInferenceClient(InferenceClient):
    """Returns plausible fake results. For testing the executor loop without hardware."""

    def __init__(self, image_width: int = 2560, image_height: int = 1800):
        self._w = image_width
        self._h = image_height

    def find_element(
        self,
        screenshot_b64: str,
        description: str,
        context: str = '',
    ) -> FindElementResult:
        # Return center-ish with jitter
        x = self._w // 2 + random.randint(-200, 200)
        y = self._h // 2 + random.randint(-150, 150)
        return FindElementResult(x=x, y=y, confidence=0.85)

    def checkpoint(
        self,
        screenshot_b64: str,
        prompt: str,
        context: str = '',
    ) -> CheckpointResult:
        return CheckpointResult(on_track=True, confidence=0.9, reasoning='Mock: always on track')

    def infer_action(
        self,
        screenshot_b64: str,
        context: str = '',
    ) -> InferActionResult:
        return InferActionResult(
            action='click',
            target_x=self._w // 2,
            target_y=self._h // 2,
            text='',
            confidence=0.7,
            reasoning='Mock: click center',
        )
