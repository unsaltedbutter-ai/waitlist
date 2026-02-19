"""Tests for inference client implementations and result types.

Run: cd agent && python -m pytest tests/test_inference.py -v
"""

from __future__ import annotations

import random

import pytest

from agent.inference import (
    CheckpointResult,
    CoordinateInferenceClient,
    FindElementResult,
    InferActionResult,
    MockInferenceClient,
)


# ---------------------------------------------------------------------------
# FindElementResult
# ---------------------------------------------------------------------------


class TestFindElementResult:
    """Bounding box result from VLM find_element."""

    def test_random_point_within_bounds(self) -> None:
        """random_point() always returns coords inside the bounding box."""
        result = FindElementResult(x1=100, y1=200, x2=300, y2=400, confidence=0.9)
        for _ in range(200):
            x, y = result.random_point()
            assert 100 <= x <= 300, f'x={x} outside [100, 300]'
            assert 200 <= y <= 400, f'y={y} outside [200, 400]'

    def test_random_point_center_bias(self) -> None:
        """Most random points should cluster near the center.

        The Gaussian has sigma = box_size/4, so ~68% of values fall within
        +/- 1 sigma of center. We check a generous inner region and use
        a large sample to reduce flakiness.
        """
        result = FindElementResult(x1=0, y1=0, x2=200, y2=200, confidence=0.9)
        center_count = 0
        n = 2000
        for _ in range(n):
            x, y = result.random_point()
            if 25 < x < 175 and 25 < y < 175:
                center_count += 1
        # Inner 75% region should contain most points
        assert center_count / n > 0.6

    def test_random_point_tiny_box(self) -> None:
        """A 1x1 pixel box should always return the same point."""
        result = FindElementResult(x1=500, y1=500, x2=501, y2=501, confidence=1.0)
        for _ in range(50):
            x, y = result.random_point()
            assert 500 <= x <= 501
            assert 500 <= y <= 501

    def test_random_point_zero_width_box(self) -> None:
        """Zero-width box (x1 == x2): x should always be x1."""
        result = FindElementResult(x1=100, y1=100, x2=100, y2=200, confidence=0.8)
        for _ in range(50):
            x, y = result.random_point()
            assert x == 100
            assert 100 <= y <= 200

    def test_random_points_returns_correct_count(self) -> None:
        """random_points(n) returns exactly n points."""
        result = FindElementResult(x1=0, y1=0, x2=200, y2=200, confidence=0.9)
        for n in (1, 3, 7):
            pts = result.random_points(n)
            assert len(pts) == n

    def test_random_points_all_within_bounds(self) -> None:
        """Every point from random_points is inside the bounding box."""
        result = FindElementResult(x1=50, y1=60, x2=150, y2=180, confidence=0.9)
        for x, y in result.random_points(200):
            assert 50 <= x <= 150, f'x={x} outside [50, 150]'
            assert 60 <= y <= 180, f'y={y} outside [60, 180]'

    def test_random_points_zero(self) -> None:
        """random_points(0) returns an empty list."""
        result = FindElementResult(x1=0, y1=0, x2=100, y2=100, confidence=0.9)
        assert result.random_points(0) == []


# ---------------------------------------------------------------------------
# CheckpointResult
# ---------------------------------------------------------------------------


class TestCheckpointResult:
    """VLM checkpoint result (page state verification)."""

    def test_on_track(self) -> None:
        result = CheckpointResult(on_track=True, confidence=0.95, reasoning='Page looks correct')
        assert result.on_track is True
        assert result.confidence == 0.95
        assert result.reasoning == 'Page looks correct'

    def test_off_track(self) -> None:
        result = CheckpointResult(on_track=False, confidence=0.3, reasoning='Wrong page')
        assert result.on_track is False

    def test_frozen(self) -> None:
        """CheckpointResult is immutable."""
        result = CheckpointResult(on_track=True, confidence=0.9, reasoning='OK')
        with pytest.raises(AttributeError):
            result.on_track = False  # type: ignore[misc]


# ---------------------------------------------------------------------------
# InferActionResult
# ---------------------------------------------------------------------------


class TestInferActionResult:
    """Freeform VLM action inference result."""

    def test_defaults(self) -> None:
        result = InferActionResult(
            action='click', target_x=100, target_y=200,
            text='', confidence=0.7, reasoning='Center of button',
        )
        assert result.action == 'click'
        assert result.target_x == 100
        assert result.target_y == 200
        assert result.text == ''

    def test_type_text_result(self) -> None:
        result = InferActionResult(
            action='type_text', target_x=0, target_y=0,
            text='hello', confidence=0.6, reasoning='Input field',
        )
        assert result.action == 'type_text'
        assert result.text == 'hello'


# ---------------------------------------------------------------------------
# MockInferenceClient
# ---------------------------------------------------------------------------


class TestMockInferenceClient:
    """Mock client for testing the executor without real VLM hardware."""

    def test_find_element_returns_valid_box(self) -> None:
        client = MockInferenceClient(image_width=2560, image_height=1800)
        result = client.find_element('fake_screenshot_b64', 'Sign In button')
        assert result.x1 < result.x2
        assert result.y1 < result.y2
        assert 0.0 <= result.confidence <= 1.0

    def test_find_element_uses_ref_region(self) -> None:
        """When ref_region is provided, MockInferenceClient uses it directly."""
        client = MockInferenceClient()
        ref = (100, 200, 300, 400)
        result = client.find_element('b64', 'Button', ref_region=ref)
        assert result.x1 == 100
        assert result.y1 == 200
        assert result.x2 == 300
        assert result.y2 == 400
        assert result.confidence == 0.95

    def test_find_element_no_ref_region(self) -> None:
        """Without ref_region, box is center-ish with jitter."""
        client = MockInferenceClient(image_width=1920, image_height=1080)
        results = [client.find_element('b64', 'Something') for _ in range(20)]
        # All boxes should have valid coordinates
        for r in results:
            assert r.x1 < r.x2
            assert r.y1 < r.y2
        # Not all boxes should be identical (randomness)
        x1_values = {r.x1 for r in results}
        assert len(x1_values) > 1

    def test_checkpoint_always_on_track(self) -> None:
        client = MockInferenceClient()
        result = client.checkpoint('b64', 'Is the page correct?')
        assert result.on_track is True
        assert result.confidence > 0.0

    def test_infer_action_returns_click(self) -> None:
        client = MockInferenceClient(image_width=1920, image_height=1080)
        result = client.infer_action('b64', 'Netflix cancel flow')
        assert result.action == 'click'
        assert result.target_x == 960  # width / 2
        assert result.target_y == 540  # height / 2


# ---------------------------------------------------------------------------
# CoordinateInferenceClient
# ---------------------------------------------------------------------------


class TestCoordinateInferenceClient:
    """Uses recorded ref_region from playbooks (no VLM needed)."""

    def test_find_element_with_ref_region(self) -> None:
        client = CoordinateInferenceClient()
        result = client.find_element('b64', 'Button', ref_region=(50, 60, 150, 100))
        assert result.x1 == 50
        assert result.y1 == 60
        assert result.x2 == 150
        assert result.y2 == 100
        assert result.confidence == 1.0

    def test_find_element_without_ref_region_raises(self) -> None:
        """CoordinateInferenceClient raises ValueError when no ref_region."""
        client = CoordinateInferenceClient()
        with pytest.raises(ValueError, match='requires ref_region'):
            client.find_element('b64', 'Sign In button')

    def test_checkpoint_always_passes(self) -> None:
        client = CoordinateInferenceClient()
        result = client.checkpoint('b64', 'Any prompt')
        assert result.on_track is True
        assert result.confidence == 1.0
        assert 'Coordinate mode' in result.reasoning

    def test_infer_action_raises(self) -> None:
        """infer_action is not supported in coordinate mode."""
        client = CoordinateInferenceClient()
        with pytest.raises(NotImplementedError):
            client.infer_action('b64', 'context')


# ---------------------------------------------------------------------------
# FindElementResult edge cases
# ---------------------------------------------------------------------------


class TestFindElementResultEdgeCases:
    """Bounding box edge cases and validation."""

    def test_inverted_box_coordinates(self) -> None:
        """If x1 > x2 (inverted box), random_point still works via min/max clipping."""
        # This is a pathological case, the code clips via min/max
        result = FindElementResult(x1=300, y1=400, x2=100, y2=200, confidence=0.5)
        # With inverted coords, the Gaussian clips to x1 (300) for x since min(max(gauss, 300), 100)
        # will always return 100 because max(anything, 300) >= 300, then min(300, 100) = 100
        x, y = result.random_point()
        # The result depends on the min/max logic: min(max(gauss(200, -50), 300), 100)
        # max(anything, 300) = 300 (at minimum), min(300, 100) = 100
        assert x == 100
        assert y == 200

    def test_large_bounding_box(self) -> None:
        """Full-screen bounding box still produces valid points."""
        result = FindElementResult(x1=0, y1=0, x2=2560, y2=1800, confidence=0.7)
        for _ in range(50):
            x, y = result.random_point()
            assert 0 <= x <= 2560
            assert 0 <= y <= 1800

    def test_confidence_zero(self) -> None:
        """Zero confidence is a valid (if unhelpful) result."""
        result = FindElementResult(x1=0, y1=0, x2=100, y2=100, confidence=0.0)
        assert result.confidence == 0.0
        # random_point still works
        x, y = result.random_point()
        assert 0 <= x <= 100
