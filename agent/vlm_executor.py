"""VLM-driven production executor.

Navigates streaming service cancel/resume flows using VLM screenshot analysis.
Two-phase prompt chain: sign-in, then cancel/resume.

The VLM classifies each screenshot and returns one action. For sign-in pages,
the VLM classifies the page type and the executor dispatches multi-step
sequences locally (click, type, tab, enter) without additional VLM calls.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import random
import subprocess
import time
from typing import Callable

from agent import browser
from agent import screenshot as ss
from agent.config import SERVICE_URLS
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
    """Type or paste a credential value. Returns True if paste was used."""
    if random.random() < 0.4:
        _clipboard_copy(value)
        keyboard.hotkey('command', 'v')
        time.sleep(0.15)
        return True
    else:
        keyboard.type_text(value, speed='medium', accuracy='high')
        return False


def _simulate_app_switch(session) -> None:
    """Move mouse toward the dock and defocus Chrome."""
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


def _click_bbox(bbox, session, chrome_offset: int = 0) -> None:
    """Click inside a bbox with inset and center-biased Gaussian randomization."""
    bw = bbox[2] - bbox[0]
    bh = bbox[3] - bbox[1]
    inset_x = bw * 0.10
    inset_y = bh * 0.10
    safe_x1 = bbox[0] + inset_x
    safe_y1 = bbox[1] + inset_y
    safe_x2 = bbox[2] - inset_x
    safe_y2 = bbox[3] - inset_y
    cx = (safe_x1 + safe_x2) / 2 + random.gauss(0, bw * 0.10)
    cy = (safe_y1 + safe_y2) / 2 + random.gauss(0, bh * 0.10)
    cx = max(safe_x1, min(cx, safe_x2))
    cy = max(safe_y1, min(cy, safe_y2))

    sx, sy = coords.image_to_screen(cx, cy, session.bounds,
                                    chrome_offset=chrome_offset)
    mouse.click(sx, sy, fast=True)


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
        settle_delay: float = 2.5,
        max_steps: int = 60,
    ) -> None:
        self.vlm = vlm
        self.profile = profile or NORMAL
        self._otp_callback = otp_callback
        self._credential_callback = credential_callback
        self._loop = loop
        self.settle_delay = settle_delay
        self.max_steps = max_steps

    def run(
        self,
        service: str,
        action: str,
        credentials: dict[str, str],
        job_id: str = '',
        plan_tier: str = '',
    ) -> ExecutionResult:
        """Execute a cancel/resume flow for the given service.

        Args:
            service: Service name (e.g. 'netflix').
            action: Flow type ('cancel' or 'resume').
            credentials: Dict with 'email', 'pass', etc.
            job_id: Job identifier for logging and OTP requests.
            plan_tier: Plan tier for resume flows (e.g. 'premium').

        Returns:
            ExecutionResult with success/failure, duration, billing_date, etc.
        """
        if service not in SERVICE_URLS:
            return ExecutionResult(
                job_id=job_id,
                service=service,
                flow=action,
                success=False,
                duration_seconds=0.0,
                step_count=0,
                inference_count=0,
                playbook_version=0,
                error_message=f'Unknown service: {service}',
            )

        start_url = SERVICE_URLS[service]
        t0 = time.monotonic()
        session = None
        inference_count = 0
        step_count = 0
        billing_date = None
        error_message = ''

        try:
            # Launch Chrome
            session = browser.create_session()
            log.info('Chrome launched (PID %d) for job %s', session.pid, job_id)

            # Navigate to login page
            browser.navigate(session, start_url, fast=True)
            step_count += 1

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
                return ExecutionResult(
                    job_id=job_id,
                    service=service,
                    flow=action,
                    success=False,
                    duration_seconds=time.monotonic() - t0,
                    step_count=step_count,
                    inference_count=inference_count,
                    playbook_version=0,
                    error_message=f'Unknown action: {action}',
                )

            prompt_idx = 0
            stuck = _StuckDetector()

            for iteration in range(self.max_steps):
                time.sleep(self.settle_delay)

                # Capture and crop browser chrome
                browser.get_session_window(session)
                raw_b64 = ss.capture_to_base64(session.window_id)
                screenshot_b64, chrome_height_px = crop_browser_chrome(raw_b64)

                # Ask VLM
                current_prompt = prompts[prompt_idx]
                current_label = labels[prompt_idx]

                try:
                    response, scale_factor = self.vlm.analyze(
                        screenshot_b64, current_prompt,
                    )
                    inference_count += 1
                except Exception as exc:
                    log.warning('VLM error on iteration %d: %s', iteration, exc)
                    continue

                # --- Sign-in phase ---
                if current_label == 'sign-in':
                    page_type = response.get('page_type', 'unknown')

                    if stuck.check(page_type, page_type, screenshot_b64):
                        error_message = f'Stuck during sign-in (page_type={page_type} repeated)'
                        log.warning('Job %s: %s', job_id, error_message)
                        return ExecutionResult(
                            job_id=job_id,
                            service=service,
                            flow=action,
                            success=False,
                            duration_seconds=time.monotonic() - t0,
                            step_count=step_count,
                            inference_count=inference_count,
                            playbook_version=0,
                            error_message=error_message,
                        )

                    result = self._execute_signin_page(
                        response, scale_factor, session,
                        screenshot_b64, chrome_height_px,
                        credentials, job_id,
                    )
                    step_count += 1

                    if result == 'done':
                        if prompt_idx < len(prompts) - 1:
                            prompt_idx += 1
                            stuck.reset()
                            log.info('Job %s: sign-in complete, moving to %s',
                                     job_id, labels[prompt_idx])
                            continue
                        else:
                            # Sign-in was the only phase (shouldn't happen)
                            break
                    elif result == 'captcha':
                        error_message = 'CAPTCHA detected during sign-in'
                        log.warning('Job %s: %s', job_id, error_message)
                        return ExecutionResult(
                            job_id=job_id,
                            service=service,
                            flow=action,
                            success=False,
                            duration_seconds=time.monotonic() - t0,
                            step_count=step_count,
                            inference_count=inference_count,
                            playbook_version=0,
                            error_message=error_message,
                        )
                    elif result == 'need_human':
                        error_message = 'Sign-in requires human intervention'
                        log.warning('Job %s: %s', job_id, error_message)
                        return ExecutionResult(
                            job_id=job_id,
                            service=service,
                            flow=action,
                            success=False,
                            duration_seconds=time.monotonic() - t0,
                            step_count=step_count,
                            inference_count=inference_count,
                            playbook_version=0,
                            error_message=error_message,
                        )
                    # 'continue': take another screenshot
                    continue

                # --- Cancel / Resume phase ---
                state = response.get('state', '')
                vlm_action = response.get('action', '')
                target_desc = response.get('target_description', '')
                bbox = response.get('bounding_box')
                text_to_type = response.get('text_to_type', '')
                key_to_press = response.get('key_to_press', '')

                if vlm_action == 'done':
                    billing_date = response.get('billing_end_date')
                    log.info('Job %s: flow complete (billing_date=%s)',
                             job_id, billing_date)
                    return ExecutionResult(
                        job_id=job_id,
                        service=service,
                        flow=action,
                        success=True,
                        duration_seconds=time.monotonic() - t0,
                        step_count=step_count,
                        inference_count=inference_count,
                        playbook_version=0,
                        billing_date=billing_date,
                    )

                if 'need_human' in state or vlm_action == 'need_human':
                    error_message = f'Needs human intervention: {response.get("reasoning", "")}'
                    log.warning('Job %s: %s', job_id, error_message)
                    return ExecutionResult(
                        job_id=job_id,
                        service=service,
                        flow=action,
                        success=False,
                        duration_seconds=time.monotonic() - t0,
                        step_count=step_count,
                        inference_count=inference_count,
                        playbook_version=0,
                        error_message=error_message,
                    )

                if stuck.check(state, vlm_action, screenshot_b64):
                    error_message = f'Stuck during {current_label} (state={state}, action={vlm_action})'
                    log.warning('Job %s: %s', job_id, error_message)
                    return ExecutionResult(
                        job_id=job_id,
                        service=service,
                        flow=action,
                        success=False,
                        duration_seconds=time.monotonic() - t0,
                        step_count=step_count,
                        inference_count=inference_count,
                        playbook_version=0,
                        error_message=error_message,
                    )

                # Execute action
                if vlm_action == 'click' and bbox:
                    scaled_bbox = [int(c * scale_factor) for c in bbox]
                    _click_bbox(scaled_bbox, session, chrome_offset=chrome_height_px)
                    step_count += 1

                    # Auto-type after clicking input fields
                    auto_hint = _infer_credential_from_target(target_desc)
                    if auto_hint:
                        time.sleep(0.3)
                        keyboard.hotkey('command', 'a')
                        time.sleep(0.1)
                        template, actual_value, _ = _resolve_credential(
                            auto_hint, credentials,
                        )
                        if not actual_value and template.startswith('{'):
                            cred_key = template.strip('{}')
                            value = self._request_credential(job_id, service, cred_key)
                            if value:
                                credentials[cred_key] = value
                                actual_value = value
                        if actual_value:
                            _enter_credential(actual_value)
                        step_count += 1

                elif vlm_action == 'type_text':
                    template, actual_value, _ = _resolve_credential(
                        text_to_type, credentials,
                    )
                    if not actual_value and template.startswith('{'):
                        cred_key = template.strip('{}')
                        value = self._request_credential(job_id, service, cred_key)
                        if value:
                            credentials[cred_key] = value
                            actual_value = value
                    if actual_value:
                        _enter_credential(actual_value)
                    step_count += 1

                elif vlm_action in ('scroll_down', 'scroll_up'):
                    direction = 'down' if vlm_action == 'scroll_down' else 'up'
                    px_per_click = 30
                    window_h = session.bounds.get('height', 900)
                    scroll_clicks = max(5, int(window_h * 0.75 / px_per_click))
                    scroll_mod.scroll(direction, scroll_clicks)
                    step_count += 1

                elif vlm_action == 'press_key' and key_to_press:
                    keyboard.press_key(key_to_press)
                    step_count += 1

                elif vlm_action == 'wait':
                    pass  # just loop and take another screenshot

                else:
                    log.warning('Job %s: unknown VLM action: %s', job_id, vlm_action)

            else:
                # Max steps reached
                error_message = f'Max steps ({self.max_steps}) reached'
                log.warning('Job %s: %s', job_id, error_message)
                return ExecutionResult(
                    job_id=job_id,
                    service=service,
                    flow=action,
                    success=False,
                    duration_seconds=time.monotonic() - t0,
                    step_count=step_count,
                    inference_count=inference_count,
                    playbook_version=0,
                    error_message=error_message,
                )

            # Should not reach here (loop exits via return or break)
            return ExecutionResult(
                job_id=job_id,
                service=service,
                flow=action,
                success=False,
                duration_seconds=time.monotonic() - t0,
                step_count=step_count,
                inference_count=inference_count,
                playbook_version=0,
                error_message=error_message or 'Unexpected loop exit',
            )

        finally:
            # Zero credentials
            for key in list(credentials.keys()):
                credentials[key] = '\x00' * len(credentials[key])
            credentials.clear()

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
    ) -> str:
        """Handle a sign-in page classification response.

        Returns: 'continue', 'done', 'need_human', or 'captcha'.
        """

        def scale(box):
            if box and len(box) == 4:
                return [int(c * scale_factor) for c in box]
            return None

        page_type = response.get('page_type', 'unknown')
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

        log.debug('Sign-in page_type=%s, email=%s, pass=%s, button=%s',
                  page_type, email_box, password_box, button_box)

        if page_type == 'signed_in':
            return 'done'

        if page_type == 'spinner':
            return 'continue'

        if page_type == 'captcha':
            return 'captcha'

        # Email link: no operator, fail the job
        if page_type == 'email_link':
            return 'need_human'

        # Code entry: request OTP via callback
        if page_type in ('email_code_single', 'email_code_multi',
                         'phone_code_single', 'phone_code_multi'):
            code = self._request_otp(job_id, credentials.get('email', ''))
            if not code:
                return 'need_human'

            # Focus Chrome and paste code
            focus_window_by_pid(session.pid)
            _clipboard_copy(code)

            if code_boxes:
                box = code_boxes[0]['box']
                _click_bbox(box, session, chrome_offset=chrome_offset)
                time.sleep(0.5)
            keyboard.hotkey('command', 'v')
            time.sleep(0.3)

            if button_box:
                time.sleep(0.3)
                _click_bbox(button_box, session, chrome_offset=chrome_offset)
            else:
                time.sleep(0.2)
                keyboard.press_key('enter')
            return 'continue'

        # Unknown state with recovery actions
        if page_type == 'unknown':
            actions = response.get('actions') or []
            if not actions:
                return 'need_human'
            for act in actions:
                act_type = act.get('action', '')
                box = scale(act.get('box'))
                if act_type in ('click', 'dismiss') and box:
                    _click_bbox(box, session, chrome_offset=chrome_offset)
                    time.sleep(0.5)
            return 'continue'

        if page_type == 'profile_select' and profile_box:
            _click_bbox(profile_box, session, chrome_offset=chrome_offset)
            return 'continue'

        if page_type == 'button_only' and button_box:
            _click_bbox(button_box, session, chrome_offset=chrome_offset)
            return 'continue'

        if page_type == 'user_pass' and email_box:
            # Click email, select-all, type, tab/paste password, enter
            _click_bbox(email_box, session, chrome_offset=chrome_offset)
            time.sleep(0.3)
            keyboard.hotkey('command', 'a')
            time.sleep(0.1)
            email_val = credentials.get('email', '')
            email_pasted = False
            if email_val:
                email_pasted = _enter_credential(email_val)

            if email_pasted:
                # Simulate password manager: app switch, wait, refocus
                time.sleep(random.uniform(0.3, 0.6))
                _simulate_app_switch(session)
                time.sleep(random.uniform(2.0, 4.0))
                focus_window_by_pid(session.pid)
                _click_bbox(
                    password_box or email_box, session,
                    chrome_offset=chrome_offset,
                )
                time.sleep(0.2)
                keyboard.hotkey('command', 'a')
                time.sleep(0.1)
                pass_val = credentials.get('pass', '')
                if pass_val:
                    _clipboard_copy(pass_val)
                    keyboard.hotkey('command', 'v')
                    time.sleep(0.15)
            else:
                time.sleep(0.2)
                keyboard.press_key('tab')
                time.sleep(0.2)
                keyboard.hotkey('command', 'a')
                time.sleep(0.1)
                pass_val = credentials.get('pass', '')
                if pass_val:
                    _enter_credential(pass_val)

            time.sleep(0.2)
            keyboard.press_key('enter')
            time.sleep(1.0)
            return 'continue'

        if page_type == 'user_only' and email_box:
            _click_bbox(email_box, session, chrome_offset=chrome_offset)
            time.sleep(0.3)
            keyboard.hotkey('command', 'a')
            time.sleep(0.1)
            email_val = credentials.get('email', '')
            if email_val:
                _enter_credential(email_val)
            time.sleep(0.2)
            keyboard.press_key('enter')
            time.sleep(1.0)
            return 'continue'

        if page_type == 'pass_only' and password_box:
            _click_bbox(password_box, session, chrome_offset=chrome_offset)
            time.sleep(0.3)
            keyboard.hotkey('command', 'a')
            time.sleep(0.1)
            pass_val = credentials.get('pass', '')
            if pass_val:
                _enter_credential(pass_val)
            time.sleep(0.2)
            keyboard.press_key('enter')
            time.sleep(1.0)
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
        """
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
