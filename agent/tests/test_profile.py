"""Tests for HumanProfile presets and value ranges.

Run: cd agent && python -m pytest tests/test_profile.py -v
"""

from __future__ import annotations

from dataclasses import FrozenInstanceError

import pytest

from agent.profile import CAUTIOUS, FAST, NORMAL, PROFILES, HumanProfile


class TestHumanProfilePresets:
    """Validate preset profiles have sane values."""

    def test_fast_preset(self) -> None:
        assert FAST.mouse_fast is True
        assert FAST.type_speed == 'fast'
        assert FAST.type_accuracy == 'high'
        lo, hi = FAST.decision_delay
        assert lo < hi
        assert hi <= 0.5  # fast mode should have very short delays

    def test_normal_preset(self) -> None:
        assert NORMAL.mouse_fast is False
        assert NORMAL.type_speed == 'medium'
        assert NORMAL.type_accuracy == 'high'
        lo, hi = NORMAL.decision_delay
        assert lo < hi
        assert lo >= 0.3

    def test_cautious_preset(self) -> None:
        assert CAUTIOUS.mouse_fast is False
        assert CAUTIOUS.type_speed == 'slow'
        assert CAUTIOUS.type_accuracy == 'average'
        lo, hi = CAUTIOUS.decision_delay
        assert lo >= 1.0
        assert hi >= 2.0

    def test_profiles_dict(self) -> None:
        """PROFILES dict maps names to the correct presets."""
        assert PROFILES['fast'] is FAST
        assert PROFILES['normal'] is NORMAL
        assert PROFILES['cautious'] is CAUTIOUS
        assert len(PROFILES) == 3

    def test_decision_delays_are_ordered(self) -> None:
        """For every preset, lo <= hi in decision_delay."""
        for name, profile in PROFILES.items():
            lo, hi = profile.decision_delay
            assert lo <= hi, f'{name}: lo={lo} > hi={hi}'

    def test_frozen(self) -> None:
        """Presets are frozen dataclasses (immutable)."""
        with pytest.raises(FrozenInstanceError):
            NORMAL.mouse_fast = True  # type: ignore[misc]

    def test_custom_profile(self) -> None:
        """Custom HumanProfile can be created with arbitrary values."""
        custom = HumanProfile(
            mouse_fast=True,
            type_speed='slow',
            type_accuracy='low',
            decision_delay=(0.0, 0.0),
        )
        assert custom.mouse_fast is True
        assert custom.type_speed == 'slow'
        assert custom.decision_delay == (0.0, 0.0)

    def test_default_profile(self) -> None:
        """Default HumanProfile (no args) matches documented defaults."""
        default = HumanProfile()
        assert default.mouse_fast is False
        assert default.type_speed == 'medium'
        assert default.type_accuracy == 'high'
        assert default.decision_delay == (0.5, 1.5)

    def test_type_speed_values(self) -> None:
        """All presets use valid type_speed values."""
        valid_speeds = {'instant', 'fast', 'medium', 'slow'}
        for name, profile in PROFILES.items():
            assert profile.type_speed in valid_speeds, (
                f'{name} has invalid type_speed: {profile.type_speed}'
            )

    def test_type_accuracy_values(self) -> None:
        """All presets use valid type_accuracy values."""
        valid_accuracy = {'high', 'average', 'low'}
        for name, profile in PROFILES.items():
            assert profile.type_accuracy in valid_accuracy, (
                f'{name} has invalid type_accuracy: {profile.type_accuracy}'
            )
