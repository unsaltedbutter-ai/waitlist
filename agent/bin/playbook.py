#!/usr/bin/env python3
"""Playbook CLI: record, test, and list playbook files.

Commands:
    record  --service <s> --flow <f> [--tier <t>]   Record steps by dwell-detection
    test    --service <s> --flow <f> [--tier <t>]   Interactive dry-run
    list                                             Table of all playbooks
"""

import argparse
import json
import math
import os
import random
import select
import subprocess
import sys
import threading
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))

SESSION_FILE = '/tmp/ub-chrome-session.json'

DWELL_PROMPT = '  tl | br | center | type | sleep | scroll | skip | done'


# ------------------------------------------------------------------
# Shared helpers
# ------------------------------------------------------------------

def _load_chrome_session():
    """Load an existing Chrome session from the session file."""
    from agent.browser import BrowserSession

    if not os.path.exists(SESSION_FILE):
        return None

    with open(SESSION_FILE) as f:
        data = json.load(f)

    pid = data['pid']
    try:
        os.kill(pid, 0)
    except OSError:
        return None

    return BrowserSession(
        pid=pid,
        process=None,
        profile_dir=data['profile_dir'],
        window_id=data.get('window_id', 0),
        bounds=data.get('bounds', {}),
    )


def _save_chrome_session(session):
    """Save session state for other CLI tools."""
    data = {
        'pid': session.pid,
        'profile_dir': session.profile_dir,
        'window_id': session.window_id,
        'bounds': session.bounds,
    }
    with open(SESSION_FILE, 'w') as f:
        json.dump(data, f, indent=2)


def _play_sound():
    """Play macOS system sound to indicate a dwell was detected."""
    try:
        subprocess.Popen(
            ['afplay', '/System/Library/Sounds/Tink.aiff'],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except OSError:
        pass


def _focus_chrome(pid=None):
    """Bring Chrome to front, scoped to PID when available."""
    from agent.input import window as win_mod
    if pid is not None:
        win_mod.focus_window_by_pid(pid)
    else:
        win_mod.focus_window('Google Chrome')
    time.sleep(0.3)


def _play_error_sound():
    """Play macOS error sound for unrecognized input."""
    try:
        subprocess.Popen(
            ['afplay', '/System/Library/Sounds/Basso.aiff'],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except OSError:
        pass


def _execute_scroll(direction, amount, pid=None):
    """Focus Chrome and scroll so the user can see the effect."""
    from agent.input import scroll as scroll_mod
    _focus_chrome(pid=pid)
    scroll_mod.scroll(direction, amount)


def _playbook_filename(service, flow, tier):
    """Build the playbook filename stem."""
    name = f'{service}_{flow}'
    if tier:
        name += f'_{tier}'
    return name


# ------------------------------------------------------------------
# Dwell detector
# ------------------------------------------------------------------

class DwellDetector:
    """Monitor mouse position at 10Hz, detect dwells (stationary for threshold seconds)."""

    def __init__(self, threshold_sec: float = 3.0, radius_px: float = 5.0):
        self.threshold = threshold_sec
        self.radius = radius_px
        self._lock = threading.Lock()
        self._dwell_position: tuple[int, int] | None = None
        self._running = False
        self._thread: threading.Thread | None = None

    def start(self):
        self._running = True
        self._thread = threading.Thread(target=self._poll_loop, daemon=True)
        self._thread.start()

    def stop(self):
        self._running = False
        if self._thread:
            self._thread.join(timeout=2.0)

    def pop_dwell(self) -> tuple[int, int] | None:
        """Return and clear the last dwell position, or None."""
        with self._lock:
            pos = self._dwell_position
            self._dwell_position = None
            return pos

    def _poll_loop(self):
        import Quartz

        anchor_x, anchor_y = 0, 0
        anchor_time = time.monotonic()
        fired = False

        while self._running:
            event = Quartz.CGEventCreate(None)
            point = Quartz.CGEventGetLocation(event)
            mx, my = int(point.x), int(point.y)

            dist = math.hypot(mx - anchor_x, my - anchor_y)
            if dist > self.radius:
                anchor_x, anchor_y = mx, my
                anchor_time = time.monotonic()
                fired = False
            elif not fired and (time.monotonic() - anchor_time) >= self.threshold:
                with self._lock:
                    self._dwell_position = (mx, my)
                fired = True

            time.sleep(0.1)


# ------------------------------------------------------------------
# record command
# ------------------------------------------------------------------

def cmd_record(args):
    from agent import browser, screenshot as ss
    from agent.config import (
        PLAYBOOK_DIR,
        PLAYBOOK_REF_DIR,
        RECORD_DWELL_RADIUS_PX,
        RECORD_DWELL_THRESHOLD_SEC,
        VARS_HINT,
    )
    from agent.input import coords

    service = args.service
    flow = args.flow
    tier = args.tier or ''
    pb_name = _playbook_filename(service, flow, tier)

    # Attach to existing Chrome session or open a new one
    session = _load_chrome_session()
    own_session = False
    if session is None:
        print('No active Chrome session. Launching one...')
        session = browser.create_session()
        _save_chrome_session(session)
        own_session = True
        print(f'Chrome launched (PID {session.pid})')
    else:
        browser.get_session_window(session)
        print(f'Attached to Chrome (PID {session.pid})')

    # Ref screenshot dir
    ref_dir = PLAYBOOK_REF_DIR / pb_name
    ref_dir.mkdir(parents=True, exist_ok=True)

    # Prompt for starting URL
    print()
    print(f'Recording: {pb_name}')
    start_url = input('Starting URL: ').strip()

    steps = []
    stashed_tl: tuple[int, int] | None = None

    if start_url:
        steps.append({'action': 'navigate', 'url': start_url})
        print(f'  -> Step 0: navigate "{start_url}"')

    # Start dwell detector
    detector = DwellDetector(
        threshold_sec=RECORD_DWELL_THRESHOLD_SEC,
        radius_px=RECORD_DWELL_RADIUS_PX,
    )
    detector.start()

    print('Hover over elements for 3+ seconds to mark them.')
    print('Type "manual" for navigate/scroll/press_key without dwell.')
    print('Type "done" to finish.')
    print()

    # -- helper functions (closures over steps, session, etc.) --

    def _step_idx():
        """Next step index (0-based)."""
        return len(steps)

    def _make_region_center(img_x, img_y):
        return [int(img_x) - 5, int(img_y) - 5, int(img_x) + 5, int(img_y) + 5]

    def _make_region_corners(tl_img, br_img):
        return [int(tl_img[0]), int(tl_img[1]), int(br_img[0]), int(br_img[1])]

    def _save_ref():
        ref_path = ref_dir / f'step_{_step_idx():02d}.png'
        ss.capture_window(session.window_id, str(ref_path))
        return ref_path

    def _prompt_type_value():
        print(f'  type? ({VARS_HINT})')
        raw = input('  > ').strip()
        if not raw:
            return None, False
        sens = input('  sensitive? (y/n) [n]: ').strip().lower() == 'y'
        return raw, sens

    def _add_click(region, desc, checkpoint=False, cp_prompt=''):
        idx = _step_idx()
        step = {
            'action': 'click',
            'target_description': desc,
            'ref_region': region,
        }
        if checkpoint:
            step['checkpoint'] = True
            step['checkpoint_prompt'] = cp_prompt
        steps.append(step)
        print(f'  -> Step {idx}: click "{desc}" region={region}')

    def _add_type(value, sensitive):
        from agent.playbook import parse_value_and_keys
        clean_value, trailing_keys = parse_value_and_keys(value)

        if clean_value:
            idx = _step_idx()
            step = {'action': 'type_text', 'value': clean_value}
            if sensitive:
                step['sensitive'] = True
            steps.append(step)
            print(f'  -> Step {idx}: type_text "{clean_value}"{"  [SENSITIVE]" if sensitive else ""}')

        for key in trailing_keys:
            idx = _step_idx()
            steps.append({'action': 'press_key', 'value': key})
            print(f'  -> Step {idx}: press_key "{key}"')

    def _add_sleep(lo, hi):
        idx = _step_idx()
        steps.append({
            'action': 'wait',
            'wait_after_sec': [lo, hi],
        })
        print(f'  -> Step {idx}: sleep [{lo}, {hi}]')

    def _parse_sleep_args(cmd_str):
        """Parse 'sleep 2,5' or 'sleep 1.5,3.5'. Returns (lo, hi) or None."""
        parts = cmd_str.split(None, 1)
        if len(parts) < 2:
            return None
        try:
            nums = parts[1].split(',')
            if len(nums) != 2:
                return None
            return float(nums[0].strip()), float(nums[1].strip())
        except ValueError:
            return None

    # -- dwell handler: loops for multiple commands per dwell --

    def _handle_dwell(screen_x, screen_y):
        """Process a dwell. Loops for multiple commands until empty Enter or tl."""
        nonlocal stashed_tl

        browser.get_session_window(session)
        img_x, img_y = coords.screen_to_image(screen_x, screen_y, session.bounds)

        print(f'[ding] Dwell at ({int(img_x)}, {int(img_y)}) window-relative')
        if stashed_tl is not None:
            print(f'  (top-left stashed at ({int(stashed_tl[0])}, {int(stashed_tl[1])}))')

        while True:
            print(DWELL_PROMPT)
            cmd = input(': ').strip().lower()

            # Empty line = done with this dwell, refocus Chrome
            if cmd == '':
                _focus_chrome(session.pid)
                return 'continue'

            if cmd == 'done':
                return 'done'

            if cmd == 'skip':
                _focus_chrome(session.pid)
                return 'continue'

            if cmd == 'tl':
                stashed_tl = (img_x, img_y)
                print(f'  Stashed top-left ({int(img_x)}, {int(img_y)}). Hover over bottom-right now.')
                _focus_chrome(session.pid)
                return 'continue'

            if cmd == 'br':
                if stashed_tl is None:
                    print('  No top-left stashed. Use "tl" first.')
                    continue
                region = _make_region_corners(stashed_tl, (img_x, img_y))
                stashed_tl = None
                _save_ref()
                desc = input('  desc> ').strip()
                if not desc:
                    print('  -> Skipped (no description)')
                    continue
                cp = input('  checkpoint? (y/n) [n]: ').strip().lower()
                cp_prompt = ''
                if cp == 'y':
                    cp_prompt = input('  checkpoint_prompt: ').strip()
                _add_click(region, desc, checkpoint=(cp == 'y'), cp_prompt=cp_prompt)
                value, sens = _prompt_type_value()
                if value:
                    _add_type(value, sens)
                continue  # stay in loop for more commands (e.g. sleep)

            if cmd == 'center':
                region = _make_region_center(img_x, img_y)
                stashed_tl = None
                _save_ref()
                desc = input('  desc> ').strip()
                if not desc:
                    print('  -> Skipped (no description)')
                    continue
                cp = input('  checkpoint? (y/n) [n]: ').strip().lower()
                cp_prompt = ''
                if cp == 'y':
                    cp_prompt = input('  checkpoint_prompt: ').strip()
                _add_click(region, desc, checkpoint=(cp == 'y'), cp_prompt=cp_prompt)
                value, sens = _prompt_type_value()
                if value:
                    _add_type(value, sens)
                continue

            if cmd == 'type':
                region = _make_region_center(img_x, img_y)
                stashed_tl = None
                _save_ref()
                desc = input('  desc> ').strip()
                if not desc:
                    print('  -> Skipped (no description)')
                    continue
                _add_click(region, desc)
                value, sens = _prompt_type_value()
                if value:
                    _add_type(value, sens)
                else:
                    print('  (no value entered, click-only)')
                continue

            if cmd.startswith('sleep'):
                parsed = _parse_sleep_args(cmd)
                if parsed is None:
                    print('  Usage: sleep min,max  (e.g. sleep 2,5 or sleep 1.5,3)')
                    continue
                _add_sleep(parsed[0], parsed[1])
                continue

            if cmd == 'scroll' or cmd.startswith('scroll '):
                parts = cmd.split()
                if len(parts) >= 3 and parts[2].isdigit():
                    # scroll down 5
                    direction = parts[1] if parts[1] in ('up', 'down') else 'down'
                    amount = int(parts[2])
                elif len(parts) >= 2 and parts[1] in ('up', 'down'):
                    # scroll down (prompt for amount only)
                    direction = parts[1]
                    amount_str = input('  amount [3]: ').strip() or '3'
                    amount = int(amount_str)
                else:
                    # bare scroll (prompt for both)
                    direction = input('  direction (up/down) [down]: ').strip().lower() or 'down'
                    amount_str = input('  amount [3]: ').strip() or '3'
                    amount = int(amount_str)
                print(f'  Scrolling {direction} {amount}...')
                _execute_scroll(direction, amount, pid=session.pid)
                ok = input('  Good? (y/n/redo) [y]: ').strip().lower()
                while ok == 'redo' or ok == 'n':
                    if ok == 'n':
                        amount_str = input('  new amount: ').strip()
                        amount = int(amount_str)
                    print(f'  Scrolling {direction} {amount}...')
                    _execute_scroll(direction, amount, pid=session.pid)
                    ok = input('  Good? (y/n/redo) [y]: ').strip().lower()
                _save_ref()
                idx = _step_idx()
                steps.append({
                    'action': 'scroll',
                    'target_description': f'{direction} {amount}',
                })
                print(f'  -> Step {idx}: scroll {direction} {amount}')
                continue

            _play_error_sound()
            print(f'  Unknown: "{cmd}"')
            continue

    # -- manual handler --

    def _handle_manual():
        print()
        cmd = input('manual> (navigate / scroll / sleep / press_key / done): ').strip().lower()

        if cmd == 'done':
            return 'done'

        if cmd == 'navigate':
            url = input('  url: ').strip()
            if url:
                idx = _step_idx()
                steps.append({'action': 'navigate', 'url': url})
                print(f'  -> Step {idx}: navigate "{url}"')
            _focus_chrome(session.pid)
            return 'continue'

        if cmd == 'scroll':
            direction = input('  direction (up/down) [down]: ').strip().lower() or 'down'
            amount_str = input('  amount [3]: ').strip() or '3'
            amount = int(amount_str)
            print(f'  Scrolling {direction} {amount}...')
            _execute_scroll(direction, amount, pid=session.pid)
            ok = input('  Good? (y/n/redo) [y]: ').strip().lower()
            while ok == 'redo' or ok == 'n':
                if ok == 'n':
                    amount_str = input('  new amount: ').strip()
                    amount = int(amount_str)
                print(f'  Scrolling {direction} {amount}...')
                _execute_scroll(direction, amount, pid=session.pid)
                ok = input('  Good? (y/n/redo) [y]: ').strip().lower()
            _save_ref()
            idx = _step_idx()
            steps.append({
                'action': 'scroll',
                'target_description': f'{direction} {amount}',
            })
            print(f'  -> Step {idx}: scroll {direction} {amount}')
            _focus_chrome(session.pid)
            return 'continue'

        if cmd == 'sleep' or cmd.startswith('sleep '):
            parsed = _parse_sleep_args(cmd) if ' ' in cmd else None
            if parsed is None:
                lo = input('  min seconds: ').strip()
                hi = input('  max seconds: ').strip()
                try:
                    parsed = (float(lo), float(hi))
                except ValueError:
                    print('  Invalid numbers.')
                    return 'continue'
            _add_sleep(parsed[0], parsed[1])
            return 'continue'

        if cmd == 'press_key':
            key = input('  key (enter, tab, escape, ...): ').strip()
            if key:
                idx = _step_idx()
                steps.append({'action': 'press_key', 'value': key})
                print(f'  -> Step {idx}: press_key "{key}"')
            return 'continue'

        _play_error_sound()
        print(f'  Unknown: "{cmd}"')
        return 'continue'

    # -- main recording loop --

    try:
        while True:
            dwell = detector.pop_dwell()

            if dwell is not None:
                _play_sound()
                result = _handle_dwell(dwell[0], dwell[1])
                if result == 'done':
                    break

            else:
                readable, _, _ = select.select([sys.stdin], [], [], 0.2)
                if readable:
                    line = sys.stdin.readline().strip().lower()
                    if line == 'done':
                        break
                    if line == 'manual':
                        result = _handle_manual()
                        if result == 'done':
                            break

    finally:
        detector.stop()

    if not steps:
        print('No steps recorded.')
        return

    playbook_data = {
        'service': service,
        'flow': flow,
        'version': 1,
        'notes': f'Recorded with playbook record on {time.strftime("%Y-%m-%d")}',
        'last_validated': None,
        'steps': steps,
    }
    if tier:
        playbook_data['tier'] = tier

    out_path = PLAYBOOK_DIR / f'{pb_name}.json'
    with open(out_path, 'w') as f:
        json.dump(playbook_data, f, indent=2)
        f.write('\n')

    print()
    print(f'Playbook written: {out_path}')
    print(f'Reference screenshots: {ref_dir}/')
    print(f'{len(steps)} steps recorded.')


# ------------------------------------------------------------------
# test command
# ------------------------------------------------------------------

def cmd_test(args):
    from agent.config import INFERENCE_URL
    from agent.executor import PlaybookExecutor
    from agent.inference import (
        CoordinateInferenceClient,
        HttpInferenceClient,
        MockInferenceClient,
    )
    from agent.playbook import JobContext, Playbook

    service = args.service
    flow = args.flow
    tier = args.tier or ''

    playbook = Playbook.load(service, flow, tier)
    pb_name = _playbook_filename(service, flow, tier)
    print(f'Loaded: {pb_name} v{playbook.version} ({len(playbook.steps)} steps)')
    print(f'Notes: {playbook.notes}')
    print()

    # Check if playbook has recorded coordinates
    has_coords = any(s.ref_region is not None for s in playbook.steps)

    # Select inference client
    if args.coords:
        print('Using CoordinateInferenceClient (recorded ref_region)')
        inference = CoordinateInferenceClient()
    elif args.mock:
        print('Using MockInferenceClient')
        inference = MockInferenceClient()
    else:
        studio_url = os.getenv('STUDIO_URL', INFERENCE_URL)
        try:
            import httpx
            httpx.get(f'{studio_url}/health', timeout=3.0)
            print(f'Using inference server: {studio_url}')
            inference = HttpInferenceClient(base_url=studio_url)
        except Exception:
            if has_coords:
                print(f'Inference server not reachable ({studio_url}), using recorded coordinates.')
                inference = CoordinateInferenceClient()
            else:
                print(f'Inference server not reachable ({studio_url}), using mock.')
                inference = MockInferenceClient()

    # Dummy job context with randomized email to avoid "welcome back" flows
    _words = ['apple', 'google', 'netflix', 'nvidia', 'amd', 'dolby',
              'coremedia', 'foundation', 'ios', 'chrome', 'safari',
              'firefox', 'android']
    word = random.choice(_words)
    u_suffix = random.randint(1000, 9999)
    d_suffix = random.randint(1000, 9999)
    test_email = f'{word}{u_suffix}@{word}{d_suffix}.com'

    ctx = JobContext(
        job_id='test-run',
        user_id='test-user',
        service=service,
        flow=flow,
        credentials={
            'email': test_email,
            'pass': f'{word}{random.randint(1000, 9999)}',
            'name': 'Test User',
            'zip': '10001',
            'birth': '01/01/1990',
            'gender': 'other',
        },
    )
    print(f'  Test email: {test_email}')

    # Build human profile from args
    from dataclasses import replace as dc_replace
    from agent.profile import NORMAL, PROFILES

    base = PROFILES[args.profile] if args.profile else NORMAL
    overrides = {}
    if args.mouse is not None:
        overrides['mouse_fast'] = (args.mouse == 'fast')
    if args.typing is not None:
        overrides['type_speed'] = args.typing
    if args.accuracy is not None:
        overrides['type_accuracy'] = args.accuracy
    profile = dc_replace(base, **overrides) if overrides else base

    # Print settings banner
    profile_label = args.profile or 'normal'
    if overrides:
        profile_label += ' (customized)'
    print()
    print(f'  Profile:  {profile_label}')
    print(f'  Mouse:    {"fast" if profile.mouse_fast else "normal (Bezier arc)"}')
    print(f'  Typing:   {profile.type_speed}')
    print(f'  Accuracy: {profile.type_accuracy}')
    print(f'  Decision: {profile.decision_delay[0]:.1f}-{profile.decision_delay[1]:.1f}s')
    if args.no_prompt:
        print(f'  Mode:     no-prompt (auto-execute all steps)')
    else:
        print(f'  Mode:     interactive (prompt before each step)')

    # Step callback (None in no-prompt mode)
    callback = None

    if not args.no_prompt:
        def step_callback(idx, step, session):
            label = f'Step {idx}/{len(playbook.steps) - 1}'

            # Auto-execute waits without prompting
            if step.action == 'wait':
                lo, hi = step.wait_after_sec
                print(f'{label}: wait [{lo}, {hi}]')
                return True

            flags = []
            if step.disabled:
                flags.append('DISABLED')
            if step.optional:
                flags.append('optional')
            flag_str = f'  [{", ".join(flags)}]' if flags else ''
            print(f'{label}: {step.action} "{step.target_description or step.value}"{flag_str}')
            if step.checkpoint and step.checkpoint_prompt:
                print(f'  [checkpoint] "{step.checkpoint_prompt}"')
            if step.is_sensitive:
                print(f'  [sensitive]')
            if step.ref_region:
                print(f'  [ref_region] {list(step.ref_region)}')

            choice = input('Enter=execute, s=skip, q=quit: ').strip().lower()
            if choice == 'q':
                raise KeyboardInterrupt('User quit')
            if choice != 's':
                _focus_chrome(session.pid)
            return choice != 's'

        callback = step_callback

    executor = PlaybookExecutor(inference, step_callback=callback, profile=profile)

    print()
    print('Starting interactive test run...')
    print()

    try:
        result = executor.run(playbook, ctx)
    except KeyboardInterrupt:
        print('\nTest run aborted.')
        return

    print()
    print(f'Result: {"SUCCESS" if result.success else "FAILED"}')
    print(f'Duration: {result.duration_seconds}s')
    print(f'Steps: {result.step_count}, Inference calls: {result.inference_count}')
    if result.error_message:
        print(f'Error: {result.error_message}')

    # Update last_validated on success
    if result.success:
        from agent.config import PLAYBOOK_DIR
        pb_path = PLAYBOOK_DIR / f'{pb_name}.json'
        with open(pb_path) as f:
            data = json.load(f)
        data['last_validated'] = time.strftime('%Y-%m-%dT%H:%M:%S')
        with open(pb_path, 'w') as f:
            json.dump(data, f, indent=2)
            f.write('\n')
        print(f'Updated last_validated in {pb_path}')


# ------------------------------------------------------------------
# list command
# ------------------------------------------------------------------

def cmd_list(args):
    from agent.playbook import Playbook

    playbooks = Playbook.list_all()
    if not playbooks:
        print('No playbooks found.')
        return

    print(f'{"Service":<15} {"Flow":<10} {"Tier":<10} {"Ver":>4} {"Steps":>6} {"Last Validated":<20}')
    print('-' * 70)

    for pb in playbooks:
        validated = pb['last_validated'] or 'never'
        print(
            f'{pb["service"]:<15} {pb["flow"]:<10} {pb.get("tier", ""):<10} '
            f'{pb["version"]:>4} {pb["steps"]:>6} {validated:<20}'
        )


# ------------------------------------------------------------------
# main
# ------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description='Playbook recorder, tester, and manager')
    sub = parser.add_subparsers(dest='command')

    p_record = sub.add_parser('record', help='Record a new playbook by walking through a flow')
    p_record.add_argument('--service', required=True, help='Service name (e.g. netflix)')
    p_record.add_argument('--flow', required=True, help='Flow type (signup or cancel)')
    p_record.add_argument('--tier', default='', help='Plan tier (e.g. ads, standard, premium)')

    p_test = sub.add_parser('test', help='Interactive dry-run of a playbook')
    p_test.add_argument('--service', required=True, help='Service name')
    p_test.add_argument('--flow', required=True, help='Flow type')
    p_test.add_argument('--tier', default='', help='Plan tier')
    p_test.add_argument('--mock', action='store_true', help='Force mock inference')
    p_test.add_argument('--coords', action='store_true', help='Use recorded ref_region coordinates')
    p_test.add_argument('--no-prompt', action='store_true', dest='no_prompt',
                        help='Run all steps without prompting (auto-execute)')
    p_test.add_argument('--profile', choices=['fast', 'normal', 'cautious'], default=None,
                        help='Human behavior preset (default: normal)')
    p_test.add_argument('--mouse', choices=['fast', 'normal'], default=None,
                        help='Override mouse speed')
    p_test.add_argument('--typing', choices=['instant', 'fast', 'medium', 'slow'], default=None,
                        help='Override typing speed')
    p_test.add_argument('--accuracy', choices=['high', 'average', 'low'], default=None,
                        help='Override typing accuracy')

    sub.add_parser('list', help='List all playbooks')

    args = parser.parse_args()

    if args.command is None:
        parser.print_help()
        sys.exit(1)

    dispatch = {
        'record': cmd_record,
        'test': cmd_test,
        'list': cmd_list,
    }
    dispatch[args.command](args)


if __name__ == '__main__':
    main()
