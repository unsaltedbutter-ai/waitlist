"""Inference client: VLM integration for element finding, checkpoints, and freeform inference.

Defines the contract between the agent (Mac Mini) and the inference server (Mac Studio).
The Mac Studio's FastAPI server will implement /api/find_element, /api/checkpoint,
and /api/infer_action endpoints.

Three client implementations:
  HttpInferenceClient    - real VLM on Mac Studio (production)
  CoordinateInferenceClient - recorded ref_region from playbook (no VLM needed)
  MockInferenceClient    - random center-ish coords (loop testing)
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
    """Where a UI element is in image-pixel coordinates (bounding box)."""
    x1: int
    y1: int
    x2: int
    y2: int
    confidence: float  # 0.0 to 1.0

    def random_point(self) -> tuple[int, int]:
        """Pick a random point within the bounding box, weighted toward center."""
        # Gaussian centered on midpoint, clipped to box
        cx = (self.x1 + self.x2) / 2
        cy = (self.y1 + self.y2) / 2
        sx = (self.x2 - self.x1) / 4  # ~95% within box
        sy = (self.y2 - self.y1) / 4
        x = int(min(max(random.gauss(cx, sx), self.x1), self.x2))
        y = int(min(max(random.gauss(cy, sy), self.y1), self.y2))
        return x, y


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
        ref_region: tuple[int, int, int, int] | None = None,
    ) -> FindElementResult:
        """Locate a UI element in the screenshot. Returns bounding box in image-pixel coords."""

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
        ref_region: tuple[int, int, int, int] | None = None,
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
            x1=data['x1'],
            y1=data['y1'],
            x2=data['x2'],
            y2=data['y2'],
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
# Coordinate client (uses recorded ref_region, no VLM)
# ---------------------------------------------------------------------------

class CoordinateInferenceClient(InferenceClient):
    """
    Uses ref_region from the playbook step to return click targets.
    No VLM needed. For testing playbooks against real Chrome on the Mac Mini
    before the Mac Studio is online.

    Checkpoints always pass (no visual verification without VLM).
    """

    def find_element(
        self,
        screenshot_b64: str,
        description: str,
        context: str = '',
        ref_region: tuple[int, int, int, int] | None = None,
    ) -> FindElementResult:
        if ref_region is None:
            raise ValueError(
                f'CoordinateInferenceClient requires ref_region but step has none '
                f'(description: "{description}")'
            )
        x1, y1, x2, y2 = ref_region
        return FindElementResult(x1=x1, y1=y1, x2=x2, y2=y2, confidence=1.0)

    def checkpoint(
        self,
        screenshot_b64: str,
        prompt: str,
        context: str = '',
    ) -> CheckpointResult:
        return CheckpointResult(
            on_track=True, confidence=1.0,
            reasoning='Coordinate mode: checkpoints skipped',
        )

    def infer_action(
        self,
        screenshot_b64: str,
        context: str = '',
    ) -> InferActionResult:
        raise NotImplementedError('CoordinateInferenceClient does not support infer_action')


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
        ref_region: tuple[int, int, int, int] | None = None,
    ) -> FindElementResult:
        # Return center-ish box with jitter
        cx = self._w // 2 + random.randint(-200, 200)
        cy = self._h // 2 + random.randint(-150, 150)
        hw, hh = random.randint(30, 80), random.randint(15, 30)
        return FindElementResult(
            x1=cx - hw, y1=cy - hh, x2=cx + hw, y2=cy + hh,
            confidence=0.85,
        )

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
