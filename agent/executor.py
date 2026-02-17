"""Playbook executor: core loop that steps through a playbook, drives Chrome, and calls VLM.

Usage:
    executor = PlaybookExecutor(inference_client)
    result = executor.run(playbook, job_context)
"""

from __future__ import annotations

import logging
import random
import time
from collections.abc import Callable
from pathlib import Path

from agent import browser, screenshot
from agent.browser import BrowserSession
from agent.config import (
    PAGE_LOAD_WAIT,
    SCREENSHOT_DIR,
    STEP_TIMEOUT,
    TOTAL_EXECUTION_TIMEOUT,
)
from agent.inference import InferenceClient
from agent.input import coords, keyboard, mouse, scroll, window
from agent.profile import NORMAL, HumanProfile
from agent.playbook import (
    ExecutionResult,
    JobContext,
    Playbook,
    PlaybookStep,
    StepResult,
    parse_value_and_keys,
)

log = logging.getLogger(__name__)

# Default probability for optional step chains (0.0-1.0)
OPTIONAL_CHAIN_CHANCE = 0.5


class PlaybookExecutor:
    """Reads a playbook, steps through it, uses VLM for element-finding and checkpoints."""

    def __init__(
        self,
        inference: InferenceClient,
        step_callback: Callable[[int, PlaybookStep, BrowserSession], bool] | None = None,
        profile: HumanProfile = NORMAL,
    ):
        """
        inference: VLM client (Http, Coordinate, or Mock)
        step_callback: called before each step with (index, step, session).
                       Return True to proceed, False to skip.
        profile: human behavioral profile (mouse speed, typing, accuracy, decision delay)
        """
        self._inference = inference
        self._step_callback = step_callback
        self._profile = profile
        self._total_inference_calls = 0

    def run(self, playbook: Playbook, ctx: JobContext) -> ExecutionResult:
        """Execute a full playbook. Returns ExecutionResult with metrics."""
        start = time.monotonic()
        step_results: list[StepResult] = []
        screenshots: list[dict] = []
        session: BrowserSession | None = None
        error_message = ''
        success = False

        # Ensure screenshot dir exists
        SCREENSHOT_DIR.mkdir(parents=True, exist_ok=True)

        try:
            # 1. Launch Chrome with slight size randomization
            jitter_w = random.randint(-40, 40)
            jitter_h = random.randint(-40, 40)
            session = browser.create_session(
                width=1280 + jitter_w,
                height=900 + jitter_h,
            )
            log.info(
                'Chrome session started (PID %d, %dx%d)',
                session.pid,
                session.bounds.get('width', 0),
                session.bounds.get('height', 0),
            )

            # 2. Step through the playbook
            skip_optional_chain = False

            for idx, step in enumerate(playbook.steps):
                elapsed = time.monotonic() - start
                if elapsed > TOTAL_EXECUTION_TIMEOUT:
                    error_message = (
                        f'Total execution timeout ({TOTAL_EXECUTION_TIMEOUT}s) '
                        f'exceeded at step {idx}'
                    )
                    log.error(error_message)
                    break

                # Skip disabled steps
                if step.disabled:
                    step_results.append(StepResult(
                        index=idx, action=step.action,
                        success=True, skipped=True,
                    ))
                    continue

                # Optional chain logic: consecutive optional steps share fate.
                # First optional step in a chain rolls the dice. If skipped,
                # all following optional steps skip too. Chain ends at the
                # first non-optional step.
                if step.optional:
                    if idx == 0 or not playbook.steps[idx - 1].optional:
                        # First in a new optional chain: roll the dice
                        skip_optional_chain = random.random() > OPTIONAL_CHAIN_CHANCE
                    if skip_optional_chain:
                        log.info('Skipping optional step %d (%s)', idx, step.action)
                        step_results.append(StepResult(
                            index=idx, action=step.action,
                            success=True, skipped=True,
                        ))
                        continue
                else:
                    # Non-optional step: reset chain state
                    skip_optional_chain = False

                # Interactive callback (test mode)
                if self._step_callback is not None:
                    proceed = self._step_callback(idx, step, session)
                    if not proceed:
                        step_results.append(StepResult(
                            index=idx, action=step.action,
                            success=True, skipped=True,
                        ))
                        continue

                sr = self._execute_step(idx, step, session, ctx)
                step_results.append(sr)

                # Save non-sensitive screenshot for audit log
                if sr.success and not step.is_sensitive:
                    shot = self._save_audit_screenshot(idx, session, ctx)
                    if shot:
                        screenshots.append(shot)

                if not sr.success and not step.optional:
                    error_message = f'Step {idx} ({step.action}) failed: {sr.error}'
                    log.error(error_message)
                    break
            else:
                # All steps completed
                success = not error_message

        except Exception as exc:
            error_message = f'Unhandled exception: {exc}'
            log.exception('Executor crashed')

        finally:
            # Always destroy credentials and close Chrome
            ctx.destroy()
            if session is not None:
                try:
                    browser.close_session(session)
                except Exception:
                    log.warning('Failed to close Chrome session', exc_info=True)

        duration = time.monotonic() - start
        return ExecutionResult(
            job_id=ctx.job_id,
            service=ctx.service,
            flow=ctx.flow,
            success=success,
            duration_seconds=round(duration, 2),
            step_count=len(step_results),
            inference_count=self._total_inference_calls,
            playbook_version=playbook.version,
            error_message=error_message,
            step_results=step_results,
            screenshots=screenshots,
        )

    # ------------------------------------------------------------------
    # Step dispatcher
    # ------------------------------------------------------------------

    def _execute_step(
        self, idx: int, step: PlaybookStep, session: BrowserSession, ctx: JobContext,
    ) -> StepResult:
        """Execute a single step: checkpoint (if needed), then action handler."""
        step_start = time.monotonic()
        inference_calls = 0

        try:
            # Checkpoint before action (if requested)
            if step.checkpoint and step.checkpoint_prompt:
                cp_result = self._run_checkpoint(idx, step, session)
                inference_calls += 1
                if not cp_result:
                    return StepResult(
                        index=idx, action=step.action,
                        success=False,
                        duration_seconds=round(time.monotonic() - step_start, 2),
                        inference_calls=inference_calls,
                        error=f'Checkpoint failed: page state does not match "{step.checkpoint_prompt}"',
                    )

            # Human-like pause before interactive actions
            if step.action not in ('navigate', 'wait', 'press_key'):
                lo, hi = self._profile.decision_delay
                if hi > 0:
                    time.sleep(random.uniform(lo, hi))

            # Dispatch to action handler
            handler = self._get_handler(step.action)
            calls = handler(step, session, ctx)
            inference_calls += calls

            duration = round(time.monotonic() - step_start, 2)
            return StepResult(
                index=idx, action=step.action,
                success=True, duration_seconds=duration,
                inference_calls=inference_calls,
            )

        except Exception as exc:
            duration = round(time.monotonic() - step_start, 2)
            return StepResult(
                index=idx, action=step.action,
                success=False, duration_seconds=duration,
                inference_calls=inference_calls,
                error=str(exc),
            )

    def _get_handler(self, action: str) -> Callable:
        """Map action name to handler method."""
        handlers = {
            'navigate': self._handle_navigate,
            'click': self._handle_click,
            'type_text': self._handle_type_text,
            'select_plan': self._handle_click,           # alias
            'select_payment_method': self._handle_click,  # alias
            'handle_retention': self._handle_retention,
            'verify_success': self._handle_verify_success,
            'hover': self._handle_hover,
            'scroll': self._handle_scroll,
            'press_key': self._handle_press_key,
            'wait': self._handle_wait,
        }
        handler = handlers.get(action)
        if handler is None:
            raise ValueError(f'Unknown action: {action}')
        return handler

    # ------------------------------------------------------------------
    # Action handlers (each returns number of VLM inference calls made)
    # ------------------------------------------------------------------

    def _handle_navigate(
        self, step: PlaybookStep, session: BrowserSession, ctx: JobContext,
    ) -> int:
        """Navigate to URL. No VLM calls. Always fast (URL bar typing is invisible)."""
        url = ctx.resolve_template(step.url) if step.url else ''
        if not url:
            raise ValueError('Navigate step has no URL')
        browser.navigate(session, url, fast=True)
        time.sleep(PAGE_LOAD_WAIT)
        # Refresh window bounds (pages can trigger resizes)
        browser.get_session_window(session)
        return 0

    def _handle_click(
        self, step: PlaybookStep, session: BrowserSession, ctx: JobContext,
    ) -> int:
        """Screenshot, VLM find_element (bounding box), pick random point, click. 1 VLM call."""
        screen_x, screen_y = self._find_and_convert(step, session, ctx)
        mouse.click(int(screen_x), int(screen_y), fast=self._profile.mouse_fast)
        return 1

    def _handle_type_text(
        self, step: PlaybookStep, session: BrowserSession, ctx: JobContext,
    ) -> int:
        """
        Type text into a field.

        Two modes:
        A) Self-contained: step has ref_region or target_description.
           Find the field, click it, clear it, type. 1 VLM call.
        B) Follow-on: step has neither (preceded by a click step that
           already focused the field). Just type. 0 VLM calls.

        Sensitive field invariant (mode A only):
        1. Screenshot with empty field (safe for VLM)
        2. VLM returns bounding box
        3. Click random point in box, clear field (Cmd+A, backspace)
        4. Type the value
        5. NO screenshot after typing sensitive data
        """
        inference_calls = 0

        if step.ref_region or step.target_description:
            # Mode A: find the field, click it, clear it
            screen_x, screen_y = self._find_and_convert(step, session, ctx)
            inference_calls = 1

            mouse.click(int(screen_x), int(screen_y), fast=self._profile.mouse_fast)
            time.sleep(random.uniform(0.1, 0.3))
            keyboard.hotkey('command', 'a')
            time.sleep(random.uniform(0.05, 0.15))
            keyboard.press_key('backspace')
            time.sleep(random.uniform(0.05, 0.15))

        # Resolve and type the value (strip trailing key sequences)
        raw_value = ctx.resolve_template(step.value)
        value, trailing_keys = parse_value_and_keys(raw_value)
        if value:
            keyboard.type_text(value, speed=self._profile.type_speed, accuracy=self._profile.type_accuracy)

        # Press trailing keys (tab, enter)
        for key in trailing_keys:
            time.sleep(random.uniform(0.1, 0.3))
            keyboard.press_key(key)

        return inference_calls

    def _handle_retention(
        self, step: PlaybookStep, session: BrowserSession, ctx: JobContext,
    ) -> int:
        """
        Handle retention/upsell pages during cancel flows.
        Loops up to max_repeats: checkpoint (still retention?) then find+click cancel button.
        Breaks when checkpoint says we've left the retention page.
        """
        inference_calls = 0
        max_iters = step.max_repeats if step.may_repeat else 1

        for i in range(max_iters):
            # Checkpoint: are we still on a retention page?
            still_retention = self._run_checkpoint(i, step, session)
            inference_calls += 1

            if not still_retention:
                # Left the retention page, we're through
                log.info('Retention: left retention page after %d iterations', i)
                break

            # Find and click the cancel/continue button
            screen_x, screen_y = self._find_and_convert(step, session, ctx)
            inference_calls += 1
            mouse.click(int(screen_x), int(screen_y), fast=self._profile.mouse_fast)

            # Wait for page transition
            lo, hi = step.wait_after_sec
            time.sleep(random.uniform(lo, hi))

        return inference_calls

    def _handle_verify_success(
        self, step: PlaybookStep, session: BrowserSession, ctx: JobContext,
    ) -> int:
        """Checkpoint-only: verify that the flow completed successfully. 1 VLM call."""
        prompt = step.checkpoint_prompt or f'Has the {ctx.flow} been completed successfully?'
        shot_b64 = screenshot.capture_to_base64(session.window_id)
        result = self._inference.checkpoint(shot_b64, prompt)
        self._total_inference_calls += 1

        if not result.on_track:
            raise RuntimeError(
                f'Success verification failed (confidence={result.confidence:.2f}): {result.reasoning}'
            )
        log.info('verify_success: confirmed (confidence=%.2f)', result.confidence)
        return 1

    def _handle_hover(
        self, step: PlaybookStep, session: BrowserSession, ctx: JobContext,
    ) -> int:
        """Move mouse to random point in bounding box without clicking. 1 VLM call."""
        screen_x, screen_y = self._find_and_convert(step, session, ctx)
        mouse.move_to(int(screen_x), int(screen_y), fast=self._profile.mouse_fast)
        return 1

    def _handle_scroll(
        self, step: PlaybookStep, session: BrowserSession, ctx: JobContext,
    ) -> int:
        """Scroll up or down. No VLM calls."""
        # Ensure correct Chrome instance is focused
        window.focus_window_by_pid(session.pid)

        # Parse direction and amount from target_description or defaults
        direction = 'down'
        amount = 3
        desc = step.target_description.lower()
        if 'up' in desc:
            direction = 'up'
        # Try to extract a number
        for word in desc.split():
            if word.isdigit():
                amount = int(word)
                break
        scroll.scroll(direction, amount)
        return 0

    def _handle_press_key(
        self, step: PlaybookStep, session: BrowserSession, ctx: JobContext,
    ) -> int:
        """Press a single key. No VLM calls."""
        key = step.value or step.target_description
        if not key:
            raise ValueError('press_key step has no key specified')
        keyboard.press_key(key)
        return 0

    def _handle_wait(
        self, step: PlaybookStep, session: BrowserSession, ctx: JobContext,
    ) -> int:
        """Sleep for a random duration within the step's wait_after_sec range."""
        lo, hi = step.wait_after_sec
        duration = random.uniform(lo, hi)
        log.debug('wait: sleeping %.2fs (range [%.1f, %.1f])', duration, lo, hi)
        time.sleep(duration)
        return 0

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _find_and_convert(
        self, step: PlaybookStep, session: BrowserSession, ctx: JobContext,
    ) -> tuple[float, float]:
        """
        Screenshot, ask inference to find element (bounding box),
        pick random point within box, convert to screen coords.
        """
        shot_b64 = screenshot.capture_to_base64(session.window_id)

        context = f'Service: {ctx.service}, Flow: {ctx.flow}, Action: {step.action}'
        result = self._inference.find_element(
            shot_b64, step.target_description, context,
            ref_region=step.ref_region,
        )
        self._total_inference_calls += 1

        # Pick random point within bounding box
        img_x, img_y = result.random_point()

        log.debug(
            'find_element: "%s" box=(%d,%d,%d,%d) click=(%d,%d) confidence=%.2f',
            step.target_description,
            result.x1, result.y1, result.x2, result.y2,
            img_x, img_y, result.confidence,
        )

        # Convert image-pixel coords to screen points
        browser.get_session_window(session)
        screen_x, screen_y = coords.image_to_screen(
            img_x, img_y, session.bounds,
        )
        return screen_x, screen_y

    def _run_checkpoint(
        self, idx: int, step: PlaybookStep, session: BrowserSession,
    ) -> bool:
        """Take screenshot, ask VLM if page state is correct. Returns True if on track."""
        shot_b64 = screenshot.capture_to_base64(session.window_id)
        result = self._inference.checkpoint(shot_b64, step.checkpoint_prompt)
        self._total_inference_calls += 1

        log.info(
            'checkpoint step %d: on_track=%s confidence=%.2f reason=%s',
            idx, result.on_track, result.confidence, result.reasoning,
        )
        return result.on_track

    def _save_audit_screenshot(
        self, idx: int, session: BrowserSession, ctx: JobContext,
    ) -> dict | None:
        """Save a screenshot for the audit log. Returns metadata dict or None."""
        try:
            ts = int(time.time() * 1000)
            filename = f'{ctx.job_id}_step{idx:02d}_{ts}.png'
            path = SCREENSHOT_DIR / filename
            screenshot.capture_window(session.window_id, str(path))
            return {
                'index': idx,
                'timestamp': ts,
                'path': str(path),
            }
        except Exception:
            log.warning('Failed to save audit screenshot for step %d', idx, exc_info=True)
            return None
