#!/usr/bin/env python3
"""List visible windows with IDs and bounds."""

import argparse
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))

from agent.input import window


def main():
    parser = argparse.ArgumentParser(description='List visible windows')
    parser.add_argument('app', nargs='?', default=None, help='Filter by app name (substring match)')

    args = parser.parse_args()
    windows = window.list_windows(args.app)

    if not windows:
        name = args.app or 'any app'
        print(f"No windows found for {name}")
        return

    for win in windows:
        print(f"[{win['id']}] {win['app']} - {win['title']}")
        print(f"     ({win['x']}, {win['y']}) {win['width']}x{win['height']}")


if __name__ == '__main__':
    main()
