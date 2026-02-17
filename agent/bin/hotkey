#!/usr/bin/env python3
"""Press a key combination (e.g. cmd a, cmd shift 3)."""

import argparse
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))

from agent.input import keyboard

# Map common shorthand to pyautogui key names
KEY_ALIASES = {
    'cmd': 'command',
    'ctrl': 'ctrl',
    'alt': 'option',
    'opt': 'option',
    'shift': 'shift',
    'super': 'command',
    'win': 'command',
}


def main():
    parser = argparse.ArgumentParser(description='Press a key combination')
    parser.add_argument('keys', nargs='+', help='Keys to press (e.g. cmd a, cmd shift 3)')

    args = parser.parse_args()

    # Resolve aliases
    resolved = []
    for k in args.keys:
        resolved.append(KEY_ALIASES.get(k.lower(), k.lower()))

    keyboard.hotkey(*resolved)


if __name__ == '__main__':
    main()
