"""Tests for VLMExecutor: the VLM-driven production executor."""

from __future__ import annotations

import asyncio
from unittest.mock import MagicMock, patch

import pytest

from agent.playbook import ExecutionResult
from agent.vlm_executor import (
    VLMExecutor,
    _StuckDetector,
    _infer_credential_from_target,
    _resolve_credential,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_vlm(responses: list[dict]) -> MagicMock:
    """Create a mock VLMClient that returns canned responses in order.

    Each response is returned as (response_dict, 1.0) where 1.0 is scale_factor.
    """
    vlm = MagicMock()
    vlm.analyze = MagicMock(side_effect=[(r, 1.0) for r in responses])
    vlm.last_inference_ms = 100
    return vlm


def _make_session():
    """Create a mock BrowserSession."""
    session = MagicMock()
    session.pid = 12345
    session.window_id = 42
    session.bounds = {'x': 0, 'y': 0, 'width': 1280, 'height': 900}
    session.profile_dir = '/tmp/ub-chrome-test'
    return session


# Common response dicts
SIGNED_IN = {'page_type': 'signed_in', 'confidence': 0.99, 'reasoning': 'logged in'}

CANCEL_DONE = {
    'state': 'confirmation',
    'action': 'done',
    'confidence': 0.95,
    'reasoning': 'cancel confirmed',
    'billing_end_date': '2026-03-15',
}

CANCEL_CLICK = {
    'state': 'account page',
    'action': 'click',
    'target_description': 'Cancel Membership button',
    'bounding_box': [100, 200, 300, 250],
    'confidence': 0.90,
    'reasoning': 'found cancel button',
}

RESUME_DONE = {
    'state': 'reactivated',
    'action': 'done',
    'confidence': 0.95,
    'reasoning': 'subscription reactivated',
    'billing_end_date': None,
}

USER_PASS_PAGE = {
    'page_type': 'user_pass',
    'email_box': [100, 200, 400, 230],
    'password_box': [100, 260, 400, 290],
    'button_box': [150, 320, 350, 360],
    'profile_box': None,
    'code_boxes': None,
    'confidence': 0.95,
    'reasoning': 'email and password fields visible',
}

USER_ONLY_PAGE = {
    'page_type': 'user_only',
    'email_box': [100, 200, 400, 230],
    'password_box': None,
    'button_box': [150, 270, 350, 300],
    'profile_box': None,
    'code_boxes': None,
    'confidence': 0.93,
    'reasoning': 'email field only',
}

PROFILE_SELECT_PAGE = {
    'page_type': 'profile_select',
    'email_box': None,
    'password_box': None,
    'button_box': None,
    'profile_box': [200, 300, 400, 500],
    'code_boxes': None,
    'confidence': 0.97,
    'reasoning': 'profile picker',
}

EMAIL_CODE_PAGE = {
    'page_type': 'email_code_single',
    'email_box': None,
    'password_box': None,
    'button_box': [200, 400, 350, 440],
    'profile_box': None,
    'code_boxes': [{'label': 'code', 'box': [100, 300, 400, 340]}],
    'confidence': 0.92,
    'reasoning': 'verification code entry',
}

CAPTCHA_PAGE = {
    'page_type': 'captcha',
    'email_box': None,
    'password_box': None,
    'button_box': None,
    'profile_box': None,
    'code_boxes': None,
    'confidence': 0.88,
    'reasoning': 'captcha challenge detected',
}


# ---------------------------------------------------------------------------
# Patches applied to all executor tests (no real Chrome, screenshots, etc.)
# ---------------------------------------------------------------------------

@pytest.fixture(autouse=True)
def _mock_system(monkeypatch):
    """Mock all system interactions: browser, screenshots, input, time.sleep."""
    session = _make_session()

    monkeypatch.setattr('agent.vlm_executor.browser.create_session', lambda: session)
    monkeypatch.setattr('agent.vlm_executor.browser.navigate', lambda *a, **kw: None)
    monkeypatch.setattr('agent.vlm_executor.browser.get_session_window', lambda s: s.bounds)
    monkeypatch.setattr('agent.vlm_executor.browser.close_session', lambda s: None)
    monkeypatch.setattr('agent.vlm_executor.ss.capture_to_base64', lambda wid: 'AAAA')
    monkeypatch.setattr('agent.vlm_executor.crop_browser_chrome', lambda b64: (b64, 88))
    monkeypatch.setattr('agent.vlm_executor.mouse.click', lambda x, y, fast=False: None)
    monkeypatch.setattr('agent.vlm_executor.mouse.move_to', lambda x, y, fast=False: None)
    monkeypatch.setattr('agent.vlm_executor.keyboard.hotkey', lambda *a: None)
    monkeypatch.setattr('agent.vlm_executor.keyboard.press_key', lambda k: None)
    monkeypatch.setattr('agent.vlm_executor.keyboard.type_text', lambda *a, **kw: None)
    monkeypatch.setattr('agent.vlm_executor.scroll_mod.scroll', lambda d, c: None)
    monkeypatch.setattr('agent.vlm_executor.coords.image_to_screen',
                        lambda x, y, bounds, chrome_offset=0: (x, y))
    monkeypatch.setattr('agent.vlm_executor.focus_window_by_pid', lambda pid: None)
    monkeypatch.setattr('agent.vlm_executor._clipboard_copy', lambda t: None)
    monkeypatch.setattr('agent.vlm_executor.time.sleep', lambda s: None)
    monkeypatch.setattr('agent.vlm_executor.random.gauss', lambda mu, sigma: mu)
    monkeypatch.setattr('agent.vlm_executor.random.uniform', lambda a, b: a)
    monkeypatch.setattr('agent.vlm_executor.random.random', lambda: 0.5)  # >0.4 = type, not paste


# ---------------------------------------------------------------------------
# _resolve_credential tests
# ---------------------------------------------------------------------------

class TestResolveCredential:
    def test_email_match(self):
        template, actual, sensitive = _resolve_credential(
            'the email address', {'email': 'a@b.com', 'pass': 'x'},
        )
        assert template == '{email}'
        assert actual == 'a@b.com'
        assert not sensitive

    def test_password_match(self):
        template, actual, sensitive = _resolve_credential(
            'the password', {'email': 'a@b.com', 'pass': 'x'},
        )
        assert template == '{pass}'
        assert actual == 'x'
        assert sensitive

    def test_no_match_returns_literal(self):
        template, actual, sensitive = _resolve_credential(
            'some random text', {},
        )
        assert template == 'some random text'
        assert actual == 'some random text'
        assert not sensitive

    def test_missing_credential_key(self):
        template, actual, sensitive = _resolve_credential(
            'the email address', {},
        )
        assert template == '{email}'
        assert actual == ''
        assert not sensitive


# ---------------------------------------------------------------------------
# _StuckDetector tests
# ---------------------------------------------------------------------------

class TestStuckDetector:
    def test_detects_repeated_state_action(self):
        sd = _StuckDetector(threshold=3)
        assert not sd.check('s1', 'click', 'aaa')
        assert not sd.check('s1', 'click', 'bbb')
        assert sd.check('s1', 'click', 'ccc')

    def test_does_not_trigger_for_wait(self):
        sd = _StuckDetector(threshold=3)
        assert not sd.check('s1', 'wait', 'aaa')
        assert not sd.check('s1', 'wait', 'aaa')
        # State+action history is empty for waits, so no trigger from that
        # But screenshot hash check can still trigger
        assert sd.check('s1', 'wait', 'aaa')  # screenshot hash repeated 3x

    def test_detects_identical_screenshots(self):
        sd = _StuckDetector(threshold=3)
        assert not sd.check('s1', 'a1', 'same_img')
        assert not sd.check('s2', 'a2', 'same_img')
        assert sd.check('s3', 'a3', 'same_img')

    def test_reset_clears_history(self):
        sd = _StuckDetector(threshold=3)
        sd.check('s1', 'click', 'aaa')
        sd.check('s1', 'click', 'bbb')
        sd.reset()
        assert not sd.check('s1', 'click', 'ccc')
        assert not sd.check('s1', 'click', 'ddd')
        assert sd.check('s1', 'click', 'eee')


# ---------------------------------------------------------------------------
# _infer_credential_from_target tests
# ---------------------------------------------------------------------------

class TestInferCredentialFromTarget:
    def test_email_input_field(self):
        assert _infer_credential_from_target('email input field') == 'the email address'

    def test_password_input_box(self):
        assert _infer_credential_from_target('password input box') == 'the password'

    def test_button_excluded(self):
        assert _infer_credential_from_target('email submit button') is None

    def test_no_field_indicator(self):
        assert _infer_credential_from_target('email address') is None

    def test_cvv_field(self):
        assert _infer_credential_from_target('CVV input field') == 'the cvv'


# ---------------------------------------------------------------------------
# VLMExecutor.run() tests
# ---------------------------------------------------------------------------

class TestVLMExecutorRun:
    def test_unknown_service_fails(self):
        vlm = _make_vlm([])
        executor = VLMExecutor(vlm)
        result = executor.run('nonexistent', 'cancel', {'email': 'a', 'pass': 'b'})
        assert not result.success
        assert 'Unknown service' in result.error_message

    def test_unknown_action_fails(self):
        vlm = _make_vlm([SIGNED_IN])
        executor = VLMExecutor(vlm)
        result = executor.run('netflix', 'upgrade', {'email': 'a', 'pass': 'b'})
        assert not result.success
        assert 'Unknown action' in result.error_message

    def test_successful_cancel_flow(self):
        """Sign in -> click cancel -> done."""
        vlm = _make_vlm([USER_PASS_PAGE, SIGNED_IN, CANCEL_CLICK, CANCEL_DONE])
        executor = VLMExecutor(vlm, settle_delay=0)
        result = executor.run('netflix', 'cancel', {'email': 'a@b.com', 'pass': 'x'})
        assert result.success
        assert result.billing_date == '2026-03-15'
        assert result.inference_count == 4

    def test_successful_resume_flow(self):
        """Sign in -> done (resume)."""
        vlm = _make_vlm([SIGNED_IN, RESUME_DONE])
        executor = VLMExecutor(vlm, settle_delay=0)
        result = executor.run('netflix', 'resume', {'email': 'a@b.com', 'pass': 'x'})
        assert result.success
        assert result.billing_date is None

    def test_credentials_zeroed_on_success(self):
        vlm = _make_vlm([SIGNED_IN, CANCEL_DONE])
        executor = VLMExecutor(vlm, settle_delay=0)
        creds = {'email': 'test@x.com', 'pass': 'secret'}
        executor.run('netflix', 'cancel', creds)
        assert len(creds) == 0

    def test_credentials_zeroed_on_failure(self):
        vlm = _make_vlm([CAPTCHA_PAGE])
        executor = VLMExecutor(vlm, settle_delay=0)
        creds = {'email': 'test@x.com', 'pass': 'secret'}
        executor.run('netflix', 'cancel', creds)
        assert len(creds) == 0

    def test_chrome_closed_on_success(self):
        with patch('agent.vlm_executor.browser.close_session') as mock_close:
            vlm = _make_vlm([SIGNED_IN, CANCEL_DONE])
            executor = VLMExecutor(vlm, settle_delay=0)
            executor.run('netflix', 'cancel', {'email': 'a', 'pass': 'b'})
            mock_close.assert_called_once()

    def test_chrome_closed_on_failure(self):
        with patch('agent.vlm_executor.browser.close_session') as mock_close:
            vlm = _make_vlm([CAPTCHA_PAGE])
            executor = VLMExecutor(vlm, settle_delay=0)
            executor.run('netflix', 'cancel', {'email': 'a', 'pass': 'b'})
            mock_close.assert_called_once()

    def test_max_steps_exceeded(self, monkeypatch):
        # Different screenshot each time to avoid stuck detection
        call_count = 0
        def varying_screenshot(wid):
            nonlocal call_count
            call_count += 1
            return f'screenshot_{call_count}'
        monkeypatch.setattr('agent.vlm_executor.ss.capture_to_base64', varying_screenshot)

        # VLM keeps saying "click" on different targets to avoid stuck
        click_responses = []
        for i in range(5):
            click_responses.append({
                'state': f'page_{i}',
                'action': 'click',
                'target_description': f'button_{i}',
                'bounding_box': [100 + i, 200, 300 + i, 250],
                'confidence': 0.8,
                'reasoning': f'click button {i}',
            })
        responses = [SIGNED_IN] + click_responses
        vlm = _make_vlm(responses)
        executor = VLMExecutor(vlm, settle_delay=0, max_steps=5)
        result = executor.run('netflix', 'cancel', {'email': 'a', 'pass': 'b'})
        assert not result.success
        assert 'Max steps' in result.error_message

    def test_captcha_during_signin_fails(self):
        vlm = _make_vlm([CAPTCHA_PAGE])
        executor = VLMExecutor(vlm, settle_delay=0)
        result = executor.run('netflix', 'cancel', {'email': 'a', 'pass': 'b'})
        assert not result.success
        assert 'CAPTCHA' in result.error_message

    def test_need_human_during_cancel_fails(self):
        need_human = {
            'state': 'need_human',
            'action': 'need_human',
            'confidence': 0.5,
            'reasoning': 'unexpected popup',
        }
        vlm = _make_vlm([SIGNED_IN, need_human])
        executor = VLMExecutor(vlm, settle_delay=0)
        result = executor.run('netflix', 'cancel', {'email': 'a', 'pass': 'b'})
        assert not result.success
        assert 'human intervention' in result.error_message.lower()

    def test_stuck_during_signin_fails(self):
        """Same page_type 3 times -> stuck."""
        vlm = _make_vlm([USER_PASS_PAGE, USER_PASS_PAGE, USER_PASS_PAGE])
        executor = VLMExecutor(vlm, settle_delay=0)
        result = executor.run('netflix', 'cancel', {'email': 'a', 'pass': 'b'})
        assert not result.success
        assert 'Stuck' in result.error_message

    def test_stuck_during_cancel_fails(self):
        """Same state+action 3 times during cancel phase -> stuck."""
        vlm = _make_vlm([SIGNED_IN, CANCEL_CLICK, CANCEL_CLICK, CANCEL_CLICK])
        executor = VLMExecutor(vlm, settle_delay=0)
        result = executor.run('netflix', 'cancel', {'email': 'a', 'pass': 'b'})
        assert not result.success
        assert 'Stuck' in result.error_message

    def test_billing_date_extraction(self):
        done_with_date = {
            'state': 'confirmation',
            'action': 'done',
            'confidence': 0.95,
            'reasoning': 'cancelled',
            'billing_end_date': '2026-04-01',
        }
        vlm = _make_vlm([SIGNED_IN, done_with_date])
        executor = VLMExecutor(vlm, settle_delay=0)
        result = executor.run('netflix', 'cancel', {'email': 'a', 'pass': 'b'})
        assert result.success
        assert result.billing_date == '2026-04-01'

    def test_billing_date_null(self):
        done_no_date = {
            'state': 'confirmation',
            'action': 'done',
            'confidence': 0.95,
            'reasoning': 'cancelled',
            'billing_end_date': None,
        }
        vlm = _make_vlm([SIGNED_IN, done_no_date])
        executor = VLMExecutor(vlm, settle_delay=0)
        result = executor.run('netflix', 'cancel', {'email': 'a', 'pass': 'b'})
        assert result.success
        assert result.billing_date is None

    def test_scroll_action(self):
        scroll_down = {
            'state': 'account page',
            'action': 'scroll_down',
            'confidence': 0.8,
            'reasoning': 'need to scroll to find cancel',
        }
        vlm = _make_vlm([SIGNED_IN, scroll_down, CANCEL_DONE])
        executor = VLMExecutor(vlm, settle_delay=0)
        result = executor.run('netflix', 'cancel', {'email': 'a', 'pass': 'b'})
        assert result.success

    def test_press_key_action(self):
        press_enter = {
            'state': 'dialog',
            'action': 'press_key',
            'key_to_press': 'enter',
            'confidence': 0.85,
            'reasoning': 'confirm dialog',
        }
        vlm = _make_vlm([SIGNED_IN, press_enter, CANCEL_DONE])
        executor = VLMExecutor(vlm, settle_delay=0)
        result = executor.run('netflix', 'cancel', {'email': 'a', 'pass': 'b'})
        assert result.success

    def test_vlm_error_recovery(self):
        """VLM throws on first cancel call, succeeds on retry."""
        vlm = MagicMock()
        vlm.analyze = MagicMock(side_effect=[
            (SIGNED_IN, 1.0),
            RuntimeError('API timeout'),
            (CANCEL_DONE, 1.0),
        ])
        vlm.last_inference_ms = 100
        executor = VLMExecutor(vlm, settle_delay=0)
        result = executor.run('netflix', 'cancel', {'email': 'a', 'pass': 'b'})
        assert result.success

    def test_type_text_action(self):
        type_action = {
            'state': 'form',
            'action': 'type_text',
            'text_to_type': 'the email address',
            'target_description': 'email field',
            'confidence': 0.9,
            'reasoning': 'type email',
        }
        vlm = _make_vlm([SIGNED_IN, type_action, CANCEL_DONE])
        executor = VLMExecutor(vlm, settle_delay=0)
        result = executor.run('netflix', 'cancel', {'email': 'test@x.com', 'pass': 'p'})
        assert result.success

    def test_all_seven_services(self):
        """All 7 services are accepted."""
        for service in ('netflix', 'hulu', 'disney', 'appletv',
                        'paramount', 'peacock', 'max'):
            vlm = _make_vlm([SIGNED_IN, CANCEL_DONE])
            executor = VLMExecutor(vlm, settle_delay=0)
            result = executor.run(service, 'cancel', {'email': 'a', 'pass': 'b'})
            assert result.success, f'{service} failed'


# ---------------------------------------------------------------------------
# Sign-in page dispatch tests
# ---------------------------------------------------------------------------

class TestSigninPageDispatch:
    def test_user_pass(self):
        """user_pass page triggers email + password + enter."""
        vlm = _make_vlm([USER_PASS_PAGE, SIGNED_IN, CANCEL_DONE])
        executor = VLMExecutor(vlm, settle_delay=0)
        result = executor.run('netflix', 'cancel', {'email': 'a@b.com', 'pass': 'x'})
        assert result.success

    def test_user_only(self):
        vlm = _make_vlm([USER_ONLY_PAGE, SIGNED_IN, CANCEL_DONE])
        executor = VLMExecutor(vlm, settle_delay=0)
        result = executor.run('netflix', 'cancel', {'email': 'a@b.com', 'pass': 'x'})
        assert result.success

    def test_pass_only(self):
        pass_only = {
            'page_type': 'pass_only',
            'email_box': None,
            'password_box': [100, 200, 400, 230],
            'button_box': None,
            'profile_box': None,
            'code_boxes': None,
            'confidence': 0.91,
            'reasoning': 'password only',
        }
        vlm = _make_vlm([pass_only, SIGNED_IN, CANCEL_DONE])
        executor = VLMExecutor(vlm, settle_delay=0)
        result = executor.run('netflix', 'cancel', {'email': 'a@b.com', 'pass': 'x'})
        assert result.success

    def test_profile_select(self):
        vlm = _make_vlm([PROFILE_SELECT_PAGE, SIGNED_IN, CANCEL_DONE])
        executor = VLMExecutor(vlm, settle_delay=0)
        result = executor.run('netflix', 'cancel', {'email': 'a', 'pass': 'b'})
        assert result.success

    def test_button_only(self):
        button_only = {
            'page_type': 'button_only',
            'email_box': None,
            'password_box': None,
            'button_box': [200, 300, 400, 340],
            'profile_box': None,
            'code_boxes': None,
            'confidence': 0.89,
            'reasoning': 'sign in button only',
        }
        vlm = _make_vlm([button_only, SIGNED_IN, CANCEL_DONE])
        executor = VLMExecutor(vlm, settle_delay=0)
        result = executor.run('netflix', 'cancel', {'email': 'a', 'pass': 'b'})
        assert result.success

    def test_spinner_continues(self):
        spinner = {
            'page_type': 'spinner',
            'email_box': None,
            'password_box': None,
            'button_box': None,
            'profile_box': None,
            'code_boxes': None,
            'confidence': 0.95,
            'reasoning': 'page loading',
        }
        vlm = _make_vlm([spinner, SIGNED_IN, CANCEL_DONE])
        executor = VLMExecutor(vlm, settle_delay=0)
        result = executor.run('netflix', 'cancel', {'email': 'a', 'pass': 'b'})
        assert result.success


# ---------------------------------------------------------------------------
# OTP callback tests
# ---------------------------------------------------------------------------

class TestOTPCallback:
    def test_otp_callback_invoked(self):
        """OTP page triggers the callback and pastes the code."""
        loop = asyncio.new_event_loop()

        async def mock_otp_callback(job_id, service, prompt=None):
            return '123456'

        vlm = _make_vlm([EMAIL_CODE_PAGE, SIGNED_IN, CANCEL_DONE])
        executor = VLMExecutor(
            vlm, settle_delay=0,
            otp_callback=mock_otp_callback,
            loop=loop,
        )

        # Run the loop in a thread to allow run_coroutine_threadsafe to work
        import threading
        thread = threading.Thread(target=loop.run_forever, daemon=True)
        thread.start()
        try:
            result = executor.run('netflix', 'cancel', {'email': 'a', 'pass': 'b'})
            assert result.success
        finally:
            loop.call_soon_threadsafe(loop.stop)
            thread.join(timeout=2)
            loop.close()

    def test_otp_no_callback_fails(self):
        """OTP page without callback -> need_human."""
        vlm = _make_vlm([EMAIL_CODE_PAGE])
        executor = VLMExecutor(vlm, settle_delay=0)
        result = executor.run('netflix', 'cancel', {'email': 'a', 'pass': 'b'})
        assert not result.success
        assert 'human intervention' in result.error_message.lower()

    def test_otp_callback_returns_none_fails(self):
        """OTP callback returns None (timeout) -> need_human."""
        loop = asyncio.new_event_loop()

        async def mock_otp_timeout(job_id, service, prompt=None):
            return None

        vlm = _make_vlm([EMAIL_CODE_PAGE])
        executor = VLMExecutor(
            vlm, settle_delay=0,
            otp_callback=mock_otp_timeout,
            loop=loop,
        )

        import threading
        thread = threading.Thread(target=loop.run_forever, daemon=True)
        thread.start()
        try:
            result = executor.run('netflix', 'cancel', {'email': 'a', 'pass': 'b'})
            assert not result.success
        finally:
            loop.call_soon_threadsafe(loop.stop)
            thread.join(timeout=2)
            loop.close()


# ---------------------------------------------------------------------------
# Auto-type after click tests
# ---------------------------------------------------------------------------

class TestAutoTypeAfterClick:
    def test_click_email_field_auto_types(self):
        """Clicking an 'email input field' auto-types the credential."""
        click_email_field = {
            'state': 'form',
            'action': 'click',
            'target_description': 'email input field',
            'bounding_box': [100, 200, 400, 230],
            'confidence': 0.9,
            'reasoning': 'click email field',
        }
        vlm = _make_vlm([SIGNED_IN, click_email_field, CANCEL_DONE])
        executor = VLMExecutor(vlm, settle_delay=0)
        result = executor.run('netflix', 'cancel', {'email': 'a@b.com', 'pass': 'x'})
        assert result.success
        # step_count: 1 (navigate) + 1 (signin) + 1 (click) + 1 (auto-type) + 0 (done doesn't count as step)
        assert result.step_count >= 4

    def test_click_button_no_auto_type(self):
        """Clicking a 'Cancel button' does NOT auto-type."""
        click_button = {
            'state': 'account',
            'action': 'click',
            'target_description': 'Cancel Membership button',
            'bounding_box': [100, 200, 300, 250],
            'confidence': 0.9,
            'reasoning': 'click cancel',
        }
        vlm = _make_vlm([SIGNED_IN, click_button, CANCEL_DONE])
        executor = VLMExecutor(vlm, settle_delay=0)
        result = executor.run('netflix', 'cancel', {'email': 'a', 'pass': 'b'})
        assert result.success


# ---------------------------------------------------------------------------
# Credential callback tests
# ---------------------------------------------------------------------------

class TestCredentialCallback:
    def test_type_text_cvv_triggers_callback(self):
        """type_text with CVV hint and no cvv credential triggers credential callback."""
        type_cvv = {
            'state': 'payment',
            'action': 'type_text',
            'text_to_type': 'the cvv',
            'target_description': 'CVV field',
            'confidence': 0.9,
            'reasoning': 'type cvv',
        }
        loop = asyncio.new_event_loop()
        calls = []

        async def cred_callback(job_id, service, credential_name):
            calls.append((job_id, service, credential_name))
            return '123'

        vlm = _make_vlm([SIGNED_IN, type_cvv, CANCEL_DONE])

        import threading
        thread = threading.Thread(target=loop.run_forever, daemon=True)
        thread.start()
        try:
            executor = VLMExecutor(
                vlm, settle_delay=0,
                credential_callback=cred_callback,
                loop=loop,
            )
            result = executor.run(
                'netflix', 'cancel',
                {'email': 'a@b.com', 'pass': 'x'},
                job_id='job-cred',
            )
            assert result.success
            assert len(calls) == 1
            assert calls[0] == ('job-cred', 'netflix', 'cvv')
        finally:
            loop.call_soon_threadsafe(loop.stop)
            thread.join(timeout=2)
            loop.close()

    def test_click_cvv_field_triggers_callback(self):
        """Clicking a CVV input field with no cvv credential triggers callback."""
        click_cvv = {
            'state': 'payment',
            'action': 'click',
            'target_description': 'CVV input field',
            'bounding_box': [100, 200, 300, 230],
            'confidence': 0.9,
            'reasoning': 'click cvv field',
        }
        loop = asyncio.new_event_loop()
        calls = []

        async def cred_callback(job_id, service, credential_name):
            calls.append((job_id, service, credential_name))
            return '456'

        vlm = _make_vlm([SIGNED_IN, click_cvv, CANCEL_DONE])

        import threading
        thread = threading.Thread(target=loop.run_forever, daemon=True)
        thread.start()
        try:
            executor = VLMExecutor(
                vlm, settle_delay=0,
                credential_callback=cred_callback,
                loop=loop,
            )
            result = executor.run(
                'netflix', 'cancel',
                {'email': 'a@b.com', 'pass': 'x'},
                job_id='job-cred2',
            )
            assert result.success
            assert len(calls) == 1
            assert calls[0] == ('job-cred2', 'netflix', 'cvv')
        finally:
            loop.call_soon_threadsafe(loop.stop)
            thread.join(timeout=2)
            loop.close()

    def test_credential_persists_in_session(self):
        """Once callback provides a credential, it persists for subsequent uses."""
        type_cvv_1 = {
            'state': 'payment',
            'action': 'type_text',
            'text_to_type': 'the cvv',
            'confidence': 0.9,
            'reasoning': 'type cvv again',
        }
        type_cvv_2 = {
            'state': 'payment retry',
            'action': 'type_text',
            'text_to_type': 'the cvv',
            'confidence': 0.9,
            'reasoning': 'type cvv again',
        }
        loop = asyncio.new_event_loop()
        calls = []

        async def cred_callback(job_id, service, credential_name):
            calls.append(credential_name)
            return '789'

        vlm = _make_vlm([SIGNED_IN, type_cvv_1, type_cvv_2, CANCEL_DONE])

        import threading
        thread = threading.Thread(target=loop.run_forever, daemon=True)
        thread.start()
        try:
            executor = VLMExecutor(
                vlm, settle_delay=0,
                credential_callback=cred_callback,
                loop=loop,
            )
            result = executor.run(
                'netflix', 'cancel',
                {'email': 'a@b.com', 'pass': 'x'},
                job_id='job-persist',
            )
            assert result.success
            # Callback only called once; second use finds it in credentials dict
            assert len(calls) == 1
        finally:
            loop.call_soon_threadsafe(loop.stop)
            thread.join(timeout=2)
            loop.close()

    def test_no_callback_skips_credential(self):
        """With no credential callback, missing credential is silently skipped."""
        type_cvv = {
            'state': 'payment',
            'action': 'type_text',
            'text_to_type': 'the cvv',
            'confidence': 0.9,
            'reasoning': 'type cvv',
        }
        vlm = _make_vlm([SIGNED_IN, type_cvv, CANCEL_DONE])
        executor = VLMExecutor(vlm, settle_delay=0)
        result = executor.run(
            'netflix', 'cancel',
            {'email': 'a@b.com', 'pass': 'x'},
        )
        assert result.success

    def test_callback_returns_none_skips(self):
        """If credential callback returns None, credential is skipped."""
        type_cvv = {
            'state': 'payment',
            'action': 'type_text',
            'text_to_type': 'the cvv',
            'confidence': 0.9,
            'reasoning': 'type cvv',
        }
        loop = asyncio.new_event_loop()

        async def cred_callback(job_id, service, credential_name):
            return None

        vlm = _make_vlm([SIGNED_IN, type_cvv, CANCEL_DONE])

        import threading
        thread = threading.Thread(target=loop.run_forever, daemon=True)
        thread.start()
        try:
            executor = VLMExecutor(
                vlm, settle_delay=0,
                credential_callback=cred_callback,
                loop=loop,
            )
            result = executor.run(
                'netflix', 'cancel',
                {'email': 'a@b.com', 'pass': 'x'},
            )
            assert result.success
        finally:
            loop.call_soon_threadsafe(loop.stop)
            thread.join(timeout=2)
            loop.close()

    def test_existing_credential_no_callback(self):
        """When credential already in dict, callback is NOT called."""
        type_cvv = {
            'state': 'payment',
            'action': 'type_text',
            'text_to_type': 'the cvv',
            'confidence': 0.9,
            'reasoning': 'type cvv',
        }
        loop = asyncio.new_event_loop()
        calls = []

        async def cred_callback(job_id, service, credential_name):
            calls.append(credential_name)
            return '999'

        vlm = _make_vlm([SIGNED_IN, type_cvv, CANCEL_DONE])

        import threading
        thread = threading.Thread(target=loop.run_forever, daemon=True)
        thread.start()
        try:
            executor = VLMExecutor(
                vlm, settle_delay=0,
                credential_callback=cred_callback,
                loop=loop,
            )
            result = executor.run(
                'netflix', 'cancel',
                {'email': 'a@b.com', 'pass': 'x', 'cvv': '321'},
            )
            assert result.success
            # Callback never called because cvv was already in credentials
            assert len(calls) == 0
        finally:
            loop.call_soon_threadsafe(loop.stop)
            thread.join(timeout=2)
            loop.close()


# ---------------------------------------------------------------------------
# ExecutionResult structure tests
# ---------------------------------------------------------------------------

class TestExecutionResultStructure:
    def test_successful_result_fields(self):
        vlm = _make_vlm([SIGNED_IN, CANCEL_DONE])
        executor = VLMExecutor(vlm, settle_delay=0)
        result = executor.run('netflix', 'cancel', {'email': 'a', 'pass': 'b'})
        assert isinstance(result, ExecutionResult)
        assert result.job_id == ''
        assert result.service == 'netflix'
        assert result.flow == 'cancel'
        assert result.success is True
        assert result.duration_seconds >= 0
        assert result.inference_count == 2

    def test_custom_job_id(self):
        vlm = _make_vlm([SIGNED_IN, CANCEL_DONE])
        executor = VLMExecutor(vlm, settle_delay=0)
        result = executor.run('netflix', 'cancel', {'email': 'a', 'pass': 'b'},
                              job_id='job-42')
        assert result.job_id == 'job-42'


# ---------------------------------------------------------------------------
# GUI lock serialization tests
# ---------------------------------------------------------------------------

import threading
import time as _time

from agent import gui_lock as _gl_mod


class TestGUILockSerialization:
    """Verify that concurrent executors serialize GUI actions via gui_lock."""

    def test_gui_actions_acquire_lock(self, monkeypatch):
        """GUI actions (click, type, scroll) should acquire gui_lock.

        We verify by checking that focus_window_by_pid is called before
        each GUI action sequence during the cancel phase.
        """
        focus_calls = []

        def tracking_focus(pid):
            focus_calls.append(('focus', pid))

        monkeypatch.setattr('agent.vlm_executor.focus_window_by_pid', tracking_focus)

        vlm = _make_vlm([SIGNED_IN, CANCEL_CLICK, CANCEL_DONE])
        executor = VLMExecutor(vlm, settle_delay=0)
        result = executor.run('netflix', 'cancel', {'email': 'a', 'pass': 'b'},
                              job_id='job-focus')
        assert result.success
        # focus_window_by_pid called at least once for the click action
        assert len(focus_calls) >= 1
        assert focus_calls[0][1] == 12345  # mock session PID

    def test_two_executors_serialize_gui(self, monkeypatch):
        """Two executors in threads: GUI actions never overlap.

        We track lock acquire/release times and verify no overlap.
        """
        gui_events = []

        class TrackingLock:
            def __init__(self):
                self._lock = threading.Lock()

            def __enter__(self):
                self._lock.acquire()
                gui_events.append(('acquire', _time.monotonic()))
                return self

            def __exit__(self, *args):
                gui_events.append(('release', _time.monotonic()))
                self._lock.release()

        tracking = TrackingLock()
        monkeypatch.setattr('agent.vlm_executor.gui_lock', tracking)

        def run_job(job_id):
            vlm = _make_vlm([SIGNED_IN, CANCEL_CLICK, CANCEL_DONE])
            executor = VLMExecutor(vlm, settle_delay=0)
            return executor.run('netflix', 'cancel',
                               {'email': 'a', 'pass': 'b'},
                               job_id=job_id)

        results = [None, None]
        threads = []
        for i in range(2):
            t = threading.Thread(
                target=lambda idx=i: results.__setitem__(
                    idx, run_job(f'job-{idx}')
                ),
            )
            threads.append(t)

        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=10)

        assert results[0] is not None and results[0].success
        assert results[1] is not None and results[1].success

        # Verify no overlapping lock holds
        held = 0
        for event_type, ts in gui_events:
            if event_type == 'acquire':
                held += 1
                assert held <= 1, f'Lock held by {held} threads simultaneously'
            elif event_type == 'release':
                held -= 1
                assert held >= 0

    def test_otp_wait_does_not_hold_gui_lock(self):
        """OTP wait blocks on future.result(), NOT inside gui_lock.

        Verify that another thread can acquire gui_lock while one
        executor is waiting for OTP.
        """
        otp_waiting = threading.Event()
        otp_code = threading.Event()
        lock_acquired_during_otp = threading.Event()

        loop = asyncio.new_event_loop()

        async def slow_otp_callback(job_id, service, prompt=None):
            otp_waiting.set()
            otp_code.wait(timeout=5)
            return '999999'

        def try_lock_during_otp():
            otp_waiting.wait(timeout=5)
            # gui_lock should be free (OTP wait doesn't hold it)
            acquired = _gl_mod.gui_lock.acquire(timeout=2)
            if acquired:
                lock_acquired_during_otp.set()
                _gl_mod.gui_lock.release()

        vlm = _make_vlm([EMAIL_CODE_PAGE, SIGNED_IN, CANCEL_DONE])
        executor = VLMExecutor(
            vlm, settle_delay=0,
            otp_callback=slow_otp_callback,
            loop=loop,
        )

        loop_thread = threading.Thread(target=loop.run_forever, daemon=True)
        loop_thread.start()

        lock_thread = threading.Thread(target=try_lock_during_otp, daemon=True)
        lock_thread.start()

        try:
            def run_executor():
                return executor.run('netflix', 'cancel',
                                   {'email': 'a', 'pass': 'b'},
                                   job_id='job-otp')

            exec_thread = threading.Thread(target=run_executor, daemon=True)
            exec_thread.start()

            assert otp_waiting.wait(timeout=5), 'Executor never reached OTP wait'

            _time.sleep(0.1)
            otp_code.set()

            exec_thread.join(timeout=10)
            lock_thread.join(timeout=5)

            assert lock_acquired_during_otp.is_set(), \
                'gui_lock was NOT acquirable during OTP wait (held by executor)'
        finally:
            loop.call_soon_threadsafe(loop.stop)
            loop_thread.join(timeout=2)
            loop.close()

    def test_signin_page_types_acquire_lock(self, monkeypatch):
        """Sign-in page types (user_pass, user_only, etc.) acquire gui_lock."""
        lock_acquired = []

        class CountingLock:
            def __init__(self):
                self._lock = threading.Lock()

            def __enter__(self):
                self._lock.acquire()
                lock_acquired.append(True)
                return self

            def __exit__(self, *args):
                self._lock.release()

        counting = CountingLock()
        monkeypatch.setattr('agent.vlm_executor.gui_lock', counting)

        vlm = _make_vlm([USER_PASS_PAGE, SIGNED_IN, CANCEL_DONE])
        executor = VLMExecutor(vlm, settle_delay=0)
        result = executor.run('netflix', 'cancel', {'email': 'a@b.com', 'pass': 'x'})
        assert result.success
        assert len(lock_acquired) >= 1
