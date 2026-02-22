"""Page-based executor: hash-lookup loop that identifies pages and runs page playbooks.

Replaces the sequential step-based executor with a page-identification loop:
  1. Screenshot + crop
  2. Hash lookup (3-tier: exact, blurred, pHash)
  3. If hit: load PagePlaybook, execute its actions
  4. If miss: VLM fallback + capture for operator review
  5. If terminal page: verify success, end flow
  6. Loop until terminal or max_pages reached

Reuses action handlers from PlaybookExecutor for actual step execution.
"""

from __future__ import annotations

import json
import logging
import random
import time
from pathlib import Path

from agent import browser, screenshot
from agent.browser import BrowserSession
from agent.config import (
    PAGE_LOAD_WAIT,
    REVIEW_QUEUE_DIR,
    SCREENSHOT_DIR,
    TOTAL_EXECUTION_TIMEOUT,
)
from agent.executor import PlaybookExecutor
from agent.inference import InferActionResult, InferenceClient
from agent.input import coords, mouse
from agent.page_cache import PageCache
from agent.page_playbook import FlowConfig, PagePlaybook
from agent.playbook import ExecutionResult, JobContext, StepResult
from agent.profile import NORMAL, HumanProfile
from agent.screenshot import crop_browser_chrome

log = logging.getLogger(__name__)

# Settle time: wait for page to stabilize before screenshotting
PAGE_SETTLE_SEC = (0.5, 1.5)


class PageExecutor:
    """Execute a flow using page-based hash matching."""

    def __init__(
        self,
        inference: InferenceClient,
        cache: PageCache,
        profile: HumanProfile = NORMAL,
    ) -> None:
        self._inference = inference
        self._cache = cache
        self._profile = profile
        self._total_inference_calls = 0
        # Delegate action execution to the existing PlaybookExecutor
        self._action_executor = PlaybookExecutor(
            inference=inference,
            profile=profile,
        )

    def run(self, flow: FlowConfig, ctx: JobContext) -> ExecutionResult:
        """Execute a multi-page flow. Returns ExecutionResult with metrics."""
        start = time.monotonic()
        step_results: list[StepResult] = []
        screenshots: list[dict] = []
        session: BrowserSession | None = None
        error_message = ''
        success = False
        pages_visited = 0

        SCREENSHOT_DIR.mkdir(parents=True, exist_ok=True)

        try:
            # 1. Launch Chrome
            jitter_w = random.randint(-40, 40)
            jitter_h = random.randint(-40, 40)
            session = browser.create_session(
                width=1280 + jitter_w,
                height=900 + jitter_h,
            )
            log.info(
                'PageExecutor: Chrome started (PID %d, %dx%d)',
                session.pid,
                session.bounds.get('width', 0),
                session.bounds.get('height', 0),
            )

            # 2. Navigate to start URL
            browser.navigate(session, flow.start_url, fast=True)
            time.sleep(PAGE_LOAD_WAIT)
            browser.get_session_window(session)

            # 3. Page loop
            while pages_visited < flow.max_pages:
                elapsed = time.monotonic() - start
                if elapsed > TOTAL_EXECUTION_TIMEOUT:
                    error_message = (
                        f'Total execution timeout exceeded at page {pages_visited}'
                    )
                    log.error(error_message)
                    break

                # Settle
                lo, hi = PAGE_SETTLE_SEC
                time.sleep(random.uniform(lo, hi))

                # Screenshot + crop
                shot_b64 = screenshot.capture_to_base64(session.window_id)
                cropped_b64, chrome_px = crop_browser_chrome(shot_b64)
                cropped_img = screenshot.b64_to_image(cropped_b64)

                # Hash lookup
                page_id = self._cache.lookup(cropped_img, flow.service, flow.flow)
                pages_visited += 1

                if page_id is not None:
                    # Cache hit: load and execute page playbook
                    log.info('Page %d: cache hit -> %s', pages_visited, page_id)
                    page_pb = PagePlaybook.load(page_id)

                    page_results = self._execute_page_actions(
                        page_pb, session, ctx, step_results, screenshots,
                    )
                    if not page_results.ok:
                        error_message = page_results.error
                        break

                    # Terminal page: flow complete
                    if page_pb.terminal:
                        success = True
                        log.info('Terminal page reached: %s', page_id)
                        break

                    # Wait for next page to load
                    wait_lo, wait_hi = page_pb.wait_after_sec
                    time.sleep(random.uniform(wait_lo, wait_hi))

                else:
                    # Cache miss: VLM fallback
                    log.warning('Page %d: cache miss, falling back to VLM', pages_visited)
                    fallback_result = self._vlm_fallback(
                        cropped_b64, cropped_img, session, ctx, flow,
                        step_results, screenshots, chrome_px,
                    )
                    self._total_inference_calls += 1
                    if not fallback_result.ok:
                        error_message = fallback_result.error
                        break

                    # Wait for page transition after VLM action
                    time.sleep(random.uniform(1.5, 3.0))

            else:
                # max_pages exhausted without terminal
                if not success:
                    error_message = (
                        f'Max pages ({flow.max_pages}) reached without terminal page'
                    )
                    log.error(error_message)

        except Exception as exc:
            error_message = f'Unhandled exception: {exc}'
            log.exception('PageExecutor crashed')

        finally:
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
            playbook_version=flow.version,
            error_message=error_message,
            step_results=step_results,
            screenshots=screenshots,
        )

    # ------------------------------------------------------------------
    # Page action execution
    # ------------------------------------------------------------------

    class _PageResult:
        """Internal result from executing a page's actions."""
        __slots__ = ('ok', 'error')

        def __init__(self, ok: bool = True, error: str = '') -> None:
            self.ok = ok
            self.error = error

    def _execute_page_actions(
        self,
        page_pb: PagePlaybook,
        session: BrowserSession,
        ctx: JobContext,
        step_results: list[StepResult],
        screenshots: list[dict],
    ) -> _PageResult:
        """Execute all actions in a page playbook sequentially."""
        for idx, step in enumerate(page_pb.actions):
            if step.disabled:
                step_results.append(StepResult(
                    index=len(step_results),
                    action=step.action,
                    success=True,
                    skipped=True,
                ))
                continue

            # Human-like pause
            if step.action not in ('navigate', 'wait', 'press_key'):
                lo, hi = self._profile.decision_delay
                if hi > 0:
                    time.sleep(random.uniform(lo, hi))

            sr = self._action_executor._execute_step(
                len(step_results), step, session, ctx,
            )
            step_results.append(sr)

            # Save audit screenshot for non-sensitive steps
            if sr.success and not step.is_sensitive:
                shot = self._save_audit_screenshot(
                    len(step_results) - 1, session, ctx,
                )
                if shot:
                    screenshots.append(shot)

            if not sr.success and not step.optional:
                return self._PageResult(
                    ok=False,
                    error=f'Page {page_pb.page_id} step {idx} ({step.action}) failed: {sr.error}',
                )

            self._total_inference_calls += sr.inference_calls

        return self._PageResult(ok=True)

    # ------------------------------------------------------------------
    # VLM fallback
    # ------------------------------------------------------------------

    def _vlm_fallback(
        self,
        cropped_b64: str,
        cropped_img: 'Image.Image',
        session: BrowserSession,
        ctx: JobContext,
        flow: FlowConfig,
        step_results: list[StepResult],
        screenshots: list[dict],
        chrome_px: int,
    ) -> _PageResult:
        """VLM fallback for unknown pages. Captures for operator review."""
        step_start = time.monotonic()
        try:
            context = f'Service: {flow.service}, Flow: {flow.flow}'
            result = self._inference.infer_action(cropped_b64, context)

            # Execute the VLM-suggested action
            if result.action == 'click':
                browser.get_session_window(session)
                screen_x, screen_y = coords.image_to_screen(
                    result.target_x, result.target_y, session.bounds,
                    chrome_offset=chrome_px,
                )
                mouse.click(int(screen_x), int(screen_y), fast=self._profile.mouse_fast)

            # Capture for operator review + dynamic cache
            self._capture_for_review(cropped_img, flow, result)
            self._cache_dynamic_page(cropped_img, flow, result)

            duration = round(time.monotonic() - step_start, 2)
            step_results.append(StepResult(
                index=len(step_results),
                action=f'vlm_fallback:{result.action}',
                success=True,
                duration_seconds=duration,
                inference_calls=1,
            ))
            return self._PageResult(ok=True)

        except Exception as exc:
            duration = round(time.monotonic() - step_start, 2)
            step_results.append(StepResult(
                index=len(step_results),
                action='vlm_fallback',
                success=False,
                duration_seconds=duration,
                inference_calls=1,
                error=str(exc),
            ))
            return self._PageResult(ok=False, error=f'VLM fallback failed: {exc}')

    def _capture_for_review(
        self,
        img: 'Image.Image',
        flow: FlowConfig,
        vlm_result: InferActionResult,
    ) -> None:
        """Save unknown page to review queue for operator."""
        from agent.hasher import compute_all_hashes  # noqa: local to avoid circular

        try:
            REVIEW_QUEUE_DIR.mkdir(parents=True, exist_ok=True)
            ts = int(time.time() * 1000)
            prefix = f'{flow.service}_{flow.flow}_{ts}'

            img.save(REVIEW_QUEUE_DIR / f'{prefix}.png')

            sha_full, sha_blur, phash_hex = compute_all_hashes(img)
            meta = {
                'service': flow.service,
                'flow': flow.flow,
                'timestamp': ts,
                'hashes': {
                    'sha256_full': sha_full,
                    'sha256_blurred': sha_blur,
                    'phash': phash_hex,
                },
                'vlm_response': {
                    'action': vlm_result.action,
                    'target_x': vlm_result.target_x,
                    'target_y': vlm_result.target_y,
                    'text': vlm_result.text,
                    'confidence': vlm_result.confidence,
                    'reasoning': vlm_result.reasoning,
                },
            }
            with open(REVIEW_QUEUE_DIR / f'{prefix}.json', 'w') as f:
                json.dump(meta, f, indent=2)
                f.write('\n')

            log.info('Captured unknown page for review: %s', prefix)
        except Exception:
            log.warning('Failed to capture page for review', exc_info=True)

    def _cache_dynamic_page(
        self,
        img: 'Image.Image',
        flow: FlowConfig,
        vlm_result: InferActionResult,
    ) -> None:
        """Cache a VLM fallback result as a dynamic page entry."""
        try:
            ts = int(time.time() * 1000)
            page_id = f'{flow.service}_{flow.flow}_dyn_{ts}'

            self._cache.insert(
                page_id, flow.service, [flow.flow], img,
                source='dynamic',
            )

            # Build a single-action page playbook and save it
            from agent.config import PAGES_DIR
            from agent.page_playbook import PagePlaybook
            from agent.playbook import PlaybookStep

            step_dict: dict = {'action': vlm_result.action}
            if vlm_result.action == 'click':
                step_dict['bounding_box'] = [
                    vlm_result.target_x, vlm_result.target_y,
                    vlm_result.target_x, vlm_result.target_y,
                ]
                step_dict['target_description'] = vlm_result.reasoning
            elif vlm_result.action == 'type_text':
                step_dict['text_to_type'] = vlm_result.text
            elif vlm_result.action in ('scroll_down', 'scroll_up'):
                step_dict['direction'] = vlm_result.action.split('_')[1]

            page_pb = PagePlaybook(
                page_id=page_id,
                service=flow.service,
                flows=(flow.flow,),
                actions=(PlaybookStep.from_dict(step_dict),),
                wait_after_sec=(1.5, 3.0),
                terminal=False,
                notes=f'Dynamic VLM fallback (confidence: {vlm_result.confidence})',
            )

            PAGES_DIR.mkdir(parents=True, exist_ok=True)
            page_path = PAGES_DIR / f'{page_id}.json'
            with open(page_path, 'w') as f:
                json.dump(page_pb.to_dict(), f, indent=2)
                f.write('\n')

            log.info('Cached dynamic page: %s', page_id)
        except Exception:
            log.warning('Failed to cache dynamic page', exc_info=True)

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _save_audit_screenshot(
        self, idx: int, session: BrowserSession, ctx: JobContext,
    ) -> dict | None:
        """Save a screenshot for the audit log."""
        try:
            ts = int(time.time() * 1000)
            filename = f'{ctx.job_id}_page{idx:02d}_{ts}.png'
            path = SCREENSHOT_DIR / filename
            screenshot.capture_window(session.window_id, str(path))
            return {'index': idx, 'timestamp': ts, 'path': str(path)}
        except Exception:
            log.warning('Failed to save audit screenshot', exc_info=True)
            return None
