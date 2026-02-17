"""
Human-like scrolling.

Uses Quartz directly (pyautogui.scroll is broken on newer macOS).
Variable speed between scroll ticks to avoid robotic uniformity.
"""

from __future__ import annotations

import random
import time

import Quartz


def scroll(
    direction: str,
    amount: int = 3,
    x: int | None = None,
    y: int | None = None,
) -> None:
    """
    Scroll with human-like variable speed between ticks.

    direction: 'up' or 'down'
    amount: number of scroll "clicks"
    x, y: optional position to move mouse to before scrolling
    """
    if x is not None and y is not None:
        from . import mouse as _mouse
        _mouse.move_to(x, y)
        time.sleep(random.uniform(0.1, 0.2))

    # Pixel-based scrolling via Quartz. Positive = content moves up (scroll up),
    # negative = content moves down (scroll down).
    pixels_per_click = 30
    scroll_px = pixels_per_click if direction == 'up' else -pixels_per_click

    for i in range(amount):
        event = Quartz.CGEventCreateScrollWheelEvent(
            None,
            Quartz.kCGScrollEventUnitPixel,
            1,  # number of axes
            scroll_px,
        )
        Quartz.CGEventPost(Quartz.kCGHIDEventTap, event)

        # Variable delay between ticks: starts slower, gets faster, then slows
        if amount > 1:
            progress = i / (amount - 1)
            speed_factor = 0.4 + 0.6 * (1 - abs(2 * progress - 1))
            delay = random.uniform(0.06, 0.15) / speed_factor
        else:
            delay = random.uniform(0.08, 0.15)
        time.sleep(delay)
