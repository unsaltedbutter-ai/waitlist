"""
Coordinate translation between VLM image-pixel space and macOS screen points.

The VLM sees a screenshot captured in physical pixels (e.g. 2x on Retina).
It returns target coordinates in that image-pixel space.
This module translates those to screen points for pyautogui.

The display scale factor is auto-detected at import time via
get_retina_scale(). Override with set_display_scale() for testing.
"""

_display_scale: float | None = None


def _get_display_scale() -> float:
    """Return the cached display scale, detecting it on first call."""
    global _display_scale
    if _display_scale is None:
        try:
            from agent.input.window import get_retina_scale
            result = get_retina_scale()
            # Guard against mocked Quartz in test environments
            _display_scale = float(result) if isinstance(result, (int, float)) else 1.0
        except Exception:
            _display_scale = 1.0
    return _display_scale


def set_display_scale(scale: float) -> None:
    """Override the display scale (for testing or non-primary displays)."""
    global _display_scale
    _display_scale = scale


def image_to_screen(
    img_x: float,
    img_y: float,
    window_bounds: dict,
    scale_factor: float | None = None,
    chrome_offset: int = 0,
) -> tuple[float, float]:
    """
    Convert VLM image-pixel coordinates to screen points.

    img_x, img_y: pixel coordinates in the screenshot image (physical pixels).
        When the screenshot has been cropped (browser chrome removed), these are
        page-relative. Pass chrome_offset to add the cropped region back.
    window_bounds: {x, y, width, height} of the captured window in screen points
    scale_factor: display scale (auto-detected if None; 2.0 for Retina, 1.0 for non-Retina)
    chrome_offset: physical pixels cropped from the top of the screenshot (e.g.
        browser chrome height). Added to img_y before converting to screen points.
        Defaults to 0 for backwards compatibility.

    Returns (screen_x, screen_y) in macOS screen points.
    """
    if scale_factor is None:
        scale_factor = _get_display_scale()
    screen_x = window_bounds['x'] + img_x / scale_factor
    screen_y = window_bounds['y'] + (img_y + chrome_offset) / scale_factor
    return (screen_x, screen_y)


def screen_to_image(
    screen_x: float,
    screen_y: float,
    window_bounds: dict,
    scale_factor: float | None = None,
) -> tuple[float, float]:
    """
    Convert screen points to VLM image-pixel coordinates.
    Reverse of image_to_screen.
    """
    if scale_factor is None:
        scale_factor = _get_display_scale()
    img_x = (screen_x - window_bounds['x']) * scale_factor
    img_y = (screen_y - window_bounds['y']) * scale_factor
    return (img_x, img_y)
