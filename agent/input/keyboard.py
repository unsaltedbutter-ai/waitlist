"""
Human-like keyboard operations via Quartz CGEvents.

Typing with natural timing, optional typos with backspace correction.
Uses CGEventCreateKeyboardEvent directly (works reliably from LaunchAgents).
"""

import random
import time

import Quartz

from . import humanize

# macOS virtual keycodes for common keys
_KEYCODES: dict[str, int] = {
    'a': 0x00, 's': 0x01, 'd': 0x02, 'f': 0x03, 'h': 0x04, 'g': 0x05,
    'z': 0x06, 'x': 0x07, 'c': 0x08, 'v': 0x09, 'b': 0x0B, 'q': 0x0C,
    'w': 0x0D, 'e': 0x0E, 'r': 0x0F, 'y': 0x10, 't': 0x11, '1': 0x12,
    '2': 0x13, '3': 0x14, '4': 0x15, '6': 0x16, '5': 0x17, '=': 0x18,
    '9': 0x19, '7': 0x1A, '-': 0x1B, '8': 0x1C, '0': 0x1D, ']': 0x1E,
    'o': 0x1F, 'u': 0x20, '[': 0x21, 'i': 0x22, 'p': 0x23, 'l': 0x25,
    'j': 0x26, "'": 0x27, 'k': 0x28, ';': 0x29, '\\': 0x2A, ',': 0x2B,
    '/': 0x2C, 'n': 0x2D, 'm': 0x2E, '.': 0x2F, '`': 0x32, ' ': 0x31,
    'return': 0x24, 'enter': 0x24, 'tab': 0x30, 'space': 0x31,
    'backspace': 0x33, 'delete': 0x33, 'escape': 0x35, 'esc': 0x35,
    'command': 0x37, 'shift': 0x38, 'capslock': 0x39, 'option': 0x3A,
    'alt': 0x3A, 'control': 0x3B, 'ctrl': 0x3B,
    'right_shift': 0x3C, 'right_option': 0x3D, 'right_control': 0x3E,
    'fn': 0x3F,
    'f1': 0x7A, 'f2': 0x78, 'f3': 0x63, 'f4': 0x76, 'f5': 0x60,
    'f6': 0x61, 'f7': 0x62, 'f8': 0x64, 'f9': 0x65, 'f10': 0x6D,
    'f11': 0x67, 'f12': 0x6F,
    'left': 0x7B, 'right': 0x7C, 'down': 0x7D, 'up': 0x7E,
    'home': 0x73, 'end': 0x77, 'pageup': 0x74, 'pagedown': 0x79,
}

# Characters that require shift
_SHIFT_CHARS: dict[str, str] = {
    '!': '1', '@': '2', '#': '3', '$': '4', '%': '5', '^': '6',
    '&': '7', '*': '8', '(': '9', ')': '0', '_': '-', '+': '=',
    '{': '[', '}': ']', '|': '\\', ':': ';', '"': "'", '<': ',',
    '>': '.', '?': '/', '~': '`',
}

# CGEvent flag for Command key
_kCGEventFlagCommand = 0x100000
_kCGEventFlagShift = 0x20000


def _key_down(keycode: int, flags: int = 0) -> None:
    """Post a key-down CGEvent."""
    event = Quartz.CGEventCreateKeyboardEvent(None, keycode, True)
    Quartz.CGEventSetFlags(event, flags)
    Quartz.CGEventPost(Quartz.kCGHIDEventTap, event)


def _key_up(keycode: int, flags: int = 0) -> None:
    """Post a key-up CGEvent."""
    event = Quartz.CGEventCreateKeyboardEvent(None, keycode, False)
    Quartz.CGEventSetFlags(event, flags)
    Quartz.CGEventPost(Quartz.kCGHIDEventTap, event)


def _resolve_keycode(key: str) -> int:
    """Resolve a key name or character to a macOS virtual keycode."""
    lower = key.lower()
    if lower in _KEYCODES:
        return _KEYCODES[lower]
    raise ValueError(f"Unknown key: {key!r}")


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
    Accepts key names: 'enter', 'tab', 'escape', 'space', etc.
    """
    keycode = _resolve_keycode(key)
    hold_time = random.uniform(0.06, 0.14)
    _key_down(keycode)
    time.sleep(hold_time)
    _key_up(keycode)


def hotkey(*keys: str) -> None:
    """
    Key combination with natural sequential press timing.
    e.g. hotkey('command', 'a') for select-all.

    Keys are pressed in order with small delays, then released in reverse.
    Modifier flags are accumulated so the OS sees them correctly.
    """
    # Build cumulative modifier flags
    modifier_flag_map = {
        'command': _kCGEventFlagCommand,
        'shift': _kCGEventFlagShift,
    }
    flags = 0
    keycodes = []
    for key in keys:
        keycode = _resolve_keycode(key)
        lower = key.lower()
        if lower in modifier_flag_map:
            flags |= modifier_flag_map[lower]
        keycodes.append((keycode, lower))

    # Press in order
    cumulative = 0
    for keycode, lower in keycodes:
        if lower in modifier_flag_map:
            cumulative |= modifier_flag_map[lower]
        _key_down(keycode, flags=cumulative)
        time.sleep(random.uniform(0.03, 0.08))

    time.sleep(random.uniform(0.05, 0.12))

    # Release in reverse, removing modifier flags before each modifier release
    remaining = flags
    for keycode, lower in reversed(keycodes):
        if lower in modifier_flag_map:
            remaining &= ~modifier_flag_map[lower]
        _key_up(keycode, flags=remaining)
        time.sleep(random.uniform(0.02, 0.06))


def _type_char(char: str) -> None:
    """Type a single character with natural press/release."""
    hold_time = random.uniform(0.04, 0.10)

    # Uppercase letter
    if char.isupper() and char.lower() in _KEYCODES:
        keycode = _KEYCODES[char.lower()]
        _key_down(_KEYCODES['shift'])
        time.sleep(random.uniform(0.02, 0.05))
        _key_down(keycode, flags=_kCGEventFlagShift)
        time.sleep(hold_time)
        _key_up(keycode, flags=_kCGEventFlagShift)
        time.sleep(random.uniform(0.02, 0.05))
        _key_up(_KEYCODES['shift'])
        return

    # Shifted symbol
    if char in _SHIFT_CHARS:
        base = _SHIFT_CHARS[char]
        keycode = _KEYCODES[base]
        _key_down(_KEYCODES['shift'])
        time.sleep(random.uniform(0.02, 0.05))
        _key_down(keycode, flags=_kCGEventFlagShift)
        time.sleep(hold_time)
        _key_up(keycode, flags=_kCGEventFlagShift)
        time.sleep(random.uniform(0.02, 0.05))
        _key_up(_KEYCODES['shift'])
        return

    # Normal character
    lower = char.lower()
    if lower in _KEYCODES:
        keycode = _KEYCODES[lower]
        _key_down(keycode)
        time.sleep(hold_time)
        _key_up(keycode)
        return

    # Fallback: use CGEvent with Unicode string
    # For characters not in our keycode map (accented, emoji, etc.)
    event = Quartz.CGEventCreateKeyboardEvent(None, 0, True)
    Quartz.CGEventKeyboardSetUnicodeString(
        event, len(char), char,
    )
    Quartz.CGEventPost(Quartz.kCGHIDEventTap, event)
    time.sleep(hold_time)
    event_up = Quartz.CGEventCreateKeyboardEvent(None, 0, False)
    Quartz.CGEventPost(Quartz.kCGHIDEventTap, event_up)


def _press_key_raw(key: str) -> None:
    """Internal: press a key without the public API's timing."""
    keycode = _resolve_keycode(key)
    _key_down(keycode)
    time.sleep(random.uniform(0.04, 0.08))
    _key_up(keycode)
