"""
Human-like scrolling.

Variable speed between scroll ticks to avoid robotic uniformity.
"""

from __future__ import annotations

import random
import time

import pyautogui

pyautogui.PAUSE = 0


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

    scroll_value = 1 if direction == 'up' else -1

    for i in range(amount):
        pyautogui.scroll(scroll_value, _pause=False)
        # Variable delay between ticks: starts slower, gets faster, then slows
        if amount > 1:
            progress = i / (amount - 1)
            # Bell-shaped speed: fast in the middle
            speed_factor = 0.4 + 0.6 * (1 - abs(2 * progress - 1))
            delay = random.uniform(0.06, 0.15) / speed_factor
        else:
            delay = random.uniform(0.08, 0.15)
        time.sleep(delay)
