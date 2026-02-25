"""
Human-like mouse operations.

All coordinates are in macOS screen points (pyautogui's native system).
Coordinate translation from VLM image-pixels is handled by coords.py.
"""

from __future__ import annotations

import random
import time

import pyautogui
import Quartz

from . import humanize

# Safety: disable pyautogui's pause (we handle timing ourselves)
pyautogui.PAUSE = 0
# Keep failsafe (move mouse to corner to abort)
pyautogui.FAILSAFE = True


def _execute_path(
    points: list[tuple[float, float]],
    duration: float,
    event_type: int = Quartz.kCGEventMouseMoved,
) -> None:
    """Execute a mouse path via Quartz CGEvents with velocity-profiled timing."""
    delays = humanize.velocity_profile(len(points), base_delay=duration / max(len(points), 1))
    for i, (px, py) in enumerate(points):
        event = Quartz.CGEventCreateMouseEvent(
            None, event_type,
            (px, py), Quartz.kCGMouseButtonLeft,
        )
        Quartz.CGEventPost(Quartz.kCGHIDEventTap, event)
        if i < len(delays):
            time.sleep(delays[i])


def move_to(x: int, y: int, fast: bool = False) -> None:
    """
    Move mouse to absolute screen coordinates with a human-like Bezier path.
    Includes velocity profile, jitter, and occasional overshoot.

    fast: same arc shape but ~3x faster (for session setup, not page interaction)
    """
    start = pyautogui.position()
    sx, sy = start
    target = (float(x), float(y))
    distance = ((x - sx) ** 2 + (y - sy) ** 2) ** 0.5

    if distance < 2:
        pyautogui.moveTo(x, y)
        return

    n_points = humanize.num_waypoints(distance)
    duration = humanize.movement_duration(distance)
    if fast:
        duration *= 0.15
        n_points = max(n_points // 2, 10)

    # Generate path
    points = humanize.bezier_curve((sx, sy), target, num_points=n_points)
    if not fast:
        points = humanize.apply_jitter(points, magnitude=0.15 + distance * 0.00025)
    if not fast:
        points = humanize.apply_overshoot(points, target, probability=0.12)

    _execute_path(points, duration)


def move_by(dx: int, dy: int, fast: bool = False) -> None:
    """Move mouse by a relative offset."""
    cx, cy = pyautogui.position()
    move_to(cx + dx, cy + dy, fast=fast)


def click(
    x: int | None = None,
    y: int | None = None,
    button: str = 'left',
    fast: bool = False,
) -> None:
    """
    Click at coordinates (or current position if no coords given).
    Includes natural pre-click hover and click duration.
    """
    if x is not None and y is not None:
        move_to(x, y, fast=fast)

    # Pre-click hover: 100-300ms
    time.sleep(random.uniform(0.1, 0.3))

    # Click with natural press/release duration: 80-150ms
    press_duration = random.uniform(0.08, 0.15)
    pyautogui.mouseDown(button=button, _pause=False)
    time.sleep(press_duration)
    pyautogui.mouseUp(button=button, _pause=False)


def double_click(x: int | None = None, y: int | None = None) -> None:
    """Double click with 80-200ms gap between clicks."""
    if x is not None and y is not None:
        move_to(x, y)

    # Pre-click hover
    time.sleep(random.uniform(0.1, 0.25))

    # First click
    press_duration = random.uniform(0.06, 0.12)
    pyautogui.mouseDown(button='left', _pause=False)
    time.sleep(press_duration)
    pyautogui.mouseUp(button='left', _pause=False)

    # Gap between clicks
    time.sleep(random.uniform(0.08, 0.2))

    # Second click
    press_duration = random.uniform(0.06, 0.12)
    pyautogui.mouseDown(button='left', _pause=False)
    time.sleep(press_duration)
    pyautogui.mouseUp(button='left', _pause=False)


def right_click(x: int | None = None, y: int | None = None) -> None:
    """Right-click."""
    click(x, y, button='right')


def position() -> tuple[int, int]:
    """Return current mouse position in screen points."""
    return pyautogui.position()


def drag(
    start_x: int,
    start_y: int,
    end_x: int,
    end_y: int,
    button: str = 'left',
    fast: bool = False,
) -> None:
    """
    Mouse-down at start, Bezier move to end, mouse-up.
    Used for selections, window resizing, sliders.

    fast: minimal timing, no jitter (for session setup, not page interaction)
    """
    move_to(start_x, start_y, fast=fast)
    time.sleep(0.02 if fast else random.uniform(0.1, 0.2))

    pyautogui.mouseDown(button=button, _pause=False)
    time.sleep(0.02 if fast else random.uniform(0.05, 0.15))

    # Drag path
    distance = ((end_x - start_x) ** 2 + (end_y - start_y) ** 2) ** 0.5
    n_points = humanize.num_waypoints(distance)
    duration = humanize.movement_duration(distance) * 1.3
    if fast:
        duration *= 0.15
        n_points = max(n_points // 3, 5)

    points = humanize.bezier_curve(
        (float(start_x), float(start_y)),
        (float(end_x), float(end_y)),
        num_points=n_points,
        curvature=0.15 if not fast else 0.02,
    )
    if not fast:
        points = humanize.apply_jitter(points, magnitude=0.8)

    # Use Quartz kCGEventLeftMouseDragged so the window follows the cursor.
    # pyautogui.moveTo sends kCGEventMouseMoved which macOS ignores during drag.
    drag_type = Quartz.kCGEventLeftMouseDragged
    if button == 'right':
        drag_type = Quartz.kCGEventRightMouseDragged

    _execute_path(points, duration, event_type=drag_type)

    time.sleep(0.02 if fast else random.uniform(0.05, 0.15))
    pyautogui.mouseUp(button=button, _pause=False)
