"""Tests for PlaybookExecutor: the core loop that drives playbook execution.

Mocks browser, screenshot, and time.sleep to avoid real Chrome/macOS calls.
Uses MockInferenceClient for all VLM interactions.

Run: cd agent && python -m pytest tests/test_executor.py -v
"""

from __future__ import annotations

import random
import time
from unittest.mock import MagicMock, patch

import pytest

from agent.browser import BrowserSession
from agent.config import TOTAL_EXECUTION_TIMEOUT
from agent.executor import OPTIONAL_CHAIN_CHANCE, PlaybookExecutor
from agent.inference import (
    CheckpointResult,
    FindElementResult,
    MockInferenceClient,
)
from agent.playbook import (
    ExecutionResult,
    JobContext,
    Playbook,
    PlaybookStep,
)
from agent.profile import FAST


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------

def _make_session() -> BrowserSession:
    """Create a fake BrowserSession (no real Chrome)."""
    return BrowserSession(
        pid=99999,
        process=None,
        profile_dir='/tmp/ub-fake-profile',
        window_id=12345,
        bounds={'x': 0, 'y': 0, 'width': 1280, 'height': 900},
    )


def _make_context(**overrides) -> JobContext:
    defaults = dict(
        job_id='test-001',
        user_id='user-abc',
        service='netflix',
        flow='cancel',
        credentials={
            'email': 'test@example.com',
            'pass': 'hunter2',
        },
    )
    defaults.update(overrides)
    return JobContext(**defaults)


def _patch_externals():
    """Context manager that patches all macOS/browser/filesystem externals."""
    session = _make_session()

    patches = {
        'create_session': patch(
            'agent.executor.browser.create_session',
            return_value=session,
        ),
        'close_session': patch(
            'agent.executor.browser.close_session',
        ),
        'navigate': patch(
            'agent.executor.browser.navigate',
        ),
        'get_session_window': patch(
            'agent.executor.browser.get_session_window',
            return_value=session.bounds,
        ),
        'capture_to_base64': patch(
            'agent.executor.screenshot.capture_to_base64',
            return_value='FAKE_BASE64_SCREENSHOT',
        ),
        'capture_window': patch(
            'agent.executor.screenshot.capture_window',
            return_value='/tmp/ub-screenshot-fake.png',
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
        'sleep': patch('agent.executor.time.sleep'),
        'screenshot_dir': patch(
            'agent.executor.SCREENSHOT_DIR',
            new=MagicMock(**{'mkdir.return_value': None}),
        ),
    }
    return patches, session


class _PatchedTestBase:
    """Base class that sets up all external patches for executor tests."""

    @pytest.fixture(autouse=True)
    def _setup_patches(self, mock_inference: MockInferenceClient):
        patches, self.session = _patch_externals()
        self.mocks = {}
        started = []
        for name, p in patches.items():
            m = p.start()
            self.mocks[name] = m
            started.append(p)

        self.inference = mock_inference
        self.executor = PlaybookExecutor(
            inference=self.inference,
            profile=FAST,
        )
        self.ctx = _make_context()

        yield

        for p in started:
            p.stop()


# ---------------------------------------------------------------------------
# Basic execution
# ---------------------------------------------------------------------------


class TestBasicExecution(_PatchedTestBase):
    """Run simple playbooks and check results."""

    def test_empty_playbook_succeeds(self) -> None:
        """A playbook with zero steps completes successfully."""
        pb = Playbook(
            service='test', flow='cancel', version=1,
            notes='', last_validated=None, steps=(),
        )
        result = self.executor.run(pb, self.ctx)
        assert result.success is True
        assert result.step_count == 0
        assert result.job_id == 'test-001'
        assert result.service == 'netflix'
        assert result.flow == 'cancel'

    def test_navigate_step(self) -> None:
        """Navigate step calls browser.navigate with resolved URL."""
        pb = Playbook(
            service='netflix', flow='cancel', version=1,
            notes='', last_validated=None,
            steps=(
                PlaybookStep(action='navigate', url='https://netflix.com/login'),
            ),
        )
        result = self.executor.run(pb, self.ctx)
        assert result.success is True
        assert result.step_count == 1
        self.mocks['navigate'].assert_called_once()

    def test_click_step(self) -> None:
        """Click step triggers VLM find_element then mouse click."""
        pb = Playbook(
            service='netflix', flow='cancel', version=1,
            notes='', last_validated=None,
            steps=(
                PlaybookStep(
                    action='click',
                    target_description='Sign In button',
                    ref_region=(500, 300, 700, 350),
                ),
            ),
        )
        result = self.executor.run(pb, self.ctx)
        assert result.success is True
        assert result.inference_count >= 1
        self.mocks['mouse_click'].assert_called_once()

    def test_type_text_with_target(self) -> None:
        """type_text with target_description: find field, click, type."""
        pb = Playbook(
            service='netflix', flow='cancel', version=1,
            notes='', last_validated=None,
            steps=(
                PlaybookStep(
                    action='type_text',
                    target_description='Email field',
                    value='{email}',
                    ref_region=(200, 100, 600, 130),
                ),
            ),
        )
        result = self.executor.run(pb, self.ctx)
        assert result.success is True
        # Should have clicked the field, then typed
        self.mocks['mouse_click'].assert_called_once()
        self.mocks['keyboard_type_text'].assert_called_once()
        call_args = self.mocks['keyboard_type_text'].call_args
        assert call_args[0][0] == 'test@example.com'

    def test_type_text_followon(self) -> None:
        """type_text without target_description: just type, no VLM call."""
        pb = Playbook(
            service='netflix', flow='cancel', version=1,
            notes='', last_validated=None,
            steps=(
                PlaybookStep(
                    action='type_text',
                    value='{pass}',
                ),
            ),
        )
        result = self.executor.run(pb, self.ctx)
        assert result.success is True
        # No click (no target_description)
        self.mocks['mouse_click'].assert_not_called()
        # Typed the password
        self.mocks['keyboard_type_text'].assert_called_once()
        call_args = self.mocks['keyboard_type_text'].call_args
        assert call_args[0][0] == 'hunter2'

    def test_type_text_with_trailing_keys(self) -> None:
        """type_text with {tab} appended: types value then presses tab."""
        pb = Playbook(
            service='netflix', flow='cancel', version=1,
            notes='', last_validated=None,
            steps=(
                PlaybookStep(action='type_text', value='{email}{tab}'),
            ),
        )
        result = self.executor.run(pb, self.ctx)
        assert result.success is True
        self.mocks['keyboard_type_text'].assert_called_once()
        # press_key should have been called for 'tab'
        self.mocks['keyboard_press_key'].assert_called()
        key_calls = [c[0][0] for c in self.mocks['keyboard_press_key'].call_args_list]
        assert 'tab' in key_calls

    def test_wait_step(self) -> None:
        """Wait step sleeps within the configured range."""
        pb = Playbook(
            service='test', flow='cancel', version=1,
            notes='', last_validated=None,
            steps=(
                PlaybookStep(action='wait', wait_after_sec=(2.0, 4.0)),
            ),
        )
        result = self.executor.run(pb, self.ctx)
        assert result.success is True
        assert result.step_count == 1

    def test_press_key_step(self) -> None:
        """press_key step presses the specified key."""
        pb = Playbook(
            service='test', flow='cancel', version=1,
            notes='', last_validated=None,
            steps=(
                PlaybookStep(action='press_key', value='escape'),
            ),
        )
        result = self.executor.run(pb, self.ctx)
        assert result.success is True
        self.mocks['keyboard_press_key'].assert_called()

    def test_hover_step(self) -> None:
        """hover (legacy alias) moves mouse without clicking."""
        pb = Playbook(
            service='test', flow='cancel', version=1,
            notes='', last_validated=None,
            steps=(
                PlaybookStep(
                    action='hover',
                    target_description='Account menu',
                    ref_region=(100, 50, 200, 80),
                ),
            ),
        )
        result = self.executor.run(pb, self.ctx)
        assert result.success is True
        self.mocks['mouse_move_to'].assert_called_once()
        self.mocks['mouse_click'].assert_not_called()

    def test_wander_step(self) -> None:
        """wander action moves mouse without clicking (same as hover)."""
        pb = Playbook(
            service='test', flow='cancel', version=1,
            notes='', last_validated=None,
            steps=(
                PlaybookStep(
                    action='wander',
                    target_description='Account menu',
                    ref_region=(100, 50, 200, 80),
                ),
            ),
        )
        result = self.executor.run(pb, self.ctx)
        assert result.success is True
        self.mocks['mouse_move_to'].assert_called()
        self.mocks['mouse_click'].assert_not_called()

    def test_scroll_step(self) -> None:
        """scroll step invokes scroll module."""
        pb = Playbook(
            service='test', flow='cancel', version=1,
            notes='', last_validated=None,
            steps=(
                PlaybookStep(action='scroll', target_description='scroll down 5'),
            ),
        )
        result = self.executor.run(pb, self.ctx)
        assert result.success is True
        self.mocks['scroll_scroll'].assert_called_once_with('down', 5)

    def test_scroll_up(self) -> None:
        pb = Playbook(
            service='test', flow='cancel', version=1,
            notes='', last_validated=None,
            steps=(
                PlaybookStep(action='scroll', target_description='scroll up'),
            ),
        )
        result = self.executor.run(pb, self.ctx)
        assert result.success is True
        self.mocks['scroll_scroll'].assert_called_once_with('up', 3)  # default amount


# ---------------------------------------------------------------------------
# Disabled and optional steps
# ---------------------------------------------------------------------------


class TestDisabledAndOptionalSteps(_PatchedTestBase):
    """Steps can be disabled or optional, affecting execution."""

    def test_disabled_step_skipped(self) -> None:
        """disabled=True steps are skipped and marked as such."""
        pb = Playbook(
            service='test', flow='cancel', version=1,
            notes='', last_validated=None,
            steps=(
                PlaybookStep(action='click', target_description='X', disabled=True),
                PlaybookStep(action='navigate', url='https://example.com'),
            ),
        )
        result = self.executor.run(pb, self.ctx)
        assert result.success is True
        assert result.step_count == 2
        assert result.step_results[0].skipped is True
        assert result.step_results[1].skipped is False

    def test_optional_chain_all_skipped(self) -> None:
        """When the dice skip an optional chain, all consecutive optional steps skip."""
        random.seed(0)  # Seed so random.random() > OPTIONAL_CHAIN_CHANCE
        # We need to find a seed where random.random() > 0.5.
        # Let's patch random.random to control this.
        pb = Playbook(
            service='test', flow='cancel', version=1,
            notes='', last_validated=None,
            steps=(
                PlaybookStep(action='click', target_description='Opt1', optional=True),
                PlaybookStep(action='click', target_description='Opt2', optional=True),
                PlaybookStep(action='navigate', url='https://example.com'),
            ),
        )
        with patch('agent.executor.random.random', return_value=0.9):  # > 0.5, skip chain
            result = self.executor.run(pb, self.ctx)
        assert result.success is True
        assert result.step_results[0].skipped is True
        assert result.step_results[1].skipped is True
        assert result.step_results[2].skipped is False

    def test_optional_chain_all_executed(self) -> None:
        """When dice favor execution, optional steps run normally."""
        pb = Playbook(
            service='test', flow='cancel', version=1,
            notes='', last_validated=None,
            steps=(
                PlaybookStep(
                    action='click', target_description='Opt1',
                    optional=True, ref_region=(100, 100, 200, 200),
                ),
                PlaybookStep(action='navigate', url='https://example.com'),
            ),
        )
        with patch('agent.executor.random.random', return_value=0.1):  # < 0.5, execute
            result = self.executor.run(pb, self.ctx)
        assert result.success is True
        assert result.step_results[0].skipped is False

    def test_optional_step_failure_does_not_abort(self) -> None:
        """A failing optional step does not stop execution."""
        # Make find_element raise for the optional step
        failing_inference = MagicMock()
        failing_inference.find_element.side_effect = RuntimeError('VLM down')
        failing_inference.checkpoint.return_value = CheckpointResult(
            on_track=True, confidence=0.9, reasoning='OK',
        )

        executor = PlaybookExecutor(inference=failing_inference, profile=FAST)
        pb = Playbook(
            service='test', flow='cancel', version=1,
            notes='', last_validated=None,
            steps=(
                PlaybookStep(
                    action='click', target_description='Optional button',
                    optional=True,
                ),
                PlaybookStep(action='navigate', url='https://example.com'),
            ),
        )
        with patch('agent.executor.random.random', return_value=0.1):
            result = executor.run(pb, self.ctx)
        # Optional failure does not abort: navigate should still run
        assert result.step_count == 2
        assert result.step_results[0].success is False
        assert result.step_results[1].success is True


# ---------------------------------------------------------------------------
# Checkpoints
# ---------------------------------------------------------------------------


class TestCheckpoints(_PatchedTestBase):
    """Checkpoint steps verify page state before action."""

    def test_checkpoint_passes(self) -> None:
        """When checkpoint returns on_track=True, step proceeds."""
        pb = Playbook(
            service='test', flow='cancel', version=1,
            notes='', last_validated=None,
            steps=(
                PlaybookStep(
                    action='click',
                    target_description='Confirm button',
                    checkpoint=True,
                    checkpoint_prompt='Is the confirm page loaded?',
                    ref_region=(400, 300, 600, 340),
                ),
            ),
        )
        result = self.executor.run(pb, self.ctx)
        assert result.success is True

    def test_checkpoint_fails_aborts_step(self) -> None:
        """When checkpoint returns on_track=False, step fails."""
        failing_checkpoint = MagicMock()
        failing_checkpoint.checkpoint.return_value = CheckpointResult(
            on_track=False, confidence=0.2, reasoning='Wrong page',
        )

        executor = PlaybookExecutor(inference=failing_checkpoint, profile=FAST)
        pb = Playbook(
            service='test', flow='cancel', version=1,
            notes='', last_validated=None,
            steps=(
                PlaybookStep(
                    action='click',
                    target_description='Confirm button',
                    checkpoint=True,
                    checkpoint_prompt='Is the confirm page loaded?',
                ),
            ),
        )
        result = executor.run(pb, self.ctx)
        assert result.success is False
        assert 'Checkpoint failed' in result.error_message

    def test_verify_success_step(self) -> None:
        """verify_success is a checkpoint-only step."""
        pb = Playbook(
            service='test', flow='cancel', version=1,
            notes='', last_validated=None,
            steps=(
                PlaybookStep(
                    action='verify_success',
                    checkpoint=True,
                    checkpoint_prompt='Cancel confirmed?',
                ),
            ),
        )
        result = self.executor.run(pb, self.ctx)
        assert result.success is True
        assert result.inference_count >= 1

    def test_verify_success_fails(self) -> None:
        """verify_success failure stops execution.

        When checkpoint=True, the step-level checkpoint runs first.
        If it returns on_track=False, the step fails with 'Checkpoint failed'.
        """
        failing = MagicMock()
        failing.checkpoint.return_value = CheckpointResult(
            on_track=False, confidence=0.1, reasoning='Not cancelled',
        )

        executor = PlaybookExecutor(inference=failing, profile=FAST)
        pb = Playbook(
            service='test', flow='cancel', version=1,
            notes='', last_validated=None,
            steps=(
                PlaybookStep(
                    action='verify_success',
                    checkpoint=True,
                    checkpoint_prompt='Cancel confirmed?',
                ),
            ),
        )
        result = executor.run(pb, self.ctx)
        assert result.success is False
        assert 'Checkpoint failed' in result.error_message


# ---------------------------------------------------------------------------
# Retention handling
# ---------------------------------------------------------------------------


class TestRetentionHandling(_PatchedTestBase):
    """handle_retention loops through retention pages."""

    def test_retention_exits_immediately(self) -> None:
        """If handler checkpoint says not on retention page, exits after 1 iteration.

        The step has checkpoint=True, so _execute_step runs a step-level
        checkpoint first (must pass), then the handler runs its own checkpoint
        loop. Two checkpoint calls total: step-level (pass) + handler (not retention).
        """
        not_retention = MagicMock()
        # Call 1: step-level checkpoint (must pass to reach handler)
        # Call 2: handler's first iteration checkpoint (not on retention)
        not_retention.checkpoint.side_effect = [
            CheckpointResult(on_track=True, confidence=0.9, reasoning='Page is correct'),
            CheckpointResult(on_track=False, confidence=0.9, reasoning='Not retention'),
        ]
        not_retention.find_element.return_value = FindElementResult(
            x1=100, y1=100, x2=200, y2=150, confidence=0.9,
        )

        executor = PlaybookExecutor(inference=not_retention, profile=FAST)
        pb = Playbook(
            service='netflix', flow='cancel', version=1,
            notes='', last_validated=None,
            steps=(
                PlaybookStep(
                    action='handle_retention',
                    target_description='Continue Cancellation',
                    checkpoint=True,
                    checkpoint_prompt='Is this a retention page?',
                    may_repeat=True,
                    max_repeats=5,
                ),
            ),
        )
        result = executor.run(pb, _make_context())
        assert result.success is True
        # 2 checkpoint calls: step-level + handler's first iteration
        assert not_retention.checkpoint.call_count == 2
        # No click (handler exited before clicking)
        self.mocks['mouse_click'].assert_not_called()

    def test_retention_loops_then_exits(self) -> None:
        """Retention page for 2 iterations, then exits.

        Checkpoint calls:
          1. step-level (pass)
          2. handler iter 0: on retention (click)
          3. handler iter 1: on retention (click)
          4. handler iter 2: not on retention (exit)
        """
        retention_mock = MagicMock()
        retention_mock.checkpoint.side_effect = [
            CheckpointResult(on_track=True, confidence=0.9, reasoning='Page correct'),
            CheckpointResult(on_track=True, confidence=0.9, reasoning='Retention offer'),
            CheckpointResult(on_track=True, confidence=0.9, reasoning='Another offer'),
            CheckpointResult(on_track=False, confidence=0.9, reasoning='Left retention'),
        ]
        retention_mock.find_element.return_value = FindElementResult(
            x1=400, y1=300, x2=600, y2=340, confidence=0.9,
        )

        executor = PlaybookExecutor(inference=retention_mock, profile=FAST)
        pb = Playbook(
            service='netflix', flow='cancel', version=1,
            notes='', last_validated=None,
            steps=(
                PlaybookStep(
                    action='handle_retention',
                    target_description='Continue Cancellation',
                    checkpoint=True,
                    checkpoint_prompt='Is this a retention page?',
                    may_repeat=True,
                    max_repeats=5,
                ),
            ),
        )
        result = executor.run(pb, _make_context())
        assert result.success is True
        # 4 checkpoints: step-level + handler(on, on, off)
        assert retention_mock.checkpoint.call_count == 4
        # 2 clicks (one per retention iteration where still_retention=True)
        assert retention_mock.find_element.call_count == 2


# ---------------------------------------------------------------------------
# Error handling
# ---------------------------------------------------------------------------


class TestErrorHandling(_PatchedTestBase):
    """Executor error handling and cleanup."""

    def test_unknown_action_fails(self) -> None:
        """Unknown action type causes step failure."""
        pb = Playbook(
            service='test', flow='cancel', version=1,
            notes='', last_validated=None,
            steps=(
                PlaybookStep(action='teleport'),
            ),
        )
        result = self.executor.run(pb, self.ctx)
        assert result.success is False
        assert 'Unknown action' in result.error_message

    def test_navigate_without_url_fails(self) -> None:
        """Navigate step with no URL raises ValueError."""
        pb = Playbook(
            service='test', flow='cancel', version=1,
            notes='', last_validated=None,
            steps=(
                PlaybookStep(action='navigate'),
            ),
        )
        result = self.executor.run(pb, self.ctx)
        assert result.success is False
        assert 'no URL' in result.error_message

    def test_press_key_without_key_fails(self) -> None:
        """press_key with no value or target_description fails."""
        pb = Playbook(
            service='test', flow='cancel', version=1,
            notes='', last_validated=None,
            steps=(
                PlaybookStep(action='press_key'),
            ),
        )
        result = self.executor.run(pb, self.ctx)
        assert result.success is False
        assert 'no key' in result.error_message

    def test_credentials_destroyed_on_success(self) -> None:
        """Credentials are zeroed even after successful execution."""
        ctx = _make_context()
        pb = Playbook(
            service='test', flow='cancel', version=1,
            notes='', last_validated=None,
            steps=(
                PlaybookStep(action='navigate', url='https://example.com'),
            ),
        )
        self.executor.run(pb, ctx)
        assert len(ctx.credentials) == 0

    def test_credentials_destroyed_on_failure(self) -> None:
        """Credentials are zeroed even when execution fails."""
        ctx = _make_context()
        pb = Playbook(
            service='test', flow='cancel', version=1,
            notes='', last_validated=None,
            steps=(
                PlaybookStep(action='teleport'),  # will fail
            ),
        )
        self.executor.run(pb, ctx)
        assert len(ctx.credentials) == 0

    def test_credentials_destroyed_on_exception(self) -> None:
        """Credentials are zeroed even when an unhandled exception occurs."""
        ctx = _make_context()
        # Make browser.create_session raise
        self.mocks['create_session'].side_effect = RuntimeError('Chrome not found')
        pb = Playbook(
            service='test', flow='cancel', version=1,
            notes='', last_validated=None,
            steps=(
                PlaybookStep(action='navigate', url='https://example.com'),
            ),
        )
        result = self.executor.run(pb, ctx)
        assert result.success is False
        assert len(ctx.credentials) == 0

    def test_chrome_session_closed_on_success(self) -> None:
        """browser.close_session is called after successful execution."""
        pb = Playbook(
            service='test', flow='cancel', version=1,
            notes='', last_validated=None,
            steps=(
                PlaybookStep(action='navigate', url='https://example.com'),
            ),
        )
        self.executor.run(pb, self.ctx)
        self.mocks['close_session'].assert_called_once()

    def test_chrome_session_closed_on_failure(self) -> None:
        """browser.close_session is called even when execution fails."""
        pb = Playbook(
            service='test', flow='cancel', version=1,
            notes='', last_validated=None,
            steps=(
                PlaybookStep(action='teleport'),
            ),
        )
        self.executor.run(pb, self.ctx)
        self.mocks['close_session'].assert_called_once()


# ---------------------------------------------------------------------------
# Timeout handling
# ---------------------------------------------------------------------------


class TestTimeoutHandling(_PatchedTestBase):
    """Total execution timeout stops the playbook."""

    def test_timeout_stops_execution(self) -> None:
        """When total time exceeds TOTAL_EXECUTION_TIMEOUT, execution stops."""
        # Make time.monotonic advance past the timeout
        start_time = 1000.0
        call_count = [0]

        def advancing_monotonic():
            call_count[0] += 1
            # First call: start. Subsequent: past timeout.
            if call_count[0] <= 2:
                return start_time
            return start_time + TOTAL_EXECUTION_TIMEOUT + 1

        with patch('agent.executor.time.monotonic', side_effect=advancing_monotonic):
            pb = Playbook(
                service='test', flow='cancel', version=1,
                notes='', last_validated=None,
                steps=(
                    PlaybookStep(action='navigate', url='https://one.com'),
                    PlaybookStep(action='navigate', url='https://two.com'),
                    PlaybookStep(action='navigate', url='https://three.com'),
                ),
            )
            result = self.executor.run(pb, self.ctx)

        assert result.success is False
        assert 'timeout' in result.error_message.lower()


# ---------------------------------------------------------------------------
# Step callback
# ---------------------------------------------------------------------------


class TestStepCallback(_PatchedTestBase):
    """step_callback can skip or approve steps at runtime."""

    def test_callback_skips_step(self) -> None:
        """When callback returns False, step is skipped."""
        callback = MagicMock(return_value=False)
        executor = PlaybookExecutor(
            inference=self.inference, profile=FAST, step_callback=callback,
        )
        pb = Playbook(
            service='test', flow='cancel', version=1,
            notes='', last_validated=None,
            steps=(
                PlaybookStep(action='navigate', url='https://example.com'),
            ),
        )
        result = executor.run(pb, _make_context())
        assert result.success is True
        assert result.step_results[0].skipped is True
        callback.assert_called_once()

    def test_callback_allows_step(self) -> None:
        """When callback returns True, step executes normally."""
        callback = MagicMock(return_value=True)
        executor = PlaybookExecutor(
            inference=self.inference, profile=FAST, step_callback=callback,
        )
        pb = Playbook(
            service='test', flow='cancel', version=1,
            notes='', last_validated=None,
            steps=(
                PlaybookStep(action='navigate', url='https://example.com'),
            ),
        )
        result = executor.run(pb, _make_context())
        assert result.success is True
        assert result.step_results[0].skipped is False
        self.mocks['navigate'].assert_called_once()


# ---------------------------------------------------------------------------
# Sensitive field protocol
# ---------------------------------------------------------------------------


class TestSensitiveFieldProtocol(_PatchedTestBase):
    """Sensitive steps (passwords) should not produce audit screenshots."""

    def test_sensitive_step_no_audit_screenshot(self) -> None:
        """Steps with is_sensitive=True do not get audit screenshots saved."""
        pb = Playbook(
            service='netflix', flow='cancel', version=1,
            notes='', last_validated=None,
            steps=(
                PlaybookStep(
                    action='type_text',
                    target_description='Password field',
                    value='{pass}',
                    ref_region=(200, 200, 500, 230),
                ),
            ),
        )
        result = self.executor.run(pb, self.ctx)
        assert result.success is True
        # capture_window is used for audit screenshots (not capture_to_base64)
        # Sensitive steps should NOT trigger audit screenshot
        self.mocks['capture_window'].assert_not_called()

    def test_non_sensitive_step_gets_audit_screenshot(self) -> None:
        """Non-sensitive steps do get audit screenshots."""
        pb = Playbook(
            service='netflix', flow='cancel', version=1,
            notes='', last_validated=None,
            steps=(
                PlaybookStep(
                    action='click',
                    target_description='Cancel button',
                    ref_region=(400, 300, 600, 340),
                ),
            ),
        )
        result = self.executor.run(pb, self.ctx)
        assert result.success is True
        self.mocks['capture_window'].assert_called_once()


# ---------------------------------------------------------------------------
# Handler aliases
# ---------------------------------------------------------------------------


class TestHandlerAliases(_PatchedTestBase):
    """select_plan and select_payment_method are aliases for click."""

    def test_select_plan_is_click(self) -> None:
        pb = Playbook(
            service='test', flow='cancel', version=1,
            notes='', last_validated=None,
            steps=(
                PlaybookStep(
                    action='select_plan',
                    target_description='Standard plan',
                    ref_region=(200, 200, 400, 250),
                ),
            ),
        )
        result = self.executor.run(pb, self.ctx)
        assert result.success is True
        self.mocks['mouse_click'].assert_called_once()

    def test_select_payment_method_is_click(self) -> None:
        pb = Playbook(
            service='test', flow='cancel', version=1,
            notes='', last_validated=None,
            steps=(
                PlaybookStep(
                    action='select_payment_method',
                    target_description='Credit card',
                    ref_region=(200, 300, 400, 350),
                ),
            ),
        )
        result = self.executor.run(pb, self.ctx)
        assert result.success is True
        self.mocks['mouse_click'].assert_called_once()


# ---------------------------------------------------------------------------
# ExecutionResult shape
# ---------------------------------------------------------------------------


class TestExecutionResultShape(_PatchedTestBase):
    """Verify the ExecutionResult contains expected metadata."""

    def test_result_metadata(self) -> None:
        pb = Playbook(
            service='netflix', flow='cancel', version=3,
            notes='', last_validated=None,
            steps=(
                PlaybookStep(action='navigate', url='https://netflix.com'),
                PlaybookStep(
                    action='click', target_description='Button',
                    ref_region=(100, 100, 200, 150),
                ),
            ),
        )
        result = self.executor.run(pb, self.ctx)
        assert result.job_id == 'test-001'
        assert result.service == 'netflix'
        assert result.flow == 'cancel'
        assert result.playbook_version == 3
        assert result.step_count == 2
        assert result.duration_seconds >= 0
        assert isinstance(result.step_results, list)
        assert isinstance(result.screenshots, list)

    def test_step_results_match_step_count(self) -> None:
        pb = Playbook(
            service='test', flow='cancel', version=1,
            notes='', last_validated=None,
            steps=(
                PlaybookStep(action='navigate', url='https://a.com'),
                PlaybookStep(action='navigate', url='https://b.com'),
                PlaybookStep(action='navigate', url='https://c.com'),
            ),
        )
        result = self.executor.run(pb, self.ctx)
        assert len(result.step_results) == 3
        for i, sr in enumerate(result.step_results):
            assert sr.index == i
            assert sr.action == 'navigate'


# ---------------------------------------------------------------------------
# Wander (multi-point hover)
# ---------------------------------------------------------------------------


class TestWander(_PatchedTestBase):
    """wander action: multi-point hover with optional random dwell skip."""

    def test_wander_max_points_moves_multiple(self) -> None:
        """wander with max_points=3 moves 1-3 times (never clicks)."""
        pb = Playbook(
            service='test', flow='cancel', version=1,
            notes='', last_validated=None,
            steps=(
                PlaybookStep(
                    action='wander',
                    target_description='Account menu',
                    ref_region=(100, 50, 200, 80),
                    max_points=3,
                ),
            ),
        )
        # Force randint to return max (3 points)
        with patch('agent.executor.random.randint', return_value=3):
            result = self.executor.run(pb, self.ctx)
        assert result.success is True
        # 1 initial move + 2 extra = 3 total move_to calls
        assert self.mocks['mouse_move_to'].call_count == 3
        self.mocks['mouse_click'].assert_not_called()

    def test_wander_max_points_one_moves_once(self) -> None:
        """wander with max_points=1 (default) moves exactly once."""
        pb = Playbook(
            service='test', flow='cancel', version=1,
            notes='', last_validated=None,
            steps=(
                PlaybookStep(
                    action='wander',
                    target_description='Menu',
                    ref_region=(100, 50, 200, 80),
                ),
            ),
        )
        with patch('agent.executor.random.randint', return_value=1):
            result = self.executor.run(pb, self.ctx)
        assert result.success is True
        self.mocks['mouse_move_to'].assert_called_once()

    def test_wander_random_dwell_skips(self) -> None:
        """wander with random_dwell=True skips when coin flip < 0.5."""
        pb = Playbook(
            service='test', flow='cancel', version=1,
            notes='', last_validated=None,
            steps=(
                PlaybookStep(
                    action='wander',
                    target_description='Menu',
                    ref_region=(100, 50, 200, 80),
                    random_dwell=True,
                ),
            ),
        )
        with patch('agent.executor.random.random', return_value=0.2):  # < 0.5 -> skip
            result = self.executor.run(pb, self.ctx)
        assert result.success is True
        # Skipped: no mouse movement, no inference call
        self.mocks['mouse_move_to'].assert_not_called()
        assert result.inference_count == 0

    def test_wander_random_dwell_executes(self) -> None:
        """wander with random_dwell=True proceeds when coin flip >= 0.5."""
        pb = Playbook(
            service='test', flow='cancel', version=1,
            notes='', last_validated=None,
            steps=(
                PlaybookStep(
                    action='wander',
                    target_description='Menu',
                    ref_region=(100, 50, 200, 80),
                    random_dwell=True,
                ),
            ),
        )
        with patch('agent.executor.random.random', return_value=0.8):  # >= 0.5 -> proceed
            result = self.executor.run(pb, self.ctx)
        assert result.success is True
        self.mocks['mouse_move_to'].assert_called()
        assert result.inference_count >= 1

    def test_hover_alias_still_works(self) -> None:
        """'hover' action is a working alias for 'wander'."""
        pb = Playbook(
            service='test', flow='cancel', version=1,
            notes='', last_validated=None,
            steps=(
                PlaybookStep(
                    action='hover',
                    target_description='Menu',
                    ref_region=(100, 50, 200, 80),
                    max_points=2,
                ),
            ),
        )
        with patch('agent.executor.random.randint', return_value=2):
            result = self.executor.run(pb, self.ctx)
        assert result.success is True
        assert self.mocks['mouse_move_to'].call_count == 2
        self.mocks['mouse_click'].assert_not_called()

    def test_click_unchanged_by_wander_refactor(self) -> None:
        """click action still works (regression guard for _find_and_convert change)."""
        pb = Playbook(
            service='test', flow='cancel', version=1,
            notes='', last_validated=None,
            steps=(
                PlaybookStep(
                    action='click',
                    target_description='Sign In',
                    ref_region=(500, 300, 700, 350),
                ),
            ),
        )
        result = self.executor.run(pb, self.ctx)
        assert result.success is True
        self.mocks['mouse_click'].assert_called_once()
        self.mocks['mouse_move_to'].assert_not_called()
