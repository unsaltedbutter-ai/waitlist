#!/usr/bin/env python3
"""Capture a window screenshot.

Defaults to the Chrome window. Saves PNG to /tmp and prints the path.

Options:
    --app       Target a different app (default: Google Chrome)
    --output    Custom output path
    --base64    Print base64 to stdout instead of saving a file
"""

import argparse
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))


def main():
    parser = argparse.ArgumentParser(description='Capture a window screenshot')
    parser.add_argument('--app', default='Google Chrome', help='App name to capture (default: Google Chrome)')
    parser.add_argument('--output', default=None, help='Output file path (default: /tmp/ub-screenshot-<ts>.png)')
    parser.add_argument('--base64', action='store_true', help='Print base64 to stdout')

    args = parser.parse_args()

    from agent.input import window as win_module
    from agent import screenshot

    win = win_module.get_window_bounds(args.app)
    if win is None:
        print(f'No visible window found for {args.app}')
        sys.exit(1)

    window_id = win['id']

    if args.base64:
        data = screenshot.capture_to_base64(window_id)
        sys.stdout.write(data)
    else:
        path = screenshot.capture_window(window_id, args.output)
        print(path)


if __name__ == '__main__':
    main()
