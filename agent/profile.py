"""Human behavioral profile: consolidated parameters that make the agent look human.

Bundles mouse speed, typing speed, typing accuracy, and decision delay
into a single object. Presets available for testing (fast) and production (normal, cautious).
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class HumanProfile:
    """All behavioral parameters for human-like interaction."""

    mouse_fast: bool = False
    type_speed: str = 'medium'                      # instant, fast, medium, slow
    type_accuracy: str = 'high'                      # high, average, low
    decision_delay: tuple[float, float] = (0.5, 1.5) # pause before interactive actions (seconds)


# -- Presets ----------------------------------------------------------------

FAST = HumanProfile(
    mouse_fast=True,
    type_speed='fast',
    type_accuracy='high',
    decision_delay=(0.0, 0.1),
)

NORMAL = HumanProfile(
    mouse_fast=False,
    type_speed='medium',
    type_accuracy='high',
    decision_delay=(0.5, 1.5),
)

CAUTIOUS = HumanProfile(
    mouse_fast=False,
    type_speed='slow',
    type_accuracy='average',
    decision_delay=(1.0, 3.0),
)

PROFILES = {
    'fast': FAST,
    'normal': NORMAL,
    'cautious': CAUTIOUS,
}
