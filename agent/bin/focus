#!/usr/bin/env python3
"""Bring an app to the foreground."""

import argparse
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))

from agent.input import window


def main():
    parser = argparse.ArgumentParser(description='Focus an application window')
    parser.add_argument('app', help='App name (e.g. "Google Chrome")')

    args = parser.parse_args()
    if window.focus_window(args.app):
        print(f"Focused: {args.app}")
    else:
        print(f"App not found: {args.app}")
        sys.exit(1)


if __name__ == '__main__':
    main()
