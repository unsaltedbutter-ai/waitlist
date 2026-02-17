#!/usr/bin/env python3
"""Chrome browser lifecycle CLI.

Commands:
    open      Launch Chrome with a fresh temp profile
    close     Kill Chrome and delete the profile
    navigate  Navigate to a URL
    status    Print window ID, bounds, profile dir

Session state is persisted in /tmp/ub-chrome-session.json so
sequential CLI calls share the same Chrome instance.
"""

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))

SESSION_FILE = '/tmp/ub-chrome-session.json'


def _save_session(session):
    """Persist session state to disk."""
    from agent import browser
    data = {
        'pid': session.pid,
        'profile_dir': session.profile_dir,
        'window_id': session.window_id,
        'bounds': session.bounds,
    }
    with open(SESSION_FILE, 'w') as f:
        json.dump(data, f, indent=2)


def _load_session():
    """Restore a BrowserSession from disk."""
    from agent.browser import BrowserSession

    if not os.path.exists(SESSION_FILE):
        print('No active session. Run: chrome open')
        sys.exit(1)

    with open(SESSION_FILE) as f:
        data = json.load(f)

    pid = data['pid']

    # Verify the process is still alive
    try:
        os.kill(pid, 0)
    except OSError:
        print(f'Chrome process {pid} is dead. Cleaning up stale session.')
        os.unlink(SESSION_FILE)
        sys.exit(1)

    return BrowserSession(
        pid=pid,
        process=None,
        profile_dir=data['profile_dir'],
        window_id=data.get('window_id', 0),
        bounds=data.get('bounds', {}),
    )


def cmd_open(args):
    from agent import browser

    if os.path.exists(SESSION_FILE):
        print('Session already exists. Run: chrome close')
        sys.exit(1)

    print(f'Launching Chrome ({args.width}x{args.height})...')
    session = browser.create_session(width=args.width, height=args.height)
    _save_session(session)

    print(f'PID:     {session.pid}')
    print(f'Window:  {session.window_id}')
    print(f'Bounds:  {session.bounds}')
    print(f'Profile: {session.profile_dir}')


def cmd_close(args):
    from agent import browser

    session = _load_session()
    print(f'Closing Chrome (PID {session.pid})...')

    browser.close_session(session)

    if os.path.exists(SESSION_FILE):
        os.unlink(SESSION_FILE)

    print('Session closed. Profile deleted.')


def cmd_navigate(args):
    from agent import browser

    session = _load_session()
    print(f'Navigating to {args.url}...')
    browser.navigate(session, args.url)
    print('Done.')


def cmd_status(args):
    from agent import browser

    session = _load_session()

    # Refresh bounds from the window manager
    try:
        browser.get_session_window(session)
        _save_session(session)
    except RuntimeError:
        pass

    print(f'PID:     {session.pid}')
    print(f'Window:  {session.window_id}')
    print(f'Bounds:  {session.bounds}')
    print(f'Profile: {session.profile_dir}')


def main():
    parser = argparse.ArgumentParser(description='Chrome browser lifecycle')
    sub = parser.add_subparsers(dest='command')

    p_open = sub.add_parser('open', help='Launch Chrome with fresh profile')
    p_open.add_argument('--width', type=int, default=1280)
    p_open.add_argument('--height', type=int, default=900)

    sub.add_parser('close', help='Kill Chrome, delete profile')

    p_nav = sub.add_parser('navigate', help='Navigate to a URL')
    p_nav.add_argument('url', help='URL to navigate to')

    sub.add_parser('status', help='Print session info')

    args = parser.parse_args()

    if args.command is None:
        parser.print_help()
        sys.exit(1)

    dispatch = {
        'open': cmd_open,
        'close': cmd_close,
        'navigate': cmd_navigate,
        'status': cmd_status,
    }
    dispatch[args.command](args)


if __name__ == '__main__':
    main()
