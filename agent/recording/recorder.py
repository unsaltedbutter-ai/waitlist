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

import base64
import hashlib
import io
import json
import logging
import random
import subprocess
import time
from datetime import datetime, timezone

from agent.config import PLAYBOOK_DIR, PLAYBOOK_REF_DIR
from agent.recording.prompts import (
    build_cancel_prompt,
    build_resume_prompt,
    build_signin_prompt,
)
from agent.recording.vlm_client import VLMClient
from agent.screenshot import crop_browser_chrome

log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Credential templating
# ---------------------------------------------------------------------------

# Maps keywords in VLM's text_to_type to (template_var, credentials_key)
_CREDENTIAL_KEYWORDS: list[tuple[list[str], str, str]] = [
    (['email', 'e-mail', 'username', 'phone'], '{email}', 'email'),
    (['password', 'passwd'], '{pass}', 'pass'),
    (['cvv', 'cvc', 'security code', 'card verification'], '{cvv}', 'cvv'),
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
        # Check state+action repetition (skip "wait" since repeated
        # waits are normal for slow page loads; screenshot hash check
        # below still catches truly frozen pages)
        if action != 'wait':
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
        verbose: bool = False,
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
        self.verbose = verbose

        # Build prompt chain
        self._prompts = self._build_prompt_chain()
        self._prompt_idx = 0
        self._prompt_labels = self._build_prompt_labels()

        # Page boundary tracking for manifest
        self._pages: list[dict] = []
        self._current_page_start: int | None = None
        self._current_page_screenshot: str | None = None
        self._current_page_label: str = ''
        self._page_count: int = 0

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

    # ------------------------------------------------------------------
    # Page boundary tracking
    # ------------------------------------------------------------------

    def _close_current_page(self, end_step: int, boundary: str) -> None:
        """Close the current page (if any) and record it in the manifest."""
        if self._current_page_start is None:
            return
        # end_step is exclusive (the boundary step itself belongs to the next page)
        if end_step <= self._current_page_start:
            return
        self._pages.append({
            'page_index': self._page_count,
            'label': self._current_page_label,
            'screenshot': self._current_page_screenshot or '',
            'step_range': [self._current_page_start, end_step - 1],
            'boundary': boundary,
        })
        self._page_count += 1
        self._current_page_start = None
        self._current_page_screenshot = None
        self._current_page_label = ''

    def _open_new_page(self, step_idx: int, screenshot_file: str, label: str) -> None:
        """Start tracking a new page."""
        self._current_page_start = step_idx
        self._current_page_screenshot = screenshot_file
        self._current_page_label = label

    def _write_manifest(self, ref_dir, start_url: str) -> None:
        """Write _manifest.json to the ref directory."""
        manifest = {
            'service': self.service,
            'flow': self.flow,
            'start_url': start_url,
            'recorded_at': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S'),
            'pages': self._pages,
        }
        if self.plan_tier:
            manifest['tier'] = self.plan_tier
        manifest_path = ref_dir / '_manifest.json'
        with open(manifest_path, 'w') as f:
            json.dump(manifest, f, indent=2)
            f.write('\n')
        print(f'Manifest written: {manifest_path} ({len(self._pages)} pages)')

    def _scale_bbox(self, bbox, scale_factor: float) -> list[int]:
        """Scale a VLM bbox to original image pixels."""
        return [int(c * scale_factor) for c in bbox]

    def _click_bbox(self, bbox, session, screenshot_b64, ref_dir, steps,
                    target_desc, coords_mod, mouse_mod, is_checkpoint=False,
                    chrome_offset=0):
        """Click inside a bbox: inset, randomize, record step. Returns screen coords."""
        scaled = self._scale_bbox(bbox, 1.0)  # already scaled by caller

        bw = scaled[2] - scaled[0]
        bh = scaled[3] - scaled[1]
        inset_x = bw * 0.10
        inset_y = bh * 0.10
        safe_x1 = scaled[0] + inset_x
        safe_y1 = scaled[1] + inset_y
        safe_x2 = scaled[2] - inset_x
        safe_y2 = scaled[3] - inset_y
        cx = (safe_x1 + safe_x2) / 2 + random.gauss(0, bw * 0.10)
        cy = (safe_y1 + safe_y2) / 2 + random.gauss(0, bh * 0.10)
        cx = max(safe_x1, min(cx, safe_x2))
        cy = max(safe_y1, min(cy, safe_y2))

        sx, sy = coords_mod.image_to_screen(cx, cy, session.bounds,
                                            chrome_offset=chrome_offset)
        print(f'    [debug] bbox={scaled} center=({cx:.0f},{cy:.0f}) '
              f'screen=({sx:.0f},{sy:.0f})')

        step_num = len(steps)
        self._save_debug_overlay(
            screenshot_b64, scaled,
            ref_dir / f'step_{step_num:02d}_debug.png',
        )
        mouse_mod.click(sx, sy, fast=True)

        step_data: dict = {
            'action': 'click',
            'target_description': target_desc,
            'ref_region': scaled,
        }
        if is_checkpoint:
            step_data['checkpoint'] = True
        steps.append(step_data)
        print(f'    -> Step {step_num}: click "{target_desc}" bbox={scaled}')

    def _execute_signin_page(self, response, scale_factor, session,
                             screenshot_b64, ref_dir, steps, modules,
                             chrome_offset=0):
        """Handle a sign-in page classification response.

        Executes the full click-type-tab-enter sequence locally based on
        the page_type, without additional VLM calls.

        Returns: 'continue' (take another screenshot), 'done' (sign-in complete),
                 or 'need_human'.
        """
        coords_mod, keyboard, mouse, scroll_mod = modules

        page_type = response.get('page_type', '')
        confidence = response.get('confidence', 0.0)
        reasoning = response.get('reasoning', '')

        # Scale all bboxes
        def scale(box):
            if box and len(box) == 4:
                return [int(c * scale_factor) for c in box]
            return None

        email_box = scale(response.get('email_box'))
        password_box = scale(response.get('password_box'))
        button_box = scale(response.get('button_box'))
        profile_box = scale(response.get('profile_box'))

        # Scale code_boxes list
        raw_code_boxes = response.get('code_boxes') or []
        code_boxes = []
        for cb in raw_code_boxes:
            if isinstance(cb, dict) and cb.get('box'):
                scaled_box = scale(cb['box'])
                if scaled_box:
                    code_boxes.append({'label': cb.get('label', ''), 'box': scaled_box})

        print(f'{page_type} (confidence: {confidence:.2f})')
        print(f'    Reason: {reasoning}')
        if email_box:
            print(f'    email_box: {email_box}')
        if password_box:
            print(f'    password_box: {password_box}')
        if button_box:
            print(f'    button_box: {button_box}')
        if code_boxes:
            print(f'    code_boxes: {len(code_boxes)} fields')

        if page_type == 'signed_in':
            return 'done'

        if page_type == 'spinner':
            print('    Page loading, waiting...')
            return 'continue'

        # States that always need human intervention
        if page_type in ('email_link', 'captcha'):
            return 'need_human'

        # Code entry states: record the boxes for the playbook, then need human for OTP
        if page_type in ('email_code_single', 'email_code_multi',
                         'phone_code_single', 'phone_code_multi'):
            step_num = len(steps)
            ref_path = ref_dir / f'step_{step_num:02d}.png'
            self._save_ref_image(screenshot_b64, ref_path)
            # Record code box locations for playbook
            step_data: dict = {
                'action': 'enter_code',
                'page_type': page_type,
                'code_boxes': [cb['box'] for cb in code_boxes],
            }
            if button_box:
                step_data['button_box'] = button_box
            steps.append(step_data)
            print(f'    -> Step {step_num}: enter_code ({page_type}, {len(code_boxes)} boxes)')
            return 'need_human'

        # Unknown state: try to auto-recover by executing the VLM's suggested actions
        if page_type == 'unknown':
            page_desc = response.get('page_description', '')
            actions = response.get('actions') or []
            print(f'    Page description: {page_desc}')
            if not actions:
                print('    No recovery actions suggested, needs human')
                return 'need_human'

            step_num = len(steps)
            ref_path = ref_dir / f'step_{step_num:02d}.png'
            self._save_ref_image(screenshot_b64, ref_path)

            for act in actions:
                act_type = act.get('action', '')
                target = act.get('target', '')
                box = scale(act.get('box'))
                if act_type in ('click', 'dismiss') and box:
                    self._click_bbox(
                        box, session, screenshot_b64, ref_dir, steps,
                        f'dismiss: {target}', coords_mod, mouse,
                        chrome_offset=chrome_offset,
                    )
                    time.sleep(0.5)
                else:
                    print(f'    Skipping unknown action: {act_type}')
            return 'continue'

        # Save ref screenshot (reuse the existing capture, no second screenshot)
        step_num = len(steps)
        ref_path = ref_dir / f'step_{step_num:02d}.png'
        self._save_ref_image(screenshot_b64, ref_path)

        if page_type == 'profile_select' and profile_box:
            self._click_bbox(
                profile_box, session, screenshot_b64, ref_dir, steps,
                'first profile', coords_mod, mouse,
                chrome_offset=chrome_offset,
            )
            return 'continue'

        if page_type == 'button_only' and button_box:
            self._click_bbox(
                button_box, session, screenshot_b64, ref_dir, steps,
                'Sign In button', coords_mod, mouse, is_checkpoint=True,
                chrome_offset=chrome_offset,
            )
            return 'continue'

        if page_type == 'user_pass' and email_box:
            # Click email, type, tab, type password, enter
            self._click_bbox(
                email_box, session, screenshot_b64, ref_dir, steps,
                'email input', coords_mod, mouse,
                chrome_offset=chrome_offset,
            )
            time.sleep(0.3)
            email_val = self.credentials.get('email', '')
            if email_val:
                keyboard.type_text(email_val, speed='medium', accuracy='high')
            steps.append({'action': 'type_text', 'value': '{email}'})
            print(f'    -> Step {len(steps)-1}: type_text "{{email}}" (auto)')

            time.sleep(0.2)
            keyboard.press_key('tab')
            steps.append({'action': 'press_key', 'value': 'tab'})
            print(f'    -> Step {len(steps)-1}: press_key "tab"')

            time.sleep(0.2)
            pass_val = self.credentials.get('pass', '')
            if pass_val:
                keyboard.type_text(pass_val, speed='medium', accuracy='high')
            steps.append({'action': 'type_text', 'value': '{pass}', 'sensitive': True})
            print(f'    -> Step {len(steps)-1}: type_text "{{pass}}" (auto)')

            time.sleep(0.2)
            keyboard.press_key('enter')
            steps.append({'action': 'press_key', 'value': 'enter'})
            print(f'    -> Step {len(steps)-1}: press_key "enter"')
            time.sleep(1.0)  # let form submit before next screenshot
            return 'continue'

        if page_type == 'user_only' and email_box:
            # Click email, type, enter
            self._click_bbox(
                email_box, session, screenshot_b64, ref_dir, steps,
                'email input', coords_mod, mouse,
                chrome_offset=chrome_offset,
            )
            time.sleep(0.3)
            email_val = self.credentials.get('email', '')
            if email_val:
                keyboard.type_text(email_val, speed='medium', accuracy='high')
            steps.append({'action': 'type_text', 'value': '{email}'})
            print(f'    -> Step {len(steps)-1}: type_text "{{email}}" (auto)')

            time.sleep(0.2)
            keyboard.press_key('enter')
            steps.append({'action': 'press_key', 'value': 'enter'})
            print(f'    -> Step {len(steps)-1}: press_key "enter"')
            time.sleep(1.0)  # let form submit before next screenshot
            return 'continue'

        if page_type == 'pass_only' and password_box:
            # Click password, type, enter
            self._click_bbox(
                password_box, session, screenshot_b64, ref_dir, steps,
                'password input', coords_mod, mouse,
                chrome_offset=chrome_offset,
            )
            time.sleep(0.3)
            pass_val = self.credentials.get('pass', '')
            if pass_val:
                keyboard.type_text(pass_val, speed='medium', accuracy='high')
            steps.append({'action': 'type_text', 'value': '{pass}', 'sensitive': True})
            print(f'    -> Step {len(steps)-1}: type_text "{{pass}}" (auto)')

            time.sleep(0.2)
            keyboard.press_key('enter')
            steps.append({'action': 'press_key', 'value': 'enter'})
            print(f'    -> Step {len(steps)-1}: press_key "enter"')
            time.sleep(1.0)  # let form submit before next screenshot
            return 'continue'

        # Fallback: couldn't execute (missing bbox)
        print(f'    WARNING: page_type={page_type} but missing required bbox')
        return 'continue'

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
        # The first page starts after the navigate step; its identity screenshot
        # will be captured on the first iteration of the loop below.
        self._pending_page_open = True

        print(f'\nRecording: {pb_name} (phase: {self._current_label})')
        print(f'Max steps: {self.max_steps}, settle delay: {self.settle_delay}s')
        print(f'Image max width: {self.vlm.MAX_IMAGE_WIDTH}px\n')
        if self.verbose:
            self._dump_prompt(ref_dir, self._current_label, self._current_prompt)

        for iteration in range(self.max_steps):
            # Wait for page to settle
            time.sleep(self.settle_delay)

            # Capture screenshot and crop browser chrome
            browser.get_session_window(session)
            raw_screenshot_b64 = ss.capture_to_base64(session.window_id)
            screenshot_b64, chrome_height_px = crop_browser_chrome(raw_screenshot_b64)

            # Open a new page if one is pending (first iter or after a boundary)
            if self._pending_page_open:
                current_step_idx = len(steps)
                # The identity screenshot for this page is the next ref image
                # that will be saved (step_XX.png). We record the filename now.
                page_screenshot = f'step_{current_step_idx:02d}.png'
                page_label = self._current_label
                self._open_new_page(current_step_idx, page_screenshot, page_label)
                self._pending_page_open = False

            # Ask VLM
            print(f'  [{self._current_label}] Analyzing screenshot...', end=' ', flush=True)
            try:
                response, scale_factor = self.vlm.analyze(screenshot_b64, self._current_prompt)
            except Exception as exc:
                print(f'VLM error: {exc}')
                continue

            print(f'{self.vlm.last_inference_ms}ms', end=' ', flush=True)

            # Sign-in phase: page classification (different response schema)
            if self._current_label == 'sign-in':
                page_type = response.get('page_type', 'unknown')

                # Stuck detection using page_type
                if stuck.check(page_type, page_type, screenshot_b64):
                    _play_attention_sound()
                    print('\n  STUCK DETECTED (same page type 3x)')
                    choice = input('  Continue anyway? (y/n): ').strip().lower()
                    if choice != 'y':
                        print('  Aborting.')
                        break
                    stuck.reset()

                modules = (coords, keyboard, mouse, scroll_mod)
                result = self._execute_signin_page(
                    response, scale_factor, session,
                    screenshot_b64, ref_dir, steps, modules,
                    chrome_offset=chrome_height_px,
                )

                if result == 'done':
                    if self._prompt_idx < len(self._prompts) - 1:
                        # Close the current page before the checkpoint boundary
                        checkpoint_step_idx = len(steps)
                        self._close_current_page(checkpoint_step_idx, 'checkpoint')
                        steps.append({
                            'action': 'wait',
                            'wait_after_sec': [2, 4],
                            'checkpoint': True,
                            'checkpoint_prompt': 'sign-in phase complete',
                        })
                        self._prompt_idx += 1
                        stuck.reset()
                        self._pending_page_open = True
                        print(f'\n  Phase transition: sign-in -> {self._current_label}\n')
                        if self.verbose:
                            self._dump_prompt(ref_dir, self._current_label, self._current_prompt)
                    else:
                        print('\n  Flow complete!')
                        break
                    continue

                if result == 'need_human':
                    _play_attention_sound()
                    print('\n  NEEDS HUMAN INTERVENTION')
                    print(f'  Page type: {page_type}')
                    input('  Press Enter after resolving, or Ctrl+C to abort...')
                    continue

                # 'continue': take another screenshot on next iteration
                continue

            # Cancel / Resume phase: generic action response
            state = response.get('state', '')
            action = response.get('action', '')
            confidence = response.get('confidence', 0.0)
            reasoning = response.get('reasoning', '')
            target_desc = response.get('target_description', '')
            bbox = response.get('bounding_box')

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
                    # Close the current page before the checkpoint boundary
                    checkpoint_step_idx = len(steps)
                    self._close_current_page(checkpoint_step_idx, 'checkpoint')
                    # Transition to next prompt phase
                    steps.append({
                        'action': 'wait',
                        'wait_after_sec': [2, 4],
                        'checkpoint': True,
                        'checkpoint_prompt': f'{self._current_label} phase complete',
                    })
                    self._prompt_idx += 1
                    stuck.reset()
                    self._pending_page_open = True
                    print(f'\n  Phase transition: {self._prompt_labels[self._prompt_idx - 1]} -> {self._current_label}\n')
                    if self.verbose:
                        self._dump_prompt(ref_dir, self._current_label, self._current_prompt)
                    continue
                else:
                    # Flow complete
                    print('\n  Flow complete!')
                    break

            # Handle "need_human" (can appear as state or action)
            if 'need_human' in state or action == 'need_human':
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
            self._save_ref_image(screenshot_b64, ref_path)

            if action == 'click' and bbox:
                # Scale VLM bbox from resized image back to original screenshot pixels.
                # Always multiply by scale_factor (1.0 when no resize occurred).
                scaled_bbox = [int(c * scale_factor) for c in bbox]

                # Refine: zoom into area around bbox and re-query for precise coords.
                # Qwen-VL's normalized 0-1000 system is already accurate;
                # refinement only helps models with poor absolute-pixel grounding.
                if not self.vlm._normalized_coords:
                    refined = self._refine_click_target(
                        screenshot_b64, scaled_bbox, target_desc,
                    )
                    if refined:
                        print(f'    [debug] initial_bbox={scaled_bbox} refined_bbox={refined}')
                        scaled_bbox = refined

                # Inset bbox by 10% to avoid clicking near edges, then
                # pick a random point (center-biased Gaussian)
                bw = scaled_bbox[2] - scaled_bbox[0]
                bh = scaled_bbox[3] - scaled_bbox[1]
                inset_x = bw * 0.10
                inset_y = bh * 0.10
                safe_x1 = scaled_bbox[0] + inset_x
                safe_y1 = scaled_bbox[1] + inset_y
                safe_x2 = scaled_bbox[2] - inset_x
                safe_y2 = scaled_bbox[3] - inset_y
                cx = (safe_x1 + safe_x2) / 2 + random.gauss(0, bw * 0.10)
                cy = (safe_y1 + safe_y2) / 2 + random.gauss(0, bh * 0.10)
                # Clamp inside the inset box
                cx = max(safe_x1, min(cx, safe_x2))
                cy = max(safe_y1, min(cy, safe_y2))
                sx, sy = coords.image_to_screen(
                    cx, cy, session.bounds, chrome_offset=chrome_height_px,
                )
                print(f'    [debug] bbox={scaled_bbox} '
                      f'center=({cx:.0f},{cy:.0f}) scale={scale_factor:.2f} '
                      f'screen=({sx:.0f},{sy:.0f}) bounds={session.bounds}')

                # Save debug overlay: draw bbox on the FULL screenshot
                self._save_debug_overlay(
                    screenshot_b64, scaled_bbox,
                    ref_dir / f'step_{step_num:02d}_debug.png',
                )

                mouse.click(sx, sy, fast=True)

                step_data: dict = {
                    'action': 'click',
                    'target_description': target_desc,
                    'ref_region': scaled_bbox,
                }
                if is_checkpoint:
                    step_data['checkpoint'] = True
                    step_data['checkpoint_prompt'] = checkpoint_prompt
                steps.append(step_data)
                print(f'    -> Step {step_num}: click "{target_desc}" bbox={scaled_bbox}')

                # Checkpoint clicks mark page boundaries
                if is_checkpoint:
                    self._close_current_page(len(steps), 'checkpoint')
                    self._pending_page_open = True

                # Auto-type after clicking an input field. VLMs can't
                # distinguish focused vs unfocused empty fields visually,
                # so we infer the credential from the target description
                # and type immediately (like a real human would).
                auto_type_hint = self._infer_credential_from_target(target_desc)
                if auto_type_hint:
                    time.sleep(0.3)  # brief pause for field to focus
                    template_var, actual_value, sensitive = _resolve_credential(
                        auto_type_hint, self.credentials,
                    )
                    if actual_value:
                        keyboard.type_text(actual_value, speed='medium', accuracy='high')
                    step_num = len(steps)
                    type_step: dict = {
                        'action': 'type_text',
                        'target_description': target_desc,
                        'value': template_var,
                    }
                    if sensitive:
                        type_step['sensitive'] = True
                    steps.append(type_step)
                    print(f'    -> Step {step_num}: type_text "{template_var}" (auto)')

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

            elif action in ('scroll_down', 'scroll_up'):
                direction = 'down' if action == 'scroll_down' else 'up'
                # Scroll 75% of the visible window height so below-fold
                # content moves to the top of the viewport in one action.
                px_per_click = 30
                window_h = session.bounds.get('height', 900)
                scroll_clicks = max(5, int(window_h * 0.75 / px_per_click))
                scroll_mod.scroll(direction, scroll_clicks)
                steps.append({
                    'action': 'scroll',
                    'target_description': f'{direction} {scroll_clicks}',
                })
                print(f'    -> Step {step_num}: scroll {direction} ({scroll_clicks} clicks, ~{scroll_clicks * px_per_click}px)')

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

        # Close the last open page and write manifest
        self._close_current_page(len(steps), 'end')
        if self._pages:
            self._write_manifest(ref_dir, start_url)

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

    # Keywords indicating the click target is an input field (not a button/link)
    _FIELD_INDICATORS = ('field', 'input', 'box', 'textbox', 'text box')

    def _refine_click_target(
        self,
        screenshot_b64: str,
        bbox: list[int],
        target_desc: str,
    ) -> list[int] | None:
        """Zoom into the VLM's rough bbox area and re-query for precise coords.

        General-purpose VLMs return bounding boxes that are close but not
        pixel-accurate. This method crops a generous vertical band around
        the initial guess and asks the VLM to pinpoint the exact element
        in the zoomed view, where there is much less ambiguity.

        Args:
            screenshot_b64: Full original screenshot (base64 PNG).
            bbox: VLM bbox in original image pixels (already scaled).
            target_desc: What element to find.

        Returns:
            Refined bbox in original image pixels, or None on failure.
        """
        from PIL import Image

        try:
            raw = base64.b64decode(screenshot_b64)
            img = Image.open(io.BytesIO(raw))
        except Exception:
            return None

        # Crop: full width, generous vertical padding (4x bbox height each side)
        bh = max(bbox[3] - bbox[1], 100)
        cy = (bbox[1] + bbox[3]) // 2
        crop_y1 = max(0, cy - bh * 4)
        crop_y2 = min(img.height, cy + bh * 4)

        cropped = img.crop((0, crop_y1, img.width, crop_y2))
        buf = io.BytesIO()
        cropped.save(buf, format='PNG')
        crop_b64 = base64.b64encode(buf.getvalue()).decode('ascii')

        cw, ch = cropped.size
        user_msg = (
            f'This cropped image is {cw}x{ch} pixels. '
            f'Find the exact bounding box of: {target_desc}. '
            f'Coordinates must be absolute pixels within this {cw}x{ch} image '
            f'(origin at top-left). Respond with ONLY a JSON object: '
            f'{{"bounding_box": [x1, y1, x2, y2]}}'
        )

        print(f'    [refine] crop y={crop_y1}..{crop_y2} ({cw}x{ch}), querying VLM...', end=' ', flush=True)

        try:
            result, crop_scale = self.vlm.analyze(
                crop_b64,
                'You are a UI element locator. Return the exact bounding box '
                'of the requested element. Nothing else.',
                user_message=user_msg,
            )
            refined = result.get('bounding_box')
            print(f'{self.vlm.last_inference_ms}ms')
            print(f'    [refine] vlm returned: {refined} (crop_scale={crop_scale:.3f})')
            if refined and len(refined) == 4:
                mapped = [
                    int(refined[0] * crop_scale),
                    int(refined[1] * crop_scale) + crop_y1,
                    int(refined[2] * crop_scale),
                    int(refined[3] * crop_scale) + crop_y1,
                ]
                print(f'    [refine] mapped to full image: {mapped}')
                return mapped
        except Exception as exc:
            print(f'    [refine] FAILED: {exc}')
            log.warning('Click refinement failed: %s', exc)

        return None

    def _infer_credential_from_target(self, target_desc: str) -> str | None:
        """Infer if a clicked target is a credential input field.

        After clicking an email or password field, the VLM would need another
        round-trip just to say "type the email". We skip that by auto-typing
        immediately when the target description clearly indicates a credential
        input field.

        Returns a semantic hint (e.g. 'the email address') that
        _resolve_credential can match, or None if not a credential field.
        """
        desc_lower = target_desc.lower()

        # Exclude buttons, links, and other non-input elements
        if any(kw in desc_lower for kw in ('button', 'link', 'menu', 'tab', 'icon')):
            return None

        # Must look like an input field
        if not any(kw in desc_lower for kw in self._FIELD_INDICATORS):
            return None

        # Email/username field
        if any(kw in desc_lower for kw in ('email', 'e-mail', 'username', 'phone')):
            return 'the email address'

        # Password field
        if any(kw in desc_lower for kw in ('password', 'passwd')):
            return 'the password'

        # CVV / security code field
        if any(kw in desc_lower for kw in ('cvv', 'cvc', 'security code')):
            return 'the cvv'

        return None

    @staticmethod
    def _dump_prompt(ref_dir, label: str, prompt: str) -> None:
        """Print prompt to screen and write to ref directory as prompt_<label>.txt."""
        print(f'--- SYSTEM PROMPT ({label}) ---')
        print(prompt)
        print('--- END PROMPT ---\n')
        path = ref_dir / f'prompt_{label.replace("-", "_")}.txt'
        with open(path, 'w') as f:
            f.write(prompt)
        print(f'  Prompt saved: {path}')

    def _save_ref_image(self, screenshot_b64: str, path) -> None:
        """Save a base64 screenshot as a reference image, shrunk to VLM input size."""
        try:
            from PIL import Image
            raw = base64.b64decode(screenshot_b64)
            img = Image.open(io.BytesIO(raw))
            max_w = self.vlm.MAX_IMAGE_WIDTH
            if img.width > max_w:
                ratio = max_w / img.width
                new_size = (max_w, int(img.height * ratio))
                img = img.resize(new_size, Image.LANCZOS)
            img.save(str(path))
        except Exception as exc:
            log.warning('Could not save ref image: %s', exc)

    @staticmethod
    def _save_debug_overlay(
        screenshot_b64: str,
        bbox: list[int],
        out_path,
    ) -> None:
        """Draw a red rectangle on the screenshot at the bbox and save it.

        Helps verify VLM bounding box accuracy visually.
        """
        try:
            from PIL import Image, ImageDraw

            raw = base64.b64decode(screenshot_b64)
            img = Image.open(io.BytesIO(raw))
            draw = ImageDraw.Draw(img)
            x1, y1, x2, y2 = bbox
            # Draw thick red rectangle
            for offset in range(3):
                draw.rectangle(
                    [x1 - offset, y1 - offset, x2 + offset, y2 + offset],
                    outline='red',
                )
            # Draw crosshair at center
            cx, cy = (x1 + x2) // 2, (y1 + y2) // 2
            draw.line([(cx - 20, cy), (cx + 20, cy)], fill='red', width=2)
            draw.line([(cx, cy - 20), (cx, cy + 20)], fill='red', width=2)
            img.save(str(out_path))
        except Exception as exc:
            log.warning('Could not save debug overlay: %s', exc)

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
