"""
Coordinate translation between VLM image-pixel space and macOS screen points.

The VLM sees a screenshot captured in physical pixels (e.g. 2x on Retina).
It returns target coordinates in that image-pixel space.
This module translates those to screen points for pyautogui.
"""


def image_to_screen(
    img_x: float,
    img_y: float,
    window_bounds: dict,
    scale_factor: float = 2.0,
) -> tuple[float, float]:
    """
    Convert VLM image-pixel coordinates to screen points.

    img_x, img_y: pixel coordinates in the screenshot image
    window_bounds: {x, y, width, height} of the captured window in screen points
    scale_factor: display scale (2.0 for Retina, 1.0 for non-Retina)

    Returns (screen_x, screen_y) in macOS screen points.
    """
    screen_x = window_bounds['x'] + img_x / scale_factor
    screen_y = window_bounds['y'] + img_y / scale_factor
    return (screen_x, screen_y)


def screen_to_image(
    screen_x: float,
    screen_y: float,
    window_bounds: dict,
    scale_factor: float = 2.0,
) -> tuple[float, float]:
    """
    Convert screen points to VLM image-pixel coordinates.
    Reverse of image_to_screen.
    """
    img_x = (screen_x - window_bounds['x']) * scale_factor
    img_y = (screen_y - window_bounds['y']) * scale_factor
    return (img_x, img_y)
