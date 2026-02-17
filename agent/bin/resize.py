#!/usr/bin/env python3
"""Resize a window by dragging its corner (human-like, not programmatic)."""

import argparse
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))

from agent.input import window


def main():
    parser = argparse.ArgumentParser(description='Resize a window by dragging')
    parser.add_argument('app', help='App name (e.g. "Google Chrome")')
    parser.add_argument('width', type=int, help='Target width in screen points')
    parser.add_argument('height', type=int, help='Target height in screen points')

    args = parser.parse_args()
    if window.resize_window_by_drag(args.app, args.width, args.height):
        print(f"Resized {args.app} to {args.width}x{args.height}")
    else:
        print(f"Window not found: {args.app}")
        sys.exit(1)


if __name__ == '__main__':
    main()
