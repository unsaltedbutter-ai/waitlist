#!/usr/bin/env python3
"""Print current mouse position and window under cursor."""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))

import pyautogui
from agent.input import window


def main():
    x, y = pyautogui.position()
    print(f"Mouse: ({x}, {y})")

    # Find which window is under the cursor
    windows = window.list_windows()
    for win in windows:
        wx, wy = win['x'], win['y']
        ww, wh = win['width'], win['height']
        if wx <= x <= wx + ww and wy <= y <= wy + wh:
            print(f"Window: {win['app']} - {win['title']}")
            print(f"  Bounds: ({wx}, {wy}) {ww}x{wh}")
            print(f"  ID: {win['id']}")
            break
    else:
        print("Window: (none detected)")


if __name__ == '__main__':
    main()
