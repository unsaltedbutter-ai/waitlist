"""
Math primitives for human-like input simulation.

Bezier curves, velocity profiles, jitter, typo generation.
No pyautogui dependency: pure math only.
"""

from __future__ import annotations

import math
import random
import string

# QWERTY adjacency map for realistic typo generation
ADJACENT_KEYS = {
    'q': ['w', 'a'],
    'w': ['q', 'e', 'a', 's'],
    'e': ['w', 'r', 's', 'd'],
    'r': ['e', 't', 'd', 'f'],
    't': ['r', 'y', 'f', 'g'],
    'y': ['t', 'u', 'g', 'h'],
    'u': ['y', 'i', 'h', 'j'],
    'i': ['u', 'o', 'j', 'k'],
    'o': ['i', 'p', 'k', 'l'],
    'p': ['o', 'l'],
    'a': ['q', 'w', 's', 'z'],
    's': ['a', 'w', 'e', 'd', 'z', 'x'],
    'd': ['s', 'e', 'r', 'f', 'x', 'c'],
    'f': ['d', 'r', 't', 'g', 'c', 'v'],
    'g': ['f', 't', 'y', 'h', 'v', 'b'],
    'h': ['g', 'y', 'u', 'j', 'b', 'n'],
    'j': ['h', 'u', 'i', 'k', 'n', 'm'],
    'k': ['j', 'i', 'o', 'l', 'm'],
    'l': ['k', 'o', 'p'],
    'z': ['a', 's', 'x'],
    'x': ['z', 's', 'd', 'c'],
    'c': ['x', 'd', 'f', 'v'],
    'v': ['c', 'f', 'g', 'b'],
    'b': ['v', 'g', 'h', 'n'],
    'n': ['b', 'h', 'j', 'm'],
    'm': ['n', 'j', 'k'],
    '1': ['2', 'q'],
    '2': ['1', '3', 'q', 'w'],
    '3': ['2', '4', 'w', 'e'],
    '4': ['3', '5', 'e', 'r'],
    '5': ['4', '6', 'r', 't'],
    '6': ['5', '7', 't', 'y'],
    '7': ['6', '8', 'y', 'u'],
    '8': ['7', '9', 'u', 'i'],
    '9': ['8', '0', 'i', 'o'],
    '0': ['9', 'o', 'p'],
}

# Character pairs that are harder to type (longer delay)
SLOW_PAIRS = {
    ('a', 'p'), ('p', 'a'), ('q', 'p'), ('p', 'q'),
    ('z', 'p'), ('p', 'z'), ('a', 'l'), ('l', 'a'),
    ('z', 'm'), ('m', 'z'), ('q', 'z'), ('z', 'q'),
}


def bezier_curve(
    start: tuple[float, float],
    end: tuple[float, float],
    num_points: int = 50,
    curvature: float = 0.3,
) -> list[tuple[float, float]]:
    """
    Generate a cubic Bezier curve from start to end.

    Control points are placed perpendicular to the start-end line,
    offset by a random fraction of the distance (scaled by curvature).
    Returns a list of (x, y) waypoints.
    """
    sx, sy = start
    ex, ey = end

    dx = ex - sx
    dy = ey - sy
    dist = math.hypot(dx, dy)

    if dist < 1:
        return [start, end]

    # Perpendicular direction
    perp_x = -dy / dist
    perp_y = dx / dist

    # Two control points at 1/3 and 2/3 along the line, offset perpendicular
    offset1 = random.uniform(-curvature, curvature) * dist
    offset2 = random.uniform(-curvature, curvature) * dist

    cp1 = (
        sx + dx * 0.33 + perp_x * offset1,
        sy + dy * 0.33 + perp_y * offset1,
    )
    cp2 = (
        sx + dx * 0.66 + perp_x * offset2,
        sy + dy * 0.66 + perp_y * offset2,
    )

    points = []
    for i in range(num_points + 1):
        t = i / num_points
        u = 1 - t
        # Cubic Bezier: B(t) = (1-t)^3*P0 + 3*(1-t)^2*t*P1 + 3*(1-t)*t^2*P2 + t^3*P3
        x = (u**3 * sx
             + 3 * u**2 * t * cp1[0]
             + 3 * u * t**2 * cp2[0]
             + t**3 * ex)
        y = (u**3 * sy
             + 3 * u**2 * t * cp1[1]
             + 3 * u * t**2 * cp2[1]
             + t**3 * ey)
        points.append((x, y))

    return points


def apply_jitter(
    points: list[tuple[float, float]],
    magnitude: float = 1.5,
) -> list[tuple[float, float]]:
    """
    Add small random noise to path points.
    First and last points are kept exact.
    """
    if len(points) <= 2:
        return points

    result = [points[0]]
    for x, y in points[1:-1]:
        jx = x + random.gauss(0, magnitude)
        jy = y + random.gauss(0, magnitude)
        result.append((jx, jy))
    result.append(points[-1])
    return result


def apply_overshoot(
    points: list[tuple[float, float]],
    target: tuple[float, float],
    probability: float = 0.15,
) -> list[tuple[float, float]]:
    """
    With some probability, overshoot the target by 5-20px
    and append correction waypoints back to the true target.
    """
    if random.random() > probability:
        return points

    tx, ty = target
    overshoot_dist = random.uniform(5, 20)
    angle = random.uniform(0, 2 * math.pi)
    ox = tx + overshoot_dist * math.cos(angle)
    oy = ty + overshoot_dist * math.sin(angle)

    # Replace last point with overshoot, then add correction path
    result = points[:-1]
    result.append((ox, oy))

    # Small correction curve back to target (fewer points, slower)
    correction = bezier_curve((ox, oy), (tx, ty), num_points=8, curvature=0.1)
    result.extend(correction[1:])  # skip first (duplicate of overshoot)

    return result


def velocity_profile(num_points: int, base_delay: float = 0.01) -> list[float]:
    """
    Ease-in-out timing: slow start, fast middle, slow end.
    Returns delays (seconds) between consecutive points.

    Uses a sine-based profile so the mouse accelerates
    in the middle and decelerates at endpoints.
    """
    if num_points <= 1:
        return []

    delays = []
    for i in range(num_points):
        # sin curve: minimum speed at edges, full speed at center
        progress = i / (num_points - 1) if num_points > 1 else 0
        speed_factor = 0.5 + 0.5 * math.sin(math.pi * progress)
        # Invert: high speed = low delay
        delay = base_delay / max(speed_factor, 0.1)
        delays.append(delay)

    return delays


def movement_duration(distance: float) -> float:
    """
    Estimate total movement time based on Fitts's Law approximation.
    Short moves (~50px): ~180ms.
    Long moves (~1000px): ~450ms.
    Returns duration in seconds with gaussian noise.
    """
    if distance < 1:
        return 0.0

    # log-based scaling loosely inspired by Fitts's Law
    base = 0.10 + 0.08 * math.log2(1 + distance / 50)
    noise = random.gauss(1.0, 0.15)  # 15% variance
    return max(0.07, base * noise)


def num_waypoints(distance: float) -> int:
    """
    Choose number of Bezier waypoints based on distance.
    Enough points for smooth visual rendering without excessive overhead.
    """
    if distance < 10:
        return 5
    if distance < 100:
        return 15
    if distance < 500:
        return 30
    return 50


def typing_delay(
    speed: str = 'medium',
    char: str = '',
    prev_char: str = '',
) -> float:
    """
    Inter-key delay based on speed setting and character pair difficulty.

    speed: 'fast' (~60ms avg), 'medium' (~120ms avg), 'slow' (~200ms avg)
    Returns delay in seconds.
    """
    base_ms = {'fast': 60, 'medium': 120, 'slow': 200}.get(speed, 120)

    # Harder character pairs get a penalty
    if (prev_char.lower(), char.lower()) in SLOW_PAIRS:
        base_ms *= 1.4

    # Shift key adds a small penalty
    if char.isupper() or char in '!@#$%^&*()_+{}|:"<>?':
        base_ms *= 1.15

    # Space after word is slightly faster (rhythm)
    if char == ' ':
        base_ms *= 0.85

    # Normal distribution variance
    delay_ms = random.gauss(base_ms, base_ms * 0.25)
    return max(0.02, delay_ms / 1000.0)


def typo_generator(text: str, accuracy: str = 'high') -> list[dict]:
    """
    Generate a sequence of typing actions, optionally with realistic typos.

    accuracy: 'high' (no typos), 'average' (~3%), 'low' (~8%)

    Returns a list of actions:
      {'action': 'type', 'char': 'h'}
      {'action': 'typo', 'wrong': 'r', 'correct': 'e'}
        (means: type 'r', pause, backspace, type 'e')
    """
    typo_rate = {'high': 0.0, 'average': 0.03, 'low': 0.08}.get(accuracy, 0.0)

    actions = []
    for char in text:
        if typo_rate > 0 and random.random() < typo_rate:
            wrong = _adjacent_key(char)
            if wrong and wrong != char:
                actions.append({'action': 'typo', 'wrong': wrong, 'correct': char})
                continue
        actions.append({'action': 'type', 'char': char})

    return actions


def _adjacent_key(char: str) -> str:
    """Pick a random adjacent key for a typo. Returns the char unchanged if no adjacency."""
    lower = char.lower()
    if lower in ADJACENT_KEYS:
        adj = random.choice(ADJACENT_KEYS[lower])
        return adj.upper() if char.isupper() else adj
    return char
