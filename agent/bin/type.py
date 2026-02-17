#!/usr/bin/env python3
"""Type text with human-like timing and optional typos."""

import argparse
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))

from agent.input import keyboard


def main():
    parser = argparse.ArgumentParser(description='Human-like text typing')
    parser.add_argument('text', help='Text to type')
    parser.add_argument(
        '--speed', choices=['fast', 'medium', 'slow'], default='medium',
        help='Typing speed (default: medium)',
    )
    parser.add_argument(
        '--accuracy', choices=['high', 'average', 'low'], default='high',
        help='Typing accuracy (default: high, no typos)',
    )

    args = parser.parse_args()
    keyboard.type_text(args.text, speed=args.speed, accuracy=args.accuracy)


if __name__ == '__main__':
    main()
