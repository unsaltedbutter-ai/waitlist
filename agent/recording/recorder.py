"""VLM-guided playbook recorder.

Drives a Chrome browser through cancel/resume flows using VLM analysis of
screenshots. Produces playbook JSON files compatible with the existing executor.

Two-phase prompt chain:
  1. Sign-in prompt (shared)
  2. Cancel or Resume prompt (flow-specific)

When the VLM returns action "done", the recorder advances to the next prompt
in the chain. When the final prompt returns "done", the flow is complete.
"""

from __future__ import annotations

import hashlib
import json
import logging
import subprocess
import time

from agent.config import PLAYBOOK_DIR, PLAYBOOK_REF_DIR
from agent.recording.prompts import (
    build_cancel_prompt,
    build_resume_prompt,
    build_signin_prompt,
)
from agent.recording.vlm_client import VLMClient

log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Credential templating
# ---------------------------------------------------------------------------

# Maps keywords in VLM's text_to_type to (template_var, credentials_key)
_CREDENTIAL_KEYWORDS: list[tuple[list[str], str, str]] = [
    (['email', 'e-mail', 'username', 'phone'], '{email}', 'email'),
    (['password', 'passwd'], '{pass}', 'pass'),
    (['name', 'full name'], '{name}', 'name'),
    (['zip', 'postal'], '{zip}', 'zip'),
    (['birth', 'dob', 'date of birth'], '{birth}', 'birth'),
    (['gender', 'sex'], '{gender}', 'gender'),
]


def _resolve_credential(
    text_to_type: str,
    credentials: dict[str, str],
) -> tuple[str, str, bool]:
    """Map a VLM semantic hint to a template var and actual value.

    Returns (template_var, actual_value, is_sensitive).
    If no keyword matches, returns the literal text.
    """
    hint_lower = text_to_type.lower()
    for keywords, template, cred_key in _CREDENTIAL_KEYWORDS:
        for kw in keywords:
            if kw in hint_lower:
                actual = credentials.get(cred_key, '')
                sensitive = (cred_key == 'pass')
                return template, actual, sensitive
    # No match: use literal text
    return text_to_type, text_to_type, False


# ---------------------------------------------------------------------------
# Stuck detection
# ---------------------------------------------------------------------------

class _StuckDetector:
    """Detect when the recorder is stuck (same state 3x or identical screenshots)."""

    def __init__(self, threshold: int = 3) -> None:
        self.threshold = threshold
        self._history: list[tuple[str, str]] = []  # (state, action) pairs
        self._screenshot_hashes: list[str] = []

    def check(self, state: str, action: str, screenshot_b64: str) -> bool:
        """Returns True if we appear to be stuck."""
        # Check state+action repetition
        entry = (state, action)
        self._history.append(entry)
        if len(self._history) >= self.threshold:
            recent = self._history[-self.threshold:]
            if all(e == recent[0] for e in recent):
                return True

        # Check screenshot hash repetition
        img_hash = hashlib.md5(screenshot_b64[:10000].encode()).hexdigest()
        self._screenshot_hashes.append(img_hash)
        if len(self._screenshot_hashes) >= self.threshold:
            recent_hashes = self._screenshot_hashes[-self.threshold:]
            if all(h == recent_hashes[0] for h in recent_hashes):
                return True

        return False

    def reset(self) -> None:
        """Reset history (e.g. on prompt transition)."""
        self._history.clear()
        self._screenshot_hashes.clear()


# ---------------------------------------------------------------------------
# Sound helpers
# ---------------------------------------------------------------------------

def _play_attention_sound() -> None:
    """Play macOS system sound to get operator attention."""
    try:
        subprocess.Popen(
            ['afplay', '/System/Library/Sounds/Sosumi.aiff'],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except OSError:
        pass


# ---------------------------------------------------------------------------
# PlaybookRecorder
# ---------------------------------------------------------------------------

class PlaybookRecorder:
    """Record a playbook by driving Chrome with VLM-guided automation.

    Args:
        vlm: VLMClient instance for screenshot analysis.
        service: Service name (e.g. 'netflix').
        flow: Flow type ('cancel' or 'resume').
        credentials: Dict with 'email', 'pass', etc.
        plan_tier: Slugified plan tier for filenames (e.g. 'premium').
        plan_display: Raw plan name for VLM prompts (e.g. 'Standard with ads').
            Falls back to plan_tier if not provided.
        variant: Route variant suffix (e.g. 'home' -> netflix_resume_premium_home.json).
        max_steps: Maximum number of VLM analysis steps before aborting.
        settle_delay: Seconds to wait after each action for the page to settle.
    """

    def __init__(
        self,
        vlm: VLMClient,
        service: str,
        flow: str,
        credentials: dict[str, str],
        plan_tier: str = '',
        plan_display: str = '',
        variant: str = '',
        max_steps: int = 60,
        settle_delay: float = 2.5,
    ) -> None:
        self.vlm = vlm
        self.service = service
        self.flow = flow
        self.credentials = credentials
        self.plan_tier = plan_tier
        self.plan_display = plan_display or plan_tier
        self.variant = variant
        self.max_steps = max_steps
        self.settle_delay = settle_delay

        # Build prompt chain
        self._prompts = self._build_prompt_chain()
        self._prompt_idx = 0
        self._prompt_labels = self._build_prompt_labels()

    def _build_prompt_chain(self) -> list[str]:
        """Build the ordered list of system prompts for this flow."""
        chain = [build_signin_prompt(self.service)]
        if self.flow == 'cancel':
            chain.append(build_cancel_prompt(self.service))
        elif self.flow == 'resume':
            chain.append(build_resume_prompt(self.service, self.plan_display))
        else:
            raise ValueError(f'Unknown flow: {self.flow!r}. Must be "cancel" or "resume".')
        return chain

    def _build_prompt_labels(self) -> list[str]:
        """Human-readable labels for each prompt phase."""
        labels = ['sign-in']
        if self.flow == 'cancel':
            labels.append('cancel')
        else:
            labels.append('resume')
        return labels

    @property
    def _current_prompt(self) -> str:
        return self._prompts[self._prompt_idx]

    @property
    def _current_label(self) -> str:
        return self._prompt_labels[self._prompt_idx]

    def _playbook_filename(self) -> str:
        """Build the output filename stem.

        Plan tier and variant are independent suffixes:
          netflix_cancel              (no plan, no variant)
          netflix_cancel_home         (no plan, variant=home)
          netflix_resume_premium      (plan=premium, no variant)
          netflix_resume_premium_home (plan=premium, variant=home)
        """
        name = f'{self.service}_{self.flow}'
        if self.plan_tier:
            name += f'_{self.plan_tier}'
        if self.variant:
            name += f'_{self.variant}'
        return name

    def run(self, start_url: str) -> dict:
        """Run the VLM-guided recording loop.

        Expects an active Chrome session (loaded via session file or pre-created).
        Uses existing agent modules for browser control, screenshots, and input.

        Args:
            start_url: URL to navigate to at the start.

        Returns:
            Playbook dict ready for JSON serialization.
        """
        from agent import browser, screenshot as ss
        from agent.input import coords, keyboard, mouse, scroll as scroll_mod

        SESSION_FILE = '/tmp/ub-chrome-session.json'

        # Load or create Chrome session
        session = self._load_session(SESSION_FILE)
        if session is None:
            print('No active Chrome session. Launching one...')
            session = browser.create_session()
            self._save_session(session, SESSION_FILE)
            print(f'Chrome launched (PID {session.pid})')
        else:
            browser.get_session_window(session)
            print(f'Attached to Chrome (PID {session.pid})')

        # Setup ref screenshot directory
        pb_name = self._playbook_filename()
        ref_dir = PLAYBOOK_REF_DIR / pb_name
        ref_dir.mkdir(parents=True, exist_ok=True)

        # Navigate to start URL
        steps: list[dict] = []
        if start_url:
            browser.navigate(session, start_url, fast=True)
            steps.append({'action': 'navigate', 'url': start_url})
            print(f'Step 0: navigate "{start_url}"')

        stuck = _StuckDetector()
        step_num = 0

        print(f'\nRecording: {pb_name} (phase: {self._current_label})')
        print(f'Max steps: {self.max_steps}, settle delay: {self.settle_delay}s\n')

        for iteration in range(self.max_steps):
            # Wait for page to settle
            time.sleep(self.settle_delay)

            # Capture screenshot
            browser.get_session_window(session)
            screenshot_b64 = ss.capture_to_base64(session.window_id)

            # Ask VLM
            print(f'  [{self._current_label}] Analyzing screenshot...', end=' ', flush=True)
            try:
                response, scale_factor = self.vlm.analyze(screenshot_b64, self._current_prompt)
            except Exception as exc:
                print(f'VLM error: {exc}')
                continue

            state = response.get('state', '')
            action = response.get('action', '')
            confidence = response.get('confidence', 0.0)
            reasoning = response.get('reasoning', '')
            target_desc = response.get('target_description', '')
            bbox = response.get('bounding_box')

            # Scale bbox back to original image coordinates if screenshot was resized
            if bbox and scale_factor != 1.0:
                bbox = [int(c * scale_factor) for c in bbox]
            text_to_type = response.get('text_to_type', '')
            key_to_press = response.get('key_to_press', '')
            is_checkpoint = response.get('is_checkpoint', False)
            checkpoint_prompt = response.get('checkpoint_prompt', '')

            print(f'{action} (confidence: {confidence:.2f})')
            print(f'    State: {state}')
            print(f'    Reason: {reasoning}')
            if target_desc:
                print(f'    Target: {target_desc}')

            # Handle "done" (advance prompt chain or finish)
            if action == 'done':
                if self._prompt_idx < len(self._prompts) - 1:
                    # Transition to next prompt phase
                    steps.append({
                        'action': 'wait',
                        'wait_after_sec': [2, 4],
                        'checkpoint': True,
                        'checkpoint_prompt': f'{self._current_label} phase complete',
                    })
                    self._prompt_idx += 1
                    stuck.reset()
                    print(f'\n  Phase transition: {self._prompt_labels[self._prompt_idx - 1]} -> {self._current_label}\n')
                    continue
                else:
                    # Flow complete
                    print('\n  Flow complete!')
                    break

            # Handle "need_human"
            if state == 'need_human' or 'need_human' in str(state):
                _play_attention_sound()
                print('\n  NEEDS HUMAN INTERVENTION')
                print(f'  Reason: {reasoning}')
                input('  Press Enter after resolving, or Ctrl+C to abort...')
                continue

            # Stuck detection
            if stuck.check(state, action, screenshot_b64):
                _play_attention_sound()
                print('\n  STUCK DETECTED (same state/action 3x)')
                choice = input('  Continue anyway? (y/n): ').strip().lower()
                if choice != 'y':
                    print('  Aborting.')
                    break
                stuck.reset()

            # Execute and record the action
            step_num = len(steps)
            ref_path = ref_dir / f'step_{step_num:02d}.png'
            ss.capture_window(session.window_id, str(ref_path))

            if action == 'click' and bbox:
                # Convert bbox center to screen coordinates and click
                cx = (bbox[0] + bbox[2]) / 2
                cy = (bbox[1] + bbox[3]) / 2
                sx, sy = coords.image_to_screen(cx, cy, session.bounds)
                mouse.click(sx, sy)

                step_data: dict = {
                    'action': 'click',
                    'target_description': target_desc,
                    'ref_region': bbox,
                }
                if is_checkpoint:
                    step_data['checkpoint'] = True
                    step_data['checkpoint_prompt'] = checkpoint_prompt
                steps.append(step_data)
                print(f'    -> Step {step_num}: click "{target_desc}" bbox={bbox}')

            elif action == 'type_text':
                template_var, actual_value, sensitive = _resolve_credential(
                    text_to_type, self.credentials,
                )

                if actual_value:
                    keyboard.type_text(actual_value, speed='medium', accuracy='high')

                step_data = {
                    'action': 'type_text',
                    'target_description': target_desc,
                    'value': template_var,
                }
                if sensitive:
                    step_data['sensitive'] = True
                steps.append(step_data)
                print(f'    -> Step {step_num}: type_text "{template_var}"')

            elif action == 'scroll_down':
                scroll_mod.scroll('down', 3)
                steps.append({
                    'action': 'scroll',
                    'target_description': 'down 3',
                })
                print(f'    -> Step {step_num}: scroll down')

            elif action == 'scroll_up':
                scroll_mod.scroll('up', 3)
                steps.append({
                    'action': 'scroll',
                    'target_description': 'up 3',
                })
                print(f'    -> Step {step_num}: scroll up')

            elif action == 'press_key' and key_to_press:
                keyboard.press_key(key_to_press)
                steps.append({
                    'action': 'press_key',
                    'value': key_to_press,
                })
                print(f'    -> Step {step_num}: press_key "{key_to_press}"')

            elif action == 'wait':
                # VLM says page is loading, just wait (no step recorded)
                print(f'    -> Waiting (page loading)')

            else:
                print(f'    -> Unknown action: {action}, skipping')

        else:
            print(f'\n  Max steps ({self.max_steps}) reached. Stopping.')

        # Build playbook dict
        playbook_data: dict = {
            'service': self.service,
            'flow': self.flow,
            'version': 1,
            'notes': f'VLM-recorded on {time.strftime("%Y-%m-%d")} via learn mode',
            'last_validated': None,
            'steps': steps,
        }
        if self.plan_tier:
            playbook_data['tier'] = self.plan_tier

        # Write playbook JSON
        out_path = PLAYBOOK_DIR / f'{pb_name}.json'
        out_path.parent.mkdir(parents=True, exist_ok=True)
        with open(out_path, 'w') as f:
            json.dump(playbook_data, f, indent=2)
            f.write('\n')

        print(f'\nPlaybook written: {out_path}')
        print(f'Reference screenshots: {ref_dir}/')
        print(f'{len(steps)} steps recorded.')

        return playbook_data

    @staticmethod
    def _load_session(session_file: str):
        """Load an existing Chrome session from the session file."""
        import os

        from agent.browser import BrowserSession

        if not os.path.exists(session_file):
            return None

        with open(session_file) as f:
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

    @staticmethod
    def _save_session(session, session_file: str) -> None:
        """Save session state for other CLI tools."""
        data = {
            'pid': session.pid,
            'profile_dir': session.profile_dir,
            'window_id': session.window_id,
            'bounds': session.bounds,
        }
        with open(session_file, 'w') as f:
            json.dump(data, f, indent=2)
