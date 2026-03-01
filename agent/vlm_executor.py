"""VLM-driven production executor.

Navigates streaming service cancel/resume flows using VLM screenshot analysis.
Two-phase prompt chain: sign-in, then cancel/resume.

The VLM classifies each screenshot and returns one action. For sign-in pages,
the VLM classifies the page type and the executor dispatches multi-step
sequences locally (click, type, tab, enter) without additional VLM calls.

Main loop structure (per iteration) for concurrent cursor safety:

  1. [lock]    Restore cursor + execute pending action    [unlock]
  2. [no lock] Settle delay (page reacts to action)
  3. [lock]    Restore cursor + take screenshot           [unlock]
  4. [no lock] VLM inference
  5. [no lock] Parse result, resolve credentials, set pending action
  6. Back to 1

GUI actions (click, type, paste, scroll) are serialized via gui_lock so
multiple concurrent jobs don't interleave physical input. Cursor restore
and screenshot capture are grouped under one lock acquisition so another
job cannot displace the cursor between restore and capture.
"""

from __future__ import annotations

import asyncio
import calendar
import hashlib
import logging
import os
import random
import subprocess
import time
from datetime import date
from typing import Callable

from agent import browser
from agent import screenshot as ss
from agent.config import (
    ACCOUNT_URL_JUMP, ACCOUNT_URLS, ACCOUNT_ZOOM_DEFAULT,
    ACCOUNT_ZOOM_STEPS, PRE_LOGIN_SCROLL, SERVICE_URLS,
    TOTAL_EXECUTION_TIMEOUT,
)
from agent.debug_trace import DebugTrace
from agent.gui_lock import gui_lock
from agent.input import coords, keyboard, mouse, scroll as scroll_mod
from agent.input.window import focus_window_by_pid
from agent.playbook import ExecutionResult
from agent.profile import NORMAL, HumanProfile
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
    """
    hint_lower = text_to_type.lower()
    for keywords, template, cred_key in _CREDENTIAL_KEYWORDS:
        for kw in keywords:
            if kw in hint_lower:
                actual = credentials.get(cred_key, '')
                sensitive = cred_key in ('pass', 'cvv')
                return template, actual, sensitive
    return text_to_type, text_to_type, False


# ---------------------------------------------------------------------------
# Stuck detection
# ---------------------------------------------------------------------------

class _StuckDetector:
    """Detect repeated identical state/action or screenshot hashes."""

    def __init__(self, threshold: int = 3) -> None:
        self.threshold = threshold
        self._history: list[tuple[str, str]] = []
        self._screenshot_hashes: list[str] = []

    def check(self, state: str, action: str, screenshot_b64: str) -> bool:
        if action != 'wait':
            entry = (state, action)
            self._history.append(entry)
            if len(self._history) >= self.threshold:
                recent = self._history[-self.threshold:]
                if all(e == recent[0] for e in recent):
                    return True

        img_hash = hashlib.md5(screenshot_b64[:10000].encode()).hexdigest()
        self._screenshot_hashes.append(img_hash)
        if len(self._screenshot_hashes) >= self.threshold:
            recent_hashes = self._screenshot_hashes[-self.threshold:]
            if all(h == recent_hashes[0] for h in recent_hashes):
                return True

        return False

    def reset(self) -> None:
        self._history.clear()
        self._screenshot_hashes.clear()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _clipboard_copy(text: str) -> None:
    """Copy text to the macOS clipboard via pbcopy."""
    try:
        subprocess.run(
            ['pbcopy'],
            input=text.encode(),
            check=True,
            timeout=5,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        log.warning('pbcopy failed: %s', exc)


def _enter_credential(value: str) -> bool:
    """Type or paste a credential value. Returns True if paste was used.

    MUST be called while holding gui_lock.
    """
    if random.random() < 0.4:
        _clipboard_copy(value)
        keyboard.hotkey('command', 'v')
        time.sleep(0.15)
        return True
    else:
        keyboard.type_text(value, speed='medium', accuracy='high')
        return False


def _simulate_app_switch(session) -> None:
    """Move mouse toward the dock and defocus Chrome.

    MUST be called while holding gui_lock.
    """
    from agent.input.window import focus_window
    bounds = session.bounds
    dock_x = bounds.get('x', 0) + bounds.get('width', 1280) // 2
    dock_y = bounds.get('y', 0) + bounds.get('height', 900) + 60
    mouse.move_to(dock_x, dock_y, fast=False)
    focus_window('Finder')


# Keywords indicating a click target is an input field
_FIELD_INDICATORS = ('field', 'input', 'box', 'textbox', 'text box')


def _infer_credential_from_target(target_desc: str) -> str | None:
    """Infer if a clicked target is a credential input field.

    Returns a semantic hint that _resolve_credential can match, or None.
    """
    desc_lower = target_desc.lower()

    if any(kw in desc_lower for kw in ('button', 'link', 'menu', 'tab', 'icon')):
        return None
    if not any(kw in desc_lower for kw in _FIELD_INDICATORS):
        return None

    if any(kw in desc_lower for kw in ('email', 'e-mail', 'username', 'phone')):
        return 'the email address'
    if any(kw in desc_lower for kw in ('password', 'passwd')):
        return 'the password'
    if any(kw in desc_lower for kw in ('cvv', 'cvc', 'security code')):
        return 'the cvv'

    return None


def _random_point_in_bbox(x1, y1, x2, y2):
    """Pick a center-biased Gaussian point inside a 10%-inset safe area."""
    bw = x2 - x1
    bh = y2 - y1
    inset_x = bw * 0.10
    inset_y = bh * 0.10
    safe_x1 = x1 + inset_x
    safe_y1 = y1 + inset_y
    safe_x2 = x2 - inset_x
    safe_y2 = y2 - inset_y
    rx = (safe_x1 + safe_x2) / 2 + random.gauss(0, bw * 0.10)
    ry = (safe_y1 + safe_y2) / 2 + random.gauss(0, bh * 0.10)
    rx = max(safe_x1, min(rx, safe_x2))
    ry = max(safe_y1, min(ry, safe_y2))
    return rx, ry


def _zero_credentials(credentials: dict) -> None:
    """Overwrite credential values with null bytes and clear the dict."""
    for key in list(credentials.keys()):
        credentials[key] = '\x00' * len(credentials[key])
    credentials.clear()


def _next_month_date(today: date | None = None) -> date:
    """Return the same day-of-month next month, clamped to month end."""
    today = today or date.today()
    year = today.year + (today.month // 12)
    month = (today.month % 12) + 1
    last_day = calendar.monthrange(year, month)[1]
    return date(year, month, min(today.day, last_day))


def _click_bbox(bbox, session, chrome_offset: int = 0) -> None:
    """Click inside a bbox with inset and center-biased Gaussian randomization.

    Accepts [x1, y1, x2, y2] bounding box or [x, y] point coordinate.
    MUST be called while holding gui_lock.
    """
    if len(bbox) == 2:
        # Point coordinate: click with small Gaussian jitter (~16x16 target)
        cx = bbox[0] + random.gauss(0, 4)
        cy = bbox[1] + random.gauss(0, 4)
    elif len(bbox) >= 4:
        cx, cy = _random_point_in_bbox(bbox[0], bbox[1], bbox[2], bbox[3])
    else:
        raise ValueError(f'bbox must have 2 or 4 elements, got {len(bbox)}')

    sx, sy = coords.image_to_screen(cx, cy, session.bounds,
                                    chrome_offset=chrome_offset)
    log.debug('click_bbox: image=(%.1f, %.1f) chrome_offset=%d bounds=%s '
              'display_scale=%.2f -> screen=(%.1f, %.1f)',
              cx, cy, chrome_offset, session.bounds,
              coords._get_display_scale(), sx, sy)
    mouse.click(sx, sy)


def _bbox_to_screen(bbox, session, chrome_offset: int = 0):
    """Convert image-pixel bbox [x1,y1,x2,y2] or point [x,y] to screen coords."""
    if len(bbox) == 2:
        x, y = coords.image_to_screen(bbox[0], bbox[1], session.bounds,
                                       chrome_offset=chrome_offset)
        return (x, y, x, y)
    x1, y1 = coords.image_to_screen(bbox[0], bbox[1], session.bounds,
                                     chrome_offset=chrome_offset)
    x2, y2 = coords.image_to_screen(bbox[2], bbox[3], session.bounds,
                                     chrome_offset=chrome_offset)
    return (x1, y1, x2, y2)


def _restore_cursor(screen_bbox, session) -> bool:
    """Move cursor back into the last-clicked bbox if another job displaced it.

    Each concurrent job tracks where it last clicked (in screen coordinates).
    Before screenshots and action execution, we check whether the cursor is
    still inside that box. If another job moved it away, we re-enter the box
    at a random point (center-biased Gaussian, matching _click_bbox
    distribution) so hover menus reappear.

    MUST be called while holding gui_lock. The caller is responsible for
    acquiring the lock before calling this function.

    Returns True if the cursor was restored.
    """
    x1, y1, x2, y2 = screen_bbox
    cx, cy = mouse.position()
    if x1 <= cx <= x2 and y1 <= cy <= y2:
        return False

    focus_window_by_pid(session.pid)
    rx, ry = _random_point_in_bbox(x1, y1, x2, y2)
    mouse.move_to(int(rx), int(ry))
    return True


# ---------------------------------------------------------------------------
# VLMExecutor
# ---------------------------------------------------------------------------

class VLMExecutor:
    """Production executor: drives Chrome via VLM screenshot analysis.

    Args:
        vlm: VLMClient instance for screenshot analysis.
        profile: Human behavioral profile for timing.
        otp_callback: Async callable(job_id, service) -> str|None.
            Called when the VLM detects an OTP/verification code page.
        credential_callback: Async callable(job_id, service, credential_name) -> str|None.
            Called when a credential (e.g. CVV) is needed but not in the credentials dict.
        loop: Event loop for scheduling async callbacks from
            the synchronous executor thread.
        settle_delay: Seconds to wait after each action for page to settle.
        max_steps: Maximum VLM analysis steps before aborting.
    """

    def __init__(
        self,
        vlm: VLMClient,
        profile: HumanProfile | None = None,
        otp_callback: Callable | None = None,
        credential_callback: Callable | None = None,
        loop: asyncio.AbstractEventLoop | None = None,
        settle_delay: float | None = None,
        max_steps: int = 60,
        debug: bool = True,
    ) -> None:
        self.vlm = vlm
        self.profile = profile or NORMAL
        self._otp_callback = otp_callback
        self._credential_callback = credential_callback
        self._loop = loop
        if settle_delay is not None:
            self.settle_delay = settle_delay
        else:
            self.settle_delay = float(os.environ.get('SETTLE_DELAY', '2.5'))
        self.max_steps = max_steps
        self._debug = debug
        self._otp_was_used = False

    def run(
        self,
        service: str,
        action: str,
        credentials: dict[str, str],
        job_id: str = '',
        plan_tier: str = '',
        user_npub: str = '',
    ) -> ExecutionResult:
        """Execute a cancel/resume flow for the given service.

        Args:
            service: Service name (e.g. 'netflix').
            action: Flow type ('cancel' or 'resume').
            credentials: Dict with 'email', 'pass', etc.
            job_id: Job identifier for logging and OTP requests.
            plan_tier: Plan tier for resume flows (e.g. 'premium').
            user_npub: User npub for debug trace metadata.

        Returns:
            ExecutionResult with success/failure, duration, billing_date, etc.
        """
        t0 = time.monotonic()
        inference_count = 0
        step_count = 0

        def _result(success: bool, error_message: str = '', **kw) -> ExecutionResult:
            return ExecutionResult(
                job_id=job_id,
                service=service,
                flow=action,
                success=success,
                duration_seconds=time.monotonic() - t0,
                step_count=step_count,
                inference_count=inference_count,
                error_message=error_message,
                otp_required=self._otp_was_used,
                **kw,
            )

        if service not in SERVICE_URLS:
            return _result(False, f'Unknown service: {service}')

        DebugTrace.prune_old()

        start_url = SERVICE_URLS[service]
        session = None
        billing_date = None
        error_message = ''
        trace_meta = {'service': service, 'action': action}
        if user_npub:
            trace_meta['user_npub'] = user_npub
        trace = DebugTrace(job_id, enabled=self._debug and bool(job_id),
                           metadata=trace_meta)

        try:
            # Launch Chrome (create_session handles its own gui_lock internally)
            session = browser.create_session()
            log.info('Chrome launched (PID %d) for job %s', session.pid, job_id)

            # Navigate to login page (navigate handles its own gui_lock internally)
            browser.navigate(session, start_url, fast=True)
            step_count += 1

            # Optional pre-login scroll: push distracting nav elements
            # out of view so the VLM focuses on the main CTA.
            pre_scroll = PRE_LOGIN_SCROLL.get(service, 0)
            if pre_scroll:
                time.sleep(0.5)
                with gui_lock:
                    focus_window_by_pid(session.pid)
                    scroll_mod.scroll('down', pre_scroll)

            # Build prompt chain
            prompts = [build_signin_prompt(service)]
            labels = ['sign-in']
            if action == 'cancel':
                prompts.append(build_cancel_prompt(service))
                labels.append('cancel')
            elif action == 'resume':
                prompts.append(build_resume_prompt(service, plan_tier))
                labels.append('resume')
            else:
                return _result(False, f'Unknown action: {action}')

            prompt_idx = 0
            stuck = _StuckDetector()
            last_click_screen_bbox = None
            pending_action = None
            used_account_fallback = False
            last_typed_cred_key = None
            captured_billing_date = None
            consecutive_vlm_errors = 0

            for iteration in range(self.max_steps):
                # Wall-clock timeout guard
                if time.monotonic() - t0 > TOTAL_EXECUTION_TIMEOUT:
                    error_message = f'Total execution timeout ({TOTAL_EXECUTION_TIMEOUT}s) exceeded'
                    log.warning('Job %s: %s', job_id, error_message)
                    return _result(False, error_message)

                # -------------------------------------------------------
                # Phase 1 [lock]: Execute pending action from previous
                # iteration. Restore cursor first so hover menus survive.
                # -------------------------------------------------------
                if pending_action is not None:
                    pa_type = pending_action['type']
                    if pa_type != 'wait':
                        with gui_lock:
                            if last_click_screen_bbox is not None:
                                if _restore_cursor(last_click_screen_bbox, session):
                                    time.sleep(0.2)
                            focus_window_by_pid(session.pid)

                            if pa_type == 'click':
                                _click_bbox(
                                    pending_action['bbox'], session,
                                    chrome_offset=pending_action['chrome_offset'],
                                )
                                last_click_screen_bbox = _bbox_to_screen(
                                    pending_action['bbox'], session,
                                    chrome_offset=pending_action['chrome_offset'],
                                )
                            elif pa_type == 'type_text':
                                _enter_credential(pending_action['text'])
                            elif pa_type in ('scroll_down', 'scroll_up'):
                                scroll_mod.scroll(
                                    pending_action['direction'],
                                    pending_action['scroll_clicks'],
                                )
                                last_click_screen_bbox = None
                            elif pa_type == 'press_key':
                                keyboard.press_key(pending_action['key'])

                        step_count += 1

                        # Auto-type after click (separate lock acquisition)
                        if pa_type == 'click' and pending_action.get('auto_value'):
                            time.sleep(0.3)
                            with gui_lock:
                                focus_window_by_pid(session.pid)
                                keyboard.hotkey('command', 'a')
                                time.sleep(0.1)
                                _enter_credential(pending_action['auto_value'])
                            step_count += 1

                        # Phase 2 [no lock]: Settle delay
                        time.sleep(self.settle_delay)

                        # After profile selection, jump to account page
                        # instead of making the VLM find the account icon.
                        if (pa_type == 'click'
                                and pending_action.get('is_profile_click')
                                and not used_account_fallback):
                            account_url = ACCOUNT_URLS.get(service)
                            if account_url:
                                time.sleep(self.settle_delay)
                                browser.navigate(session, account_url)
                                zoom = ACCOUNT_ZOOM_STEPS.get(
                                    service, ACCOUNT_ZOOM_DEFAULT)
                                if zoom:
                                    browser.zoom_out(session, steps=zoom)
                                used_account_fallback = True
                                step_count += 1
                                last_click_screen_bbox = None
                                log.info('Job %s: post-profile jump to %s',
                                         job_id, account_url)

                    pending_action = None

                # -------------------------------------------------------
                # Phase 3 [lock]: Restore cursor + take screenshot.
                # Grouping these under one lock acquisition prevents
                # another job from displacing the cursor between restore
                # and capture.
                # -------------------------------------------------------
                try:
                    with gui_lock:
                        if last_click_screen_bbox is not None:
                            if _restore_cursor(last_click_screen_bbox, session):
                                log.debug('Job %s: cursor restored before screenshot',
                                          job_id)
                                time.sleep(0.3)
                        browser.get_session_window(session)
                        raw_b64 = ss.capture_to_base64(session.window_id)
                except RuntimeError as exc:
                    error_message = f'Chrome window lost: {exc}'
                    log.warning('Job %s: %s', job_id, error_message)
                    return _result(False, error_message)

                # Derive display scale from the actual screenshot rather
                # than a cached Quartz value. screencapture captures at
                # physical pixel resolution; bounds are in screen points.
                try:
                    raw_w, _ = ss.png_dimensions(raw_b64)
                    bounds_w = session.bounds.get('width', 1)
                    effective_scale = raw_w / bounds_w if bounds_w else 1.0
                    coords.set_display_scale(effective_scale)
                except (ValueError, Exception):
                    pass  # keep existing override (tests use non-PNG stubs)

                screenshot_b64, chrome_height_px = crop_browser_chrome(raw_b64)

                # -------------------------------------------------------
                # Phase 4 [no lock]: VLM inference
                # -------------------------------------------------------
                current_prompt = prompts[prompt_idx]
                current_label = labels[prompt_idx]

                try:
                    vlm_t0 = time.monotonic()
                    response, scale_factor = self.vlm.analyze(
                        screenshot_b64, current_prompt,
                    )
                    vlm_response_ms = round((time.monotonic() - vlm_t0) * 1000)
                    inference_count += 1
                    consecutive_vlm_errors = 0
                except Exception as exc:
                    consecutive_vlm_errors += 1
                    log.warning('VLM error on iteration %d (%d consecutive): %s',
                                iteration, consecutive_vlm_errors, exc)
                    sent_b64 = getattr(self.vlm, 'last_sent_image_b64', '')
                    trace.save_step(iteration, screenshot_b64, None,
                                    phase=current_label,
                                    sent_image_b64=sent_b64,
                                    prompt=current_prompt)
                    if consecutive_vlm_errors >= 3:
                        error_message = f'VLM returned unparseable output {consecutive_vlm_errors} times'
                        log.warning('Job %s: %s', job_id, error_message)
                        return _result(False, error_message)
                    continue

                sent_b64 = getattr(self.vlm, 'last_sent_image_b64', '')
                trace.save_step(iteration, screenshot_b64, response,
                                phase=current_label,
                                scale_factor=scale_factor,
                                diagnostics={
                                    'window_bounds': dict(session.bounds),
                                    'display_scale': coords._get_display_scale(),
                                    'chrome_offset_px': chrome_height_px,
                                    'vlm_scale_factor': scale_factor,
                                    'vlm_max_width': self.vlm._max_image_width,
                                    'vlm_coord_normalize': self.vlm._normalized_coords,
                                    'vlm_coord_yx': self.vlm._coord_yx,
                                    'vlm_coord_square_pad': self.vlm._coord_square_pad,
                                    'vlm_response_ms': vlm_response_ms,
                                    'last_click_screen_bbox': last_click_screen_bbox,
                                },
                                sent_image_b64=sent_b64,
                                prompt=current_prompt)

                # -------------------------------------------------------
                # Phase 5 [no lock]: Parse result, resolve credentials,
                # build pending_action for next iteration.
                # -------------------------------------------------------

                # --- Sign-in phase ---
                if current_label == 'sign-in':
                    page_type = response.get('page_type', 'unknown')

                    if stuck.check(page_type, page_type, screenshot_b64):
                        error_message = f'Stuck during sign-in (page_type={page_type} repeated)'
                        log.warning('Job %s: %s', job_id, error_message)
                        return _result(False, error_message)

                    result = self._execute_signin_page(
                        response, scale_factor, session,
                        screenshot_b64, chrome_height_px,
                        credentials, job_id, service,
                    )
                    step_count += 1

                    if result == 'done':
                        if prompt_idx < len(prompts) - 1:
                            prompt_idx += 1
                            stuck.reset()
                            log.info('Job %s: sign-in complete, moving to %s',
                                     job_id, labels[prompt_idx])

                            # Navigate directly to the account page
                            # instead of letting the VLM click through
                            # menus. Saves inference calls and bandwidth.
                            account_url = ACCOUNT_URLS.get(service)
                            if account_url and ACCOUNT_URL_JUMP.get(service, True):
                                browser.navigate(session, account_url)
                                zoom = ACCOUNT_ZOOM_STEPS.get(service, ACCOUNT_ZOOM_DEFAULT)
                                if zoom:
                                    browser.zoom_out(session, steps=zoom)
                                used_account_fallback = True
                                step_count += 1
                                log.info('Job %s: navigated to %s',
                                         job_id, account_url)

                            continue
                        else:
                            # Sign-in was the only phase (shouldn't happen)
                            break
                    elif result == 'credential_invalid':
                        error_message = 'Sign-in failed: credentials rejected by service'
                        log.warning('Job %s: %s', job_id, error_message)
                        return _result(False, error_message, error_code='credential_invalid')
                    elif result == 'captcha':
                        error_message = 'CAPTCHA detected during sign-in'
                        log.warning('Job %s: %s', job_id, error_message)
                        return _result(False, error_message, error_code='captcha')
                    elif result == 'need_human':
                        error_message = 'Sign-in requires human intervention'
                        log.warning('Job %s: %s', job_id, error_message)
                        return _result(False, error_message)
                    # 'continue': take another screenshot
                    continue

                # --- Cancel / Resume phase ---
                state = response.get('state', '')
                vlm_action = response.get('action', '')
                target_desc = response.get('target_description', '')
                click_pt = response.get('click_point')
                text_to_type = response.get('text_to_type', '')
                key_to_press = response.get('key_to_press', '')

                # The VLM returns a "completed" boolean indicating whether
                # the cancel/resume already succeeded. Smaller models may
                # still pick a click action (e.g. survey "Done" button)
                # even when they correctly identify completion. Trust the
                # structured boolean over the action choice.
                if response.get('completed') and vlm_action != 'done':
                    log.info('Job %s: VLM reported completed=true but action=%s, overriding to done',
                             job_id, vlm_action)
                    vlm_action = 'done'

                # Capture billing date from any cancel/resume response
                mid_billing = response.get('billing_end_date')
                if mid_billing:
                    captured_billing_date = mid_billing
                    log.info('Job %s: captured billing_date=%s from mid-flow screen',
                             job_id, mid_billing)

                if vlm_action == 'done':
                    billing_date = mid_billing or captured_billing_date
                    if not billing_date and action == 'resume':
                        billing_date = _next_month_date().isoformat()
                        log.info('Job %s: no billing date found, defaulting to next month: %s',
                                 job_id, billing_date)
                    log.info('Job %s: flow complete (billing_date=%s)',
                             job_id, billing_date)
                    trace.cleanup_success()
                    return _result(True, billing_date=billing_date)

                if 'need_human' in state or vlm_action == 'need_human':
                    error_message = f'Needs human intervention: {response.get("state", "unknown")}'
                    log.warning('Job %s: %s', job_id, error_message)
                    return _result(False, error_message)

                if stuck.check(state, vlm_action, screenshot_b64):
                    account_url = ACCOUNT_URLS.get(service)
                    if account_url and not used_account_fallback:
                        log.info('Job %s: stuck, navigating to %s',
                                 job_id, account_url)
                        browser.navigate(session, account_url)
                        zoom = ACCOUNT_ZOOM_STEPS.get(service, ACCOUNT_ZOOM_DEFAULT)
                        if zoom:
                            browser.zoom_out(session, steps=zoom)
                        # Dismiss any "Leave page?" beforeunload dialog
                        with gui_lock:
                            focus_window_by_pid(session.pid)
                            keyboard.press_key('return')
                        time.sleep(self.settle_delay)
                        used_account_fallback = True
                        stuck.reset()
                        last_click_screen_bbox = None
                        pending_action = None
                        last_typed_cred_key = None
                        continue
                    error_message = f'Stuck during {current_label} (state={state}, action={vlm_action})'
                    log.warning('Job %s: %s', job_id, error_message)
                    return _result(False, error_message)

                # Reset typed-credential tracking when action changes
                if vlm_action != 'type_text':
                    last_typed_cred_key = None

                # Build pending_action (credentials resolved NOW, outside lock)
                if vlm_action == 'click' and click_pt:
                    scaled_pt = [int(c * scale_factor) for c in click_pt]
                    auto_value = None
                    auto_hint = _infer_credential_from_target(target_desc)
                    if auto_hint:
                        template, actual_value, _ = _resolve_credential(
                            auto_hint, credentials,
                        )
                        if not actual_value and template.startswith('{'):
                            cred_key = template.strip('{}')
                            value = self._request_credential(job_id, service, cred_key)
                            if value:
                                credentials[cred_key] = value
                                actual_value = value
                                stuck.reset()
                        auto_value = actual_value or None
                    pending_action = {
                        'type': 'click',
                        'bbox': scaled_pt,
                        'chrome_offset': chrome_height_px,
                        'auto_value': auto_value,
                        'is_profile_click': (
                            'profile' in target_desc.lower()
                            and 'add' not in target_desc.lower()
                        ),
                    }

                elif vlm_action == 'type_text':
                    template, actual_value, _ = _resolve_credential(
                        text_to_type, credentials,
                    )
                    cred_key = template.strip('{}') if template.startswith('{') else None
                    if not actual_value and cred_key:
                        value = self._request_credential(job_id, service, cred_key)
                        if value:
                            credentials[cred_key] = value
                            actual_value = value
                            stuck.reset()
                    if actual_value:
                        if cred_key and cred_key == last_typed_cred_key:
                            log.info('Job %s: credential %s already typed, waiting',
                                     job_id, cred_key)
                            pending_action = {'type': 'wait'}
                        elif click_pt:
                            # Click the target field first, then type
                            scaled_pt = [int(c * scale_factor) for c in click_pt]
                            pending_action = {
                                'type': 'click',
                                'bbox': scaled_pt,
                                'chrome_offset': chrome_height_px,
                                'auto_value': actual_value,
                            }
                            last_typed_cred_key = cred_key
                        else:
                            pending_action = {
                                'type': 'type_text',
                                'text': actual_value,
                            }
                            last_typed_cred_key = cred_key
                    else:
                        pending_action = {'type': 'wait'}

                elif vlm_action in ('scroll_down', 'scroll_up'):
                    direction = 'down' if vlm_action == 'scroll_down' else 'up'
                    px_per_click = 30
                    window_h = session.bounds.get('height', 900)
                    scroll_clicks = max(5, int(window_h * 0.75 / px_per_click))
                    pending_action = {
                        'type': vlm_action,
                        'direction': direction,
                        'scroll_clicks': scroll_clicks,
                    }

                elif vlm_action == 'press_key' and key_to_press:
                    pending_action = {
                        'type': 'press_key',
                        'key': key_to_press,
                    }

                elif vlm_action == 'wait':
                    pending_action = {'type': 'wait'}

                else:
                    log.warning('Job %s: unknown VLM action: %s', job_id, vlm_action)
                    pending_action = {'type': 'wait'}

            else:
                # Max steps reached
                error_message = f'Max steps ({self.max_steps}) reached'
                log.warning('Job %s: %s', job_id, error_message)
                return _result(False, error_message)

            # Should not reach here (loop exits via return or break)
            return _result(False, error_message or 'Unexpected loop exit')

        finally:
            _zero_credentials(credentials)

            # Close Chrome
            if session is not None:
                try:
                    browser.close_session(session)
                    log.info('Chrome closed for job %s', job_id)
                except Exception as exc:
                    log.warning('Failed to close Chrome for job %s: %s', job_id, exc)

    # ------------------------------------------------------------------
    # Sign-in page dispatch
    # ------------------------------------------------------------------

    def _execute_signin_page(
        self,
        response: dict,
        scale_factor: float,
        session,
        screenshot_b64: str,
        chrome_offset: int,
        credentials: dict[str, str],
        job_id: str,
        service: str = '',
    ) -> str:
        """Handle a sign-in page classification response.

        Returns: 'continue', 'done', 'need_human', 'captcha', or 'credential_invalid'.

        GUI actions within each page type are wrapped in gui_lock.
        OTP requests happen OUTSIDE the lock so the lock is free for
        other concurrent jobs during the (potentially minutes-long) wait.
        """

        def scale(pt):
            if pt and len(pt) in (2, 4):
                return [int(c * scale_factor) for c in pt]
            return None

        page_type = response.get('page_type', 'unknown')
        email_pt = scale(response.get('email_point'))
        password_pt = scale(response.get('password_point'))
        button_pt = scale(response.get('button_point'))
        profile_pt = scale(response.get('profile_point'))

        code_pt = scale(response.get('code_point'))

        log.debug('Sign-in page_type=%s, email=%s, pass=%s, button=%s',
                  page_type, email_pt, password_pt, button_pt)

        if page_type == 'credential_error':
            return 'credential_invalid'

        if page_type in ('signed_in', 'profile_select'):
            return 'done'

        if page_type == 'spinner':
            return 'continue'

        if page_type == 'captcha':
            return 'captcha'

        # Email link: no operator, fail the job
        if page_type == 'email_link':
            return 'need_human'

        # Code entry: request OTP OUTSIDE gui_lock, then enter code inside lock
        if page_type in ('verification_code', 'email_code_single',
                         'email_code_multi', 'phone_code_single',
                         'phone_code_multi'):
            # OTP wait: no GUI lock held (other jobs can use GUI freely)
            code = self._request_otp(job_id, service)
            if not code:
                return 'need_human'

            # Enter OTP code: acquire lock, focus, paste, submit
            with gui_lock:
                focus_window_by_pid(session.pid)
                _clipboard_copy(code)

                if code_pt:
                    _click_bbox(code_pt, session, chrome_offset=chrome_offset)
                    time.sleep(0.5)
                keyboard.hotkey('command', 'v')
                time.sleep(0.3)

                if button_pt:
                    time.sleep(0.3)
                    _click_bbox(button_pt, session, chrome_offset=chrome_offset)
                else:
                    time.sleep(0.2)
                    keyboard.press_key('enter')
            # Settle outside gui_lock: OTP verification takes time
            time.sleep(self.settle_delay * 2)
            return 'continue'

        # Unknown state with recovery actions
        if page_type == 'unknown':
            actions = response.get('actions') or []
            if not actions:
                return 'need_human'
            with gui_lock:
                focus_window_by_pid(session.pid)
                for act in actions:
                    act_type = act.get('action', '')
                    pt = scale(act.get('point'))
                    if act_type in ('click', 'dismiss') and pt:
                        _click_bbox(pt, session, chrome_offset=chrome_offset)
                        time.sleep(0.3)
            time.sleep(self.settle_delay)
            return 'continue'

        # --- Credential entry: driven by available coordinates ---
        # Instead of trusting page_type (user_pass, user_only, pass_only,
        # button_only), act on which points the VLM returned. This avoids
        # wasted steps from misclassification.

        if email_pt or password_pt:
            with gui_lock:
                focus_window_by_pid(session.pid)
                email_pasted = False

                if email_pt:
                    _click_bbox(email_pt, session, chrome_offset=chrome_offset)
                    time.sleep(0.3)
                    keyboard.hotkey('command', 'a')
                    time.sleep(0.1)
                    email_val = credentials.get('email', '')
                    if email_val:
                        email_pasted = _enter_credential(email_val)

                if password_pt:
                    if email_pasted:
                        # Simulate password manager: app switch, wait, refocus
                        time.sleep(random.uniform(0.3, 0.6))
                        _simulate_app_switch(session)
                        time.sleep(random.uniform(2.0, 4.0))
                        focus_window_by_pid(session.pid)
                    _click_bbox(password_pt, session,
                                chrome_offset=chrome_offset)
                    time.sleep(0.2)
                    keyboard.hotkey('command', 'a')
                    time.sleep(0.1)
                    pass_val = credentials.get('pass', '')
                    if pass_val:
                        _clipboard_copy(pass_val)
                        keyboard.hotkey('command', 'v')
                        time.sleep(0.15)

                # Submit: always press Enter after filling fields.
                # More reliable than clicking button_pt, which the VLM
                # can misidentify (e.g. "Sign up" instead of "Sign In").
                time.sleep(0.2)
                keyboard.press_key('enter')
            time.sleep(self.settle_delay)
            return 'continue'

        if button_pt:
            with gui_lock:
                focus_window_by_pid(session.pid)
                _click_bbox(button_pt, session, chrome_offset=chrome_offset)
            time.sleep(self.settle_delay)
            return 'continue'

        # Fallback
        log.warning('Unhandled sign-in page_type=%s', page_type)
        return 'continue'

    # ------------------------------------------------------------------
    # OTP bridge
    # ------------------------------------------------------------------

    def _request_otp(self, job_id: str, service: str) -> str | None:
        """Request OTP code via the async callback.

        Bridges async server.request_otp from the synchronous executor thread.
        This call blocks until the user provides the OTP (up to 15 min).
        It does NOT hold gui_lock, so other jobs can use the GUI freely.
        """
        self._otp_was_used = True
        if self._otp_callback is None or self._loop is None:
            log.warning('OTP needed but no callback configured')
            return None

        try:
            future = asyncio.run_coroutine_threadsafe(
                self._otp_callback(job_id, service),
                self._loop,
            )
            return future.result(timeout=900)  # 15 min, matching server timeout
        except Exception as exc:
            log.error('OTP callback failed: %s', exc)
            return None

    # ------------------------------------------------------------------
    # Credential bridge
    # ------------------------------------------------------------------

    def _request_credential(
        self, job_id: str, service: str, credential_name: str,
    ) -> str | None:
        """Request a missing credential via the async callback.

        Same bridge pattern as _request_otp: schedules the async callback
        on the event loop from the synchronous executor thread.
        Does NOT hold gui_lock.
        """
        if self._credential_callback is None or self._loop is None:
            log.warning('Credential %s needed but no callback configured', credential_name)
            return None

        try:
            future = asyncio.run_coroutine_threadsafe(
                self._credential_callback(job_id, service, credential_name),
                self._loop,
            )
            return future.result(timeout=900)  # 15 min
        except Exception as exc:
            log.error('Credential callback failed for %s: %s', credential_name, exc)
            return None
