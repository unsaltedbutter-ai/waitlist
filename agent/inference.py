"""Inference client: VLM integration for element finding, checkpoints, and freeform inference.

Two client implementations:
  CoordinateInferenceClient - recorded ref_region from playbook (no VLM needed)
  MockInferenceClient    - random center-ish coords (loop testing)

Production VLM inference uses VLMExecutor (vlm_executor.py), not these clients.
"""

from __future__ import annotations

import random
from abc import ABC, abstractmethod
from dataclasses import dataclass


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

    def random_points(self, n: int) -> list[tuple[int, int]]:
        """Return *n* independent Gaussian-sampled points within the bounding box."""
        return [self.random_point() for _ in range(n)]


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
        # Use recorded ref_region when available
        if ref_region is not None:
            x1, y1, x2, y2 = ref_region
            return FindElementResult(x1=x1, y1=y1, x2=x2, y2=y2, confidence=0.95)

        # No recorded coords: return center-ish box with jitter
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
