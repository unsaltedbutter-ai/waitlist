"""Tests for agent.page_executor: hash-lookup executor loop.

Mocks browser, screenshot, cache, and inference to test the page loop logic:
  - Cache hit path: loads page playbook, executes actions
  - VLM fallback path: calls infer_action on miss
  - Terminal page ends the flow
  - max_pages safety limit prevents infinite loops

Run: cd agent && python -m pytest tests/test_page_executor.py -v
"""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest
from PIL import Image

from agent.browser import BrowserSession
from agent.inference import (
    FindElementResult,
    InferActionResult,
    MockInferenceClient,
)
from agent.page_cache import PageCache
from agent.page_executor import PageExecutor
from agent.page_playbook import FlowConfig, PagePlaybook
from agent.playbook import JobContext, PlaybookStep
from agent.profile import FAST


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_session() -> BrowserSession:
    return BrowserSession(
        pid=99999,
        process=None,
        profile_dir='/tmp/ub-fake-profile',
        window_id=12345,
        bounds={'x': 0, 'y': 0, 'width': 1280, 'height': 900},
    )


def _make_context(**overrides) -> JobContext:
    defaults = dict(
        job_id='test-page-001',
        user_id='user-abc',
        service='netflix',
        flow='cancel',
        credentials={'email': 'test@example.com', 'pass': 'hunter2'},
    )
    defaults.update(overrides)
    return JobContext(**defaults)


def _make_flow(**overrides) -> FlowConfig:
    defaults = dict(
        service='netflix',
        flow='cancel',
        start_url='https://www.netflix.com/login',
        max_pages=15,
        version=1,
    )
    defaults.update(overrides)
    return FlowConfig(**defaults)


def _terminal_page(page_id: str = 'cancel_confirmed') -> PagePlaybook:
    return PagePlaybook(
        page_id=page_id,
        service='netflix',
        flows=('cancel',),
        actions=(),
        wait_after_sec=(1.0, 2.0),
        terminal=True,
        notes='Confirmation page',
    )


def _action_page(
    page_id: str = 'account_page',
    actions: tuple[PlaybookStep, ...] | None = None,
) -> PagePlaybook:
    if actions is None:
        actions = (
            PlaybookStep(
                action='click',
                target_description='Cancel button',
                ref_region=(400, 300, 600, 340),
            ),
        )
    return PagePlaybook(
        page_id=page_id,
        service='netflix',
        flows=('cancel',),
        actions=actions,
        wait_after_sec=(0.1, 0.2),
        terminal=False,
        notes='Test page',
    )


# ---------------------------------------------------------------------------
# Patch context
# ---------------------------------------------------------------------------

def _patch_externals():
    """Patches for browser, screenshot, sleep, and filesystem."""
    session = _make_session()
    # Create a small test image for b64_to_image
    test_img = Image.new('RGB', (1280, 720), (128, 128, 128))

    patches = {
        'create_session': patch(
            'agent.page_executor.browser.create_session',
            return_value=session,
        ),
        'close_session': patch(
            'agent.page_executor.browser.close_session',
        ),
        'navigate': patch(
            'agent.page_executor.browser.navigate',
        ),
        'get_session_window': patch(
            'agent.page_executor.browser.get_session_window',
            return_value=session.bounds,
        ),
        'capture_to_base64': patch(
            'agent.page_executor.screenshot.capture_to_base64',
            return_value='FAKE_BASE64',
        ),
        'crop_browser_chrome': patch(
            'agent.page_executor.crop_browser_chrome',
            return_value=('FAKE_CROPPED', 88),
        ),
        'b64_to_image': patch(
            'agent.page_executor.screenshot.b64_to_image',
            return_value=test_img,
        ),
        'capture_window': patch(
            'agent.page_executor.screenshot.capture_window',
        ),
        # PlaybookExecutor (action handler) patches
        'executor_capture_to_base64': patch(
            'agent.executor.screenshot.capture_to_base64',
            return_value='FAKE_BASE64',
        ),
        'executor_crop_browser_chrome': patch(
            'agent.executor.crop_browser_chrome',
            return_value=('FAKE_CROPPED', 88),
        ),
        'executor_capture_window': patch(
            'agent.executor.screenshot.capture_window',
        ),
        'mouse_click': patch('agent.executor.mouse.click'),
        'mouse_move_to': patch('agent.executor.mouse.move_to'),
        'keyboard_type_text': patch('agent.executor.keyboard.type_text'),
        'keyboard_press_key': patch('agent.executor.keyboard.press_key'),
        'keyboard_hotkey': patch('agent.executor.keyboard.hotkey'),
        'scroll_scroll': patch('agent.executor.scroll.scroll'),
        'window_focus': patch('agent.executor.window.focus_window_by_pid'),
        'coords_image_to_screen': patch(
            'agent.executor.coords.image_to_screen',
            return_value=(640.0, 450.0),
        ),
        # Note: agent.page_executor.coords and agent.executor.coords point to the
        # same module (agent.input.coords). Only one patch needed per function.
        # The agent.executor.* patches above already cover mouse.click and
        # coords.image_to_screen.
        'sleep': patch('agent.page_executor.time.sleep'),
        'executor_sleep': patch('agent.executor.time.sleep'),
        'screenshot_dir': patch(
            'agent.page_executor.SCREENSHOT_DIR',
            new=MagicMock(**{'mkdir.return_value': None}),
        ),
        'review_queue_dir': patch(
            'agent.page_executor.REVIEW_QUEUE_DIR',
            new=MagicMock(**{'mkdir.return_value': None}),
        ),
    }
    return patches, session


class _PatchedBase:
    """Base class that patches externals and sets up cache + executor."""

    @pytest.fixture(autouse=True)
    def _setup(self, tmp_path: Path):
        patches, self.session = _patch_externals()
        self.mocks = {}
        self._patches = []
        for name, p in patches.items():
            m = p.start()
            self.mocks[name] = m
            self._patches.append(p)

        self.inference = MockInferenceClient()
        self.cache = PageCache(tmp_path / 'test.db')
        self.executor = PageExecutor(
            inference=self.inference,
            cache=self.cache,
            profile=FAST,
        )
        self.ctx = _make_context()

        yield

        self.cache.close()
        for p in self._patches:
            p.stop()


# ---------------------------------------------------------------------------
# Cache hit path
# ---------------------------------------------------------------------------

class TestCacheHitPath(_PatchedBase):
    def test_single_page_terminal(self, tmp_path: Path) -> None:
        """Cache hit on terminal page ends flow immediately with success."""
        terminal = _terminal_page()

        # Write the page playbook file
        page_path = tmp_path / 'pages'
        page_path.mkdir()
        (page_path / 'cancel_confirmed.json').write_text(
            json.dumps(terminal.to_dict()),
        )

        # Mock cache to return hit, and PagePlaybook.load to use our temp dir
        with patch.object(self.cache, 'lookup', return_value='cancel_confirmed'), \
             patch('agent.page_playbook.PAGES_DIR', page_path):
            flow = _make_flow()
            result = self.executor.run(flow, self.ctx)

        assert result.success is True
        assert result.error_message == ''

    def test_two_pages_then_terminal(self, tmp_path: Path) -> None:
        """Two action pages followed by a terminal page."""
        action = _action_page('account_page')
        terminal = _terminal_page()

        page_path = tmp_path / 'pages'
        page_path.mkdir()
        (page_path / 'account_page.json').write_text(json.dumps(action.to_dict()))
        (page_path / 'cancel_confirmed.json').write_text(json.dumps(terminal.to_dict()))

        lookup_results = iter(['account_page', 'account_page', 'cancel_confirmed'])
        with patch.object(self.cache, 'lookup', side_effect=lookup_results), \
             patch('agent.page_playbook.PAGES_DIR', page_path):
            flow = _make_flow()
            result = self.executor.run(flow, self.ctx)

        assert result.success is True
        # Should have step results from the action pages
        assert result.step_count >= 2


# ---------------------------------------------------------------------------
# VLM fallback path
# ---------------------------------------------------------------------------

class TestVlmFallbackPath(_PatchedBase):
    def test_cache_miss_triggers_vlm(self) -> None:
        """Cache miss triggers VLM infer_action."""
        # All lookups miss, then we reach max_pages
        with patch.object(self.cache, 'lookup', return_value=None):
            flow = _make_flow(max_pages=2)
            result = self.executor.run(flow, self.ctx)

        # Should have used VLM fallback (infer_action returns click center)
        assert result.step_count >= 1
        # Not success because we never hit a terminal page
        assert result.success is False
        assert 'Max pages' in result.error_message

    def test_vlm_fallback_then_terminal(self, tmp_path: Path) -> None:
        """Cache miss on page 1 (VLM fallback), then cache hit on terminal page 2."""
        terminal = _terminal_page()
        page_path = tmp_path / 'pages'
        page_path.mkdir()
        (page_path / 'cancel_confirmed.json').write_text(json.dumps(terminal.to_dict()))

        # First lookup misses, second hits terminal
        lookup_results = iter([None, 'cancel_confirmed'])
        with patch.object(self.cache, 'lookup', side_effect=lookup_results), \
             patch('agent.page_playbook.PAGES_DIR', page_path):
            flow = _make_flow()
            result = self.executor.run(flow, self.ctx)

        assert result.success is True


# ---------------------------------------------------------------------------
# Safety limits
# ---------------------------------------------------------------------------

class TestSafetyLimits(_PatchedBase):
    def test_max_pages_prevents_infinite_loop(self) -> None:
        """max_pages limit stops the loop when no terminal page is found."""
        with patch.object(self.cache, 'lookup', return_value=None):
            flow = _make_flow(max_pages=3)
            result = self.executor.run(flow, self.ctx)

        assert result.success is False
        assert 'Max pages' in result.error_message

    def test_timeout_stops_execution(self) -> None:
        """Total execution timeout stops the page loop."""
        start_time = 1000.0
        call_count = [0]

        def advancing_monotonic():
            call_count[0] += 1
            if call_count[0] <= 3:
                return start_time
            return start_time + 999999

        with patch.object(self.cache, 'lookup', return_value=None), \
             patch('agent.page_executor.time.monotonic', side_effect=advancing_monotonic):
            flow = _make_flow(max_pages=100)
            result = self.executor.run(flow, self.ctx)

        assert result.success is False
        assert 'timeout' in result.error_message.lower()


# ---------------------------------------------------------------------------
# Cleanup
# ---------------------------------------------------------------------------

class TestCleanup(_PatchedBase):
    def test_credentials_destroyed_on_success(self, tmp_path: Path) -> None:
        terminal = _terminal_page()
        page_path = tmp_path / 'pages'
        page_path.mkdir()
        (page_path / 'cancel_confirmed.json').write_text(json.dumps(terminal.to_dict()))

        ctx = _make_context()
        with patch.object(self.cache, 'lookup', return_value='cancel_confirmed'), \
             patch('agent.page_playbook.PAGES_DIR', page_path):
            self.executor.run(_make_flow(), ctx)

        assert len(ctx.credentials) == 0

    def test_credentials_destroyed_on_failure(self) -> None:
        ctx = _make_context()
        with patch.object(self.cache, 'lookup', return_value=None):
            self.executor.run(_make_flow(max_pages=1), ctx)
        assert len(ctx.credentials) == 0

    def test_chrome_closed_on_success(self, tmp_path: Path) -> None:
        terminal = _terminal_page()
        page_path = tmp_path / 'pages'
        page_path.mkdir()
        (page_path / 'cancel_confirmed.json').write_text(json.dumps(terminal.to_dict()))

        with patch.object(self.cache, 'lookup', return_value='cancel_confirmed'), \
             patch('agent.page_playbook.PAGES_DIR', page_path):
            self.executor.run(_make_flow(), self.ctx)

        self.mocks['close_session'].assert_called_once()

    def test_chrome_closed_on_failure(self) -> None:
        with patch.object(self.cache, 'lookup', return_value=None):
            self.executor.run(_make_flow(max_pages=1), self.ctx)
        self.mocks['close_session'].assert_called_once()

    def test_chrome_closed_on_exception(self) -> None:
        self.mocks['create_session'].side_effect = RuntimeError('Chrome not found')
        result = self.executor.run(_make_flow(), self.ctx)
        assert result.success is False
        # close_session not called because session was never created
        # But credentials should still be destroyed
        assert len(self.ctx.credentials) == 0


# ---------------------------------------------------------------------------
# Page action execution
# ---------------------------------------------------------------------------

class TestPageActions(_PatchedBase):
    def test_click_action_executed(self, tmp_path: Path) -> None:
        """Click action in a page playbook triggers mouse click."""
        page = _action_page()
        terminal = _terminal_page()
        page_path = tmp_path / 'pages'
        page_path.mkdir()
        (page_path / 'account_page.json').write_text(json.dumps(page.to_dict()))
        (page_path / 'cancel_confirmed.json').write_text(json.dumps(terminal.to_dict()))

        lookup_results = iter(['account_page', 'cancel_confirmed'])
        with patch.object(self.cache, 'lookup', side_effect=lookup_results), \
             patch('agent.page_playbook.PAGES_DIR', page_path):
            result = self.executor.run(_make_flow(), self.ctx)

        assert result.success is True
        self.mocks['mouse_click'].assert_called()

    def test_disabled_action_skipped(self, tmp_path: Path) -> None:
        """Disabled actions in page playbooks are skipped."""
        page = PagePlaybook(
            page_id='with_disabled',
            service='netflix',
            flows=('cancel',),
            actions=(
                PlaybookStep(action='click', target_description='X', disabled=True),
            ),
            wait_after_sec=(0.1, 0.2),
            terminal=True,
            notes='',
        )
        page_path = tmp_path / 'pages'
        page_path.mkdir()
        (page_path / 'with_disabled.json').write_text(json.dumps(page.to_dict()))

        with patch.object(self.cache, 'lookup', return_value='with_disabled'), \
             patch('agent.page_playbook.PAGES_DIR', page_path):
            result = self.executor.run(_make_flow(), self.ctx)

        assert result.success is True
        assert result.step_results[0].skipped is True

    def test_failed_non_optional_action_stops_flow(self, tmp_path: Path) -> None:
        """A failing non-optional action stops the entire flow."""
        page = PagePlaybook(
            page_id='failing_page',
            service='netflix',
            flows=('cancel',),
            actions=(
                PlaybookStep(action='teleport', target_description='nowhere'),
            ),
            wait_after_sec=(0.1, 0.2),
            terminal=False,
            notes='',
        )
        page_path = tmp_path / 'pages'
        page_path.mkdir()
        (page_path / 'failing_page.json').write_text(json.dumps(page.to_dict()))

        with patch.object(self.cache, 'lookup', return_value='failing_page'), \
             patch('agent.page_playbook.PAGES_DIR', page_path):
            result = self.executor.run(_make_flow(), self.ctx)

        assert result.success is False
        assert 'failing_page' in result.error_message
