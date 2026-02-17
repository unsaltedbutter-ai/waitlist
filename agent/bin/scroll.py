#!/usr/bin/env python3
"""Scroll up or down with human-like timing."""

import argparse
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))

from agent.input import scroll as scroll_mod


def main():
    parser = argparse.ArgumentParser(description='Human-like scrolling')
    parser.add_argument('direction', choices=['up', 'down'], help='Scroll direction')
    parser.add_argument('amount', type=int, nargs='?', default=3, help='Number of scroll clicks (default: 3)')
    parser.add_argument('--at', nargs=2, type=int, metavar=('X', 'Y'), help='Move mouse here first')

    args = parser.parse_args()

    x, y = (None, None)
    if args.at:
        x, y = args.at

    scroll_mod.scroll(args.direction, args.amount, x=x, y=y)


if __name__ == '__main__':
    main()
