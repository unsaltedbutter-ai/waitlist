"""Tests for coordinate translation between VLM image-pixel space and screen points.

Run: cd agent && python -m pytest tests/test_coords.py -v
"""

from __future__ import annotations

import pytest

from agent.input.coords import image_to_screen, screen_to_image


# ---------------------------------------------------------------------------
# image_to_screen
# ---------------------------------------------------------------------------


class TestImageToScreen:
    """Convert VLM image-pixel coords to macOS screen points."""

    def test_retina_2x_basic(self) -> None:
        """Standard Retina: image pixel 200,300 at window (100, 50) => screen (200, 200)."""
        bounds = {'x': 100, 'y': 50, 'width': 1280, 'height': 900}
        sx, sy = image_to_screen(200, 300, bounds, scale_factor=2.0)
        assert sx == 200.0  # 100 + 200/2
        assert sy == 200.0  # 50 + 300/2

    def test_chrome_offset_added_to_y(self) -> None:
        """chrome_offset shifts y by the cropped browser chrome height."""
        bounds = {'x': 0, 'y': 0, 'width': 1280, 'height': 900}
        # Without chrome_offset: y = 0 + 100/1.0 = 100
        sx, sy = image_to_screen(200, 100, bounds, scale_factor=1.0)
        assert sy == 100.0
        # With chrome_offset=88: y = 0 + (100 + 88)/1.0 = 188
        sx2, sy2 = image_to_screen(200, 100, bounds, scale_factor=1.0, chrome_offset=88)
        assert sx2 == 200.0  # x unchanged
        assert sy2 == 188.0

    def test_chrome_offset_with_retina(self) -> None:
        """chrome_offset is in physical pixels, divided by scale."""
        bounds = {'x': 0, 'y': 0, 'width': 1280, 'height': 900}
        # chrome_offset=176 physical px on Retina = 88 logical px
        sx, sy = image_to_screen(0, 0, bounds, scale_factor=2.0, chrome_offset=176)
        assert sx == 0.0
        assert sy == 88.0  # 0 + (0 + 176) / 2.0

    def test_chrome_offset_default_zero(self) -> None:
        """Default chrome_offset=0 preserves backwards compatibility."""
        bounds = {'x': 100, 'y': 50, 'width': 1280, 'height': 900}
        sx1, sy1 = image_to_screen(200, 300, bounds, scale_factor=2.0)
        sx2, sy2 = image_to_screen(200, 300, bounds, scale_factor=2.0, chrome_offset=0)
        assert sx1 == sx2
        assert sy1 == sy2

    def test_non_retina_1x(self) -> None:
        """Non-Retina: image pixels map 1:1 to screen points."""
        bounds = {'x': 0, 'y': 0, 'width': 1920, 'height': 1080}
        sx, sy = image_to_screen(500, 400, bounds, scale_factor=1.0)
        assert sx == 500.0
        assert sy == 400.0

    def test_origin_maps_to_window_origin(self) -> None:
        """Image pixel (0,0) maps to the window's top-left screen position."""
        bounds = {'x': 200, 'y': 150, 'width': 800, 'height': 600}
        sx, sy = image_to_screen(0, 0, bounds)
        assert sx == 200.0
        assert sy == 150.0

    def test_window_offset(self) -> None:
        """Window not at screen origin: offset is added."""
        bounds = {'x': 300, 'y': 200, 'width': 1280, 'height': 900}
        sx, sy = image_to_screen(100, 100, bounds, scale_factor=2.0)
        assert sx == 350.0  # 300 + 100/2
        assert sy == 250.0  # 200 + 100/2

    def test_float_precision(self) -> None:
        """Non-even pixel values produce fractional screen points."""
        bounds = {'x': 0, 'y': 0, 'width': 1280, 'height': 900}
        sx, sy = image_to_screen(101, 201, bounds, scale_factor=2.0)
        assert sx == 50.5
        assert sy == 100.5


# ---------------------------------------------------------------------------
# screen_to_image
# ---------------------------------------------------------------------------


class TestScreenToImage:
    """Convert macOS screen points to VLM image-pixel coords."""

    def test_retina_2x_basic(self) -> None:
        bounds = {'x': 100, 'y': 50, 'width': 1280, 'height': 900}
        ix, iy = screen_to_image(200, 200, bounds, scale_factor=2.0)
        assert ix == 200.0  # (200 - 100) * 2
        assert iy == 300.0  # (200 - 50) * 2

    def test_non_retina_1x(self) -> None:
        bounds = {'x': 0, 'y': 0, 'width': 1920, 'height': 1080}
        ix, iy = screen_to_image(500, 400, bounds, scale_factor=1.0)
        assert ix == 500.0
        assert iy == 400.0

    def test_origin_maps_to_zero(self) -> None:
        """Screen point at window origin maps to image (0,0)."""
        bounds = {'x': 200, 'y': 150, 'width': 800, 'height': 600}
        ix, iy = screen_to_image(200, 150, bounds)
        assert ix == 0.0
        assert iy == 0.0


# ---------------------------------------------------------------------------
# Roundtrip
# ---------------------------------------------------------------------------


class TestRoundtrip:
    """image_to_screen and screen_to_image are inverses."""

    @pytest.mark.parametrize(
        'img_x, img_y, bounds, scale',
        [
            (500, 300, {'x': 0, 'y': 0, 'width': 2560, 'height': 1800}, 2.0),
            (0, 0, {'x': 100, 'y': 200, 'width': 1280, 'height': 900}, 2.0),
            (1920, 1080, {'x': 0, 'y': 0, 'width': 1920, 'height': 1080}, 1.0),
            (123, 456, {'x': 50, 'y': 75, 'width': 800, 'height': 600}, 2.0),
        ],
    )
    def test_image_screen_roundtrip(
        self, img_x: int, img_y: int, bounds: dict, scale: float,
    ) -> None:
        """Convert image->screen->image should return original coords."""
        sx, sy = image_to_screen(img_x, img_y, bounds, scale)
        rx, ry = screen_to_image(sx, sy, bounds, scale)
        assert abs(rx - img_x) < 0.001
        assert abs(ry - img_y) < 0.001

    @pytest.mark.parametrize(
        'screen_x, screen_y, bounds, scale',
        [
            (640, 450, {'x': 0, 'y': 0, 'width': 1280, 'height': 900}, 2.0),
            (350, 275, {'x': 300, 'y': 200, 'width': 1280, 'height': 900}, 2.0),
        ],
    )
    def test_screen_image_roundtrip(
        self, screen_x: float, screen_y: float, bounds: dict, scale: float,
    ) -> None:
        """Convert screen->image->screen should return original coords."""
        ix, iy = screen_to_image(screen_x, screen_y, bounds, scale)
        sx, sy = image_to_screen(ix, iy, bounds, scale)
        assert abs(sx - screen_x) < 0.001
        assert abs(sy - screen_y) < 0.001
