#!/usr/bin/env python3
"""Click at current position or specified coordinates."""

import argparse
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))

from agent.input import mouse


def main():
    parser = argparse.ArgumentParser(description='Human-like mouse click')
    parser.add_argument('x', type=int, nargs='?', default=None, help='X coordinate (optional)')
    parser.add_argument('y', type=int, nargs='?', default=None, help='Y coordinate (optional)')
    parser.add_argument('--double', action='store_true', help='Double click')
    parser.add_argument('--right', action='store_true', help='Right click')
    parser.add_argument('--fast', action='store_true', help='Same arc, ~3x faster')

    args = parser.parse_args()

    if args.double:
        mouse.double_click(args.x, args.y)
    elif args.right:
        mouse.right_click(args.x, args.y)
    else:
        mouse.click(args.x, args.y, fast=args.fast)


if __name__ == '__main__':
    main()
