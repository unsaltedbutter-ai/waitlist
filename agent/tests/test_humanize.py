"""Tests for humanize math primitives (Bezier, velocity, typing, typos).

All functions in humanize.py are pure math with no macOS dependencies,
so these tests run everywhere.

Run: cd agent && python -m pytest tests/test_humanize.py -v
"""

from __future__ import annotations

import math
import random

import pytest

from agent.input.humanize import (
    ADJACENT_KEYS,
    SLOW_PAIRS,
    apply_jitter,
    apply_overshoot,
    bezier_curve,
    movement_duration,
    num_waypoints,
    typo_generator,
    typing_delay,
    velocity_profile,
)


# ---------------------------------------------------------------------------
# bezier_curve
# ---------------------------------------------------------------------------


class TestBezierCurve:
    """Cubic Bezier curve generation."""

    def test_starts_at_start(self) -> None:
        points = bezier_curve((0, 0), (100, 100), num_points=20)
        assert points[0] == (0, 0)

    def test_ends_at_end(self) -> None:
        points = bezier_curve((0, 0), (100, 100), num_points=20)
        end_x, end_y = points[-1]
        assert abs(end_x - 100) < 0.01
        assert abs(end_y - 100) < 0.01

    def test_correct_number_of_points(self) -> None:
        """num_points=50 produces 51 points (inclusive of endpoints)."""
        points = bezier_curve((0, 0), (200, 300), num_points=50)
        assert len(points) == 51

    def test_zero_distance_returns_two_points(self) -> None:
        """When start == end, returns [start, end]."""
        points = bezier_curve((50, 50), (50, 50), num_points=100)
        assert len(points) == 2
        assert points[0] == (50, 50)
        assert points[1] == (50, 50)

    def test_near_zero_distance(self) -> None:
        """Distance < 1 returns just two points."""
        points = bezier_curve((100.0, 100.0), (100.3, 100.3), num_points=50)
        assert len(points) == 2

    def test_curvature_zero_is_straight_line(self) -> None:
        """With curvature=0, all control points are on the line, so curve is straight."""
        random.seed(42)
        points = bezier_curve((0, 0), (100, 0), num_points=20, curvature=0)
        # All y values should be very close to 0
        for x, y in points:
            assert abs(y) < 0.1

    def test_curvature_creates_deviation(self) -> None:
        """Non-zero curvature moves points off the straight line."""
        random.seed(12345)
        points = bezier_curve((0, 0), (500, 0), num_points=50, curvature=0.5)
        # At least some mid-path points should have non-zero y
        y_values = [y for _, y in points[5:-5]]
        max_deviation = max(abs(y) for y in y_values)
        assert max_deviation > 1.0

    def test_negative_coordinates(self) -> None:
        """Bezier works with negative start/end coordinates."""
        points = bezier_curve((-100, -200), (100, 200), num_points=10)
        assert len(points) == 11
        assert points[0] == (-100, -200)
        end_x, end_y = points[-1]
        assert abs(end_x - 100) < 0.01
        assert abs(end_y - 200) < 0.01

    def test_large_distance(self) -> None:
        """Handles large screen-distance movements."""
        points = bezier_curve((0, 0), (5000, 3000), num_points=100)
        assert len(points) == 101
        end_x, end_y = points[-1]
        assert abs(end_x - 5000) < 0.01
        assert abs(end_y - 3000) < 0.01


# ---------------------------------------------------------------------------
# apply_jitter
# ---------------------------------------------------------------------------


class TestApplyJitter:
    """Add noise to path points (first and last preserved)."""

    def test_preserves_endpoints(self) -> None:
        points = [(0, 0), (50, 50), (100, 100)]
        jittered = apply_jitter(points, magnitude=5.0)
        assert jittered[0] == (0, 0)
        assert jittered[-1] == (100, 100)

    def test_modifies_middle_points(self) -> None:
        """Middle points should differ from originals (with high magnitude)."""
        random.seed(99)
        points = [(0, 0)] + [(50 + i, 50 + i) for i in range(20)] + [(100, 100)]
        jittered = apply_jitter(points, magnitude=10.0)
        # At least some middle points should have changed
        diffs = [
            abs(jittered[i][0] - points[i][0]) + abs(jittered[i][1] - points[i][1])
            for i in range(1, len(points) - 1)
        ]
        assert max(diffs) > 0.1

    def test_two_points_unchanged(self) -> None:
        """With only 2 points, jitter returns them unchanged."""
        points = [(0, 0), (100, 100)]
        result = apply_jitter(points, magnitude=10.0)
        assert result == points

    def test_single_point_unchanged(self) -> None:
        points = [(42, 42)]
        result = apply_jitter(points, magnitude=10.0)
        assert result == points

    def test_zero_magnitude(self) -> None:
        """magnitude=0 should leave all points unchanged (gauss with sigma=0)."""
        points = [(0, 0), (50, 50), (100, 100)]
        result = apply_jitter(points, magnitude=0.0)
        # First and last are exact; middle uses gauss(0, 0) which is always 0
        assert result[0] == (0, 0)
        assert result[-1] == (100, 100)
        assert result[1] == (50, 50)


# ---------------------------------------------------------------------------
# apply_overshoot
# ---------------------------------------------------------------------------


class TestApplyOvershoot:
    """Occasional mouse overshoot past the target with correction."""

    def test_overshoot_with_probability_one(self) -> None:
        """When probability=1.0, overshoot always happens."""
        random.seed(42)
        points = [(0, 0), (50, 50), (100, 100)]
        result = apply_overshoot(points, target=(100, 100), probability=1.0)
        # Should have more points than original (correction path appended)
        assert len(result) > len(points)
        # Final point should be the target
        end_x, end_y = result[-1]
        assert abs(end_x - 100) < 0.5
        assert abs(end_y - 100) < 0.5

    def test_overshoot_with_probability_zero(self) -> None:
        """probability=0.0 means overshoot never happens."""
        points = [(0, 0), (100, 100)]
        result = apply_overshoot(points, target=(100, 100), probability=0.0)
        assert result == points

    def test_overshoot_adds_correction_path(self) -> None:
        """The overshoot point should be near but not at the target."""
        random.seed(7)
        points = [(0, 0), (500, 500)]
        result = apply_overshoot(points, target=(500, 500), probability=1.0)
        # The point just before the correction path is the overshoot
        overshoot_x, overshoot_y = result[1]
        dist = math.hypot(overshoot_x - 500, overshoot_y - 500)
        assert 5 <= dist <= 20  # overshoot distance is 5-20px


# ---------------------------------------------------------------------------
# velocity_profile
# ---------------------------------------------------------------------------


class TestVelocityProfile:
    """Ease-in-out timing for mouse movement."""

    def test_returns_correct_count(self) -> None:
        delays = velocity_profile(50)
        assert len(delays) == 50

    def test_empty_for_single_point(self) -> None:
        delays = velocity_profile(1)
        assert delays == []

    def test_empty_for_zero_points(self) -> None:
        delays = velocity_profile(0)
        assert delays == []

    def test_all_positive_delays(self) -> None:
        delays = velocity_profile(100, base_delay=0.01)
        assert all(d > 0 for d in delays)

    def test_ease_in_out_shape(self) -> None:
        """Edge delays should be larger than center delays (slow-fast-slow)."""
        delays = velocity_profile(100, base_delay=0.01)
        # Compare first few vs middle
        edge_avg = (delays[0] + delays[1] + delays[-1] + delays[-2]) / 4
        mid_start = len(delays) // 2 - 2
        mid_avg = sum(delays[mid_start:mid_start + 4]) / 4
        assert edge_avg > mid_avg


# ---------------------------------------------------------------------------
# movement_duration
# ---------------------------------------------------------------------------


class TestMovementDuration:
    """Fitts's Law approximation for total movement time."""

    def test_zero_distance(self) -> None:
        assert movement_duration(0) == 0.0

    def test_negative_distance_treated_as_zero(self) -> None:
        """Distances < 1 return 0."""
        assert movement_duration(0.5) == 0.0

    def test_short_move(self) -> None:
        """Short move (~50px) should be roughly 200-400ms on average."""
        random.seed(42)
        durations = [movement_duration(50) for _ in range(100)]
        avg = sum(durations) / len(durations)
        assert 0.1 < avg < 0.8

    def test_long_move_takes_longer(self) -> None:
        """Longer distances should yield longer durations on average."""
        random.seed(42)
        short_avg = sum(movement_duration(50) for _ in range(100)) / 100
        long_avg = sum(movement_duration(1000) for _ in range(100)) / 100
        assert long_avg > short_avg

    def test_always_positive(self) -> None:
        """Non-zero distance always returns positive duration (min 0.1s)."""
        random.seed(42)
        for _ in range(100):
            d = movement_duration(100)
            assert d >= 0.1


# ---------------------------------------------------------------------------
# num_waypoints
# ---------------------------------------------------------------------------


class TestNumWaypoints:
    """Waypoint count selection based on distance."""

    def test_tiny_distance(self) -> None:
        assert num_waypoints(5) == 5

    def test_short_distance(self) -> None:
        assert num_waypoints(50) == 15

    def test_medium_distance(self) -> None:
        assert num_waypoints(300) == 30

    def test_long_distance(self) -> None:
        assert num_waypoints(600) == 50

    def test_exact_boundaries(self) -> None:
        """Test the exact threshold values."""
        assert num_waypoints(10) == 15    # 10 is >= 10, < 100
        assert num_waypoints(100) == 30   # 100 is >= 100, < 500
        assert num_waypoints(500) == 50   # 500 is >= 500

    def test_monotonically_increasing(self) -> None:
        """Longer distance should give equal or more waypoints."""
        distances = [1, 5, 10, 50, 100, 200, 500, 1000]
        counts = [num_waypoints(d) for d in distances]
        for i in range(len(counts) - 1):
            assert counts[i] <= counts[i + 1]


# ---------------------------------------------------------------------------
# typing_delay
# ---------------------------------------------------------------------------


class TestTypingDelay:
    """Inter-key delay based on speed and character pair difficulty."""

    def test_always_positive(self) -> None:
        random.seed(42)
        for _ in range(100):
            d = typing_delay('medium', 'a', 'b')
            assert d >= 0.02

    def test_fast_is_faster_than_slow(self) -> None:
        """On average, 'fast' delay < 'slow' delay."""
        random.seed(42)
        fast_avg = sum(typing_delay('fast', 'a') for _ in range(200)) / 200
        slow_avg = sum(typing_delay('slow', 'a') for _ in range(200)) / 200
        assert fast_avg < slow_avg

    def test_slow_pair_penalty(self) -> None:
        """Difficult character pairs (e.g., ('a', 'p')) get a 40% penalty."""
        random.seed(42)
        normal_avg = sum(typing_delay('medium', 'b', 'c') for _ in range(500)) / 500
        slow_avg = sum(typing_delay('medium', 'p', 'a') for _ in range(500)) / 500
        # slow_avg should be noticeably larger
        assert slow_avg > normal_avg * 1.2

    def test_shift_penalty(self) -> None:
        """Uppercase characters get a 15% penalty."""
        random.seed(42)
        lower_avg = sum(typing_delay('medium', 'a') for _ in range(500)) / 500
        upper_avg = sum(typing_delay('medium', 'A') for _ in range(500)) / 500
        assert upper_avg > lower_avg

    def test_space_is_faster(self) -> None:
        """Space after a word is slightly faster (85% of base)."""
        random.seed(42)
        space_avg = sum(typing_delay('medium', ' ') for _ in range(500)) / 500
        letter_avg = sum(typing_delay('medium', 'e') for _ in range(500)) / 500
        assert space_avg < letter_avg

    def test_unknown_speed_defaults_to_medium(self) -> None:
        """An unrecognized speed string defaults to 120ms base."""
        random.seed(42)
        mystery = sum(typing_delay('unknown_speed', 'a') for _ in range(200)) / 200
        medium = sum(typing_delay('medium', 'a') for _ in range(200)) / 200
        # Should be approximately equal (same base)
        assert abs(mystery - medium) < 0.03


# ---------------------------------------------------------------------------
# typo_generator
# ---------------------------------------------------------------------------


class TestTypoGenerator:
    """Generate typing actions with optional realistic typos."""

    def test_high_accuracy_no_typos(self) -> None:
        """accuracy='high' produces zero typos."""
        actions = typo_generator('hello world', accuracy='high')
        assert all(a['action'] == 'type' for a in actions)
        typed = ''.join(a['char'] for a in actions)
        assert typed == 'hello world'

    def test_average_accuracy_some_typos(self) -> None:
        """accuracy='average' (~3%) should produce some typos over a long string."""
        random.seed(42)
        text = 'abcdefghijklmnopqrstuvwxyz' * 10  # 260 chars
        actions = typo_generator(text, accuracy='average')
        typo_count = sum(1 for a in actions if a['action'] == 'typo')
        # With 260 chars at 3%, expect ~8 typos. Allow wide range.
        assert typo_count > 0
        assert typo_count < 40

    def test_low_accuracy_more_typos(self) -> None:
        """accuracy='low' (~8%) produces more typos than 'average' (~3%)."""
        random.seed(42)
        text = 'the quick brown fox jumps over' * 5
        low_actions = typo_generator(text, accuracy='low')
        random.seed(42)
        avg_actions = typo_generator(text, accuracy='average')

        low_typos = sum(1 for a in low_actions if a['action'] == 'typo')
        avg_typos = sum(1 for a in avg_actions if a['action'] == 'typo')
        assert low_typos > avg_typos

    def test_typo_action_structure(self) -> None:
        """Typo actions have 'wrong' and 'correct' fields."""
        random.seed(42)
        # Force a typo by using low accuracy on a long string
        actions = typo_generator('a' * 200, accuracy='low')
        typos = [a for a in actions if a['action'] == 'typo']
        assert len(typos) > 0
        for t in typos:
            assert 'wrong' in t
            assert 'correct' in t
            assert t['wrong'] != t['correct']

    def test_typo_uses_adjacent_key(self) -> None:
        """Wrong characters should be adjacent on QWERTY layout."""
        random.seed(42)
        # Use 'f' which has known adjacent keys: d, r, t, g, c, v
        actions = typo_generator('f' * 500, accuracy='low')
        typos = [a for a in actions if a['action'] == 'typo']
        assert len(typos) > 0
        for t in typos:
            assert t['wrong'] in ADJACENT_KEYS['f']

    def test_empty_string(self) -> None:
        actions = typo_generator('', accuracy='average')
        assert actions == []

    def test_special_chars_no_adjacency(self) -> None:
        """Characters without QWERTY adjacency produce no typos (returned as-is)."""
        random.seed(42)
        # '@' is not in ADJACENT_KEYS, so even if the random roll triggers a typo,
        # _adjacent_key returns the same char and the typo is suppressed
        actions = typo_generator('@@@', accuracy='low')
        for a in actions:
            assert a['action'] == 'type'


# ---------------------------------------------------------------------------
# ADJACENT_KEYS coverage
# ---------------------------------------------------------------------------


class TestAdjacentKeys:
    """Verify the QWERTY adjacency map is sane."""

    def test_all_lowercase_letters(self) -> None:
        """All a-z should be in the map."""
        for c in 'abcdefghijklmnopqrstuvwxyz':
            assert c in ADJACENT_KEYS

    def test_digits(self) -> None:
        """Digits 0-9 should be in the map."""
        for c in '0123456789':
            assert c in ADJACENT_KEYS

    def test_adjacency_is_symmetric_for_letters(self) -> None:
        """If 'a' lists 'w' as adjacent, 'w' should list 'a' (letter-to-letter only).

        Digit-to-letter adjacency is intentionally asymmetric (e.g., '1' lists
        'q' as adjacent but 'q' does not list '1' because digits are rarely
        reached from letter keys).
        """
        letters = set('abcdefghijklmnopqrstuvwxyz')
        for key in letters:
            for neighbor in ADJACENT_KEYS.get(key, []):
                if neighbor in letters:
                    assert key in ADJACENT_KEYS[neighbor], (
                        f'{key} -> {neighbor} but {neighbor} does not list {key}'
                    )


