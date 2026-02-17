#!/usr/bin/env python3
"""Press a single key."""

import argparse
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))

from agent.input import keyboard


def main():
    parser = argparse.ArgumentParser(description='Press a single key')
    parser.add_argument('key', help='Key name (enter, tab, escape, space, etc.)')

    args = parser.parse_args()
    keyboard.press_key(args.key)


if __name__ == '__main__':
    main()
