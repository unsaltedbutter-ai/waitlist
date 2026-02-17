"""
Human-like keyboard operations.

Typing with natural timing, optional typos with backspace correction.
"""

import random
import time

import pyautogui

from . import humanize

# Safety: we handle timing ourselves
pyautogui.PAUSE = 0


def type_text(
    text: str,
    speed: str = 'medium',
    accuracy: str = 'high',
) -> None:
    """
    Type text with human-like timing.

    speed: 'instant' (no delay, for setup), 'fast' (~60ms avg),
           'medium' (~120ms avg), 'slow' (~200ms avg)
    accuracy: 'high' (no typos), 'average' (~3% typo rate), 'low' (~8% typo rate)
    """
    # Instant mode: fire keys as fast as possible, no humanization
    if speed == 'instant':
        for char in text:
            _type_char(char)
        return

    actions = humanize.typo_generator(text, accuracy=accuracy)
    prev_char = ''

    for action in actions:
        if action['action'] == 'type':
            char = action['char']
            delay = humanize.typing_delay(speed, char, prev_char)
            time.sleep(delay)
            _type_char(char)
            prev_char = char

        elif action['action'] == 'typo':
            wrong = action['wrong']
            correct = action['correct']

            # Type the wrong character
            delay = humanize.typing_delay(speed, wrong, prev_char)
            time.sleep(delay)
            _type_char(wrong)

            # Pause (noticing the mistake): 200-500ms
            time.sleep(random.uniform(0.2, 0.5))

            # Backspace
            _press_key_raw('backspace')
            time.sleep(random.uniform(0.05, 0.15))

            # Type the correct character
            _type_char(correct)
            prev_char = correct


def press_key(key: str) -> None:
    """
    Single key press with natural press/release timing.
    Accepts pyautogui key names: 'enter', 'tab', 'escape', 'space', etc.
    """
    hold_time = random.uniform(0.06, 0.14)
    pyautogui.keyDown(key, _pause=False)
    time.sleep(hold_time)
    pyautogui.keyUp(key, _pause=False)


def hotkey(*keys: str) -> None:
    """
    Key combination with natural sequential press timing.
    e.g. hotkey('command', 'a') for select-all.

    Keys are pressed in order with small delays, then released in reverse.
    """
    for key in keys:
        pyautogui.keyDown(key, _pause=False)
        time.sleep(random.uniform(0.03, 0.08))

    time.sleep(random.uniform(0.05, 0.12))

    for key in reversed(keys):
        pyautogui.keyUp(key, _pause=False)
        time.sleep(random.uniform(0.02, 0.06))


def _type_char(char: str) -> None:
    """Type a single character with natural press/release."""
    hold_time = random.uniform(0.04, 0.10)
    pyautogui.keyDown(char, _pause=False)
    time.sleep(hold_time)
    pyautogui.keyUp(char, _pause=False)


def _press_key_raw(key: str) -> None:
    """Internal: press a key without the public API's timing."""
    pyautogui.keyDown(key, _pause=False)
    time.sleep(random.uniform(0.04, 0.08))
    pyautogui.keyUp(key, _pause=False)
