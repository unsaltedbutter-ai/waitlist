"""Tests for VLM-guided playbook recording.

Covers:
- Prompt construction (sign-in, cancel, resume)
- VLM client (JSON extraction, HTTP mocking)
- Credential templating
- Stuck detection
- Recorder integration (mock VLM producing valid playbook JSON)

Run: cd agent && python -m pytest tests/test_recording.py -v
"""

from __future__ import annotations

import base64
import io
import json

import pytest
from PIL import Image


def _make_test_png_b64(width: int = 200, height: int = 100) -> str:
    """Create a minimal valid PNG image and return its base64 encoding."""
    img = Image.new('RGB', (width, height), color=(128, 128, 128))
    buf = io.BytesIO()
    img.save(buf, format='PNG')
    return base64.b64encode(buf.getvalue()).decode('ascii')

from agent.recording.prompts import (
    SERVICE_HINTS,
    build_cancel_prompt,
    build_resume_prompt,
    build_signin_prompt,
)
from agent.recording.recorder import (
    PlaybookRecorder,
    _StuckDetector,
    _resolve_credential,
)
from agent.recording.vlm_client import VLMClient, _extract_json


# ===========================================================================
# Prompt construction tests
# ===========================================================================


class TestBuildSigninPrompt:
    """Sign-in prompt builder."""

    def test_contains_service_name(self) -> None:
        prompt = build_signin_prompt('netflix')
        assert 'netflix' in prompt.lower() or 'Netflix' in prompt

    def test_contains_response_schema(self) -> None:
        prompt = build_signin_prompt('netflix')
        assert '"bounding_box"' in prompt
        assert '"action"' in prompt

    def test_uses_service_hints(self) -> None:
        prompt = build_signin_prompt('netflix')
        assert 'Sign In' in prompt
        assert 'Email or mobile number' in prompt

    def test_unknown_service_uses_defaults(self) -> None:
        prompt = build_signin_prompt('unknownservice')
        assert 'unknownservice' in prompt
        assert 'Email' in prompt

    def test_profile_selection_hint(self) -> None:
        prompt = build_signin_prompt('netflix')
        assert 'profile' in prompt.lower()


class TestBuildCancelPrompt:
    """Cancel prompt builder."""

    def test_contains_cancel_keywords(self) -> None:
        prompt = build_cancel_prompt('netflix')
        assert 'cancel' in prompt.lower()
        assert 'retention' in prompt.lower()

    def test_contains_service_specific_urls(self) -> None:
        prompt = build_cancel_prompt('netflix')
        assert 'cancelplan' in prompt

    def test_contains_response_schema(self) -> None:
        prompt = build_cancel_prompt('netflix')
        assert '"bounding_box"' in prompt

    def test_unknown_service(self) -> None:
        prompt = build_cancel_prompt('foobar')
        assert 'foobar' in prompt


class TestBuildResumePrompt:
    """Resume prompt builder."""

    def test_contains_resume_keywords(self) -> None:
        prompt = build_resume_prompt('netflix', 'premium')
        assert 'resume' in prompt.lower() or 'restart' in prompt.lower()

    def test_includes_plan_tier(self) -> None:
        prompt = build_resume_prompt('netflix', 'premium')
        assert 'premium' in prompt

    def test_no_plan_tier(self) -> None:
        prompt = build_resume_prompt('netflix', '')
        # Should still produce a valid prompt without plan-specific instructions
        assert 'netflix' in prompt.lower() or 'Netflix' in prompt
        # Should not include plan change instructions
        assert 'Change Plan' not in prompt

    def test_contains_response_schema(self) -> None:
        prompt = build_resume_prompt('hulu', 'basic')
        assert '"action"' in prompt

    def test_plan_mismatch_triggers_change(self) -> None:
        prompt = build_resume_prompt('netflix', 'Standard with ads')
        assert 'Change' in prompt
        assert 'Standard with ads' in prompt
        # Should instruct to click Change when wrong plan is shown
        assert 'DIFFERENT plan' in prompt

    def test_account_navigation_before_completion(self) -> None:
        """Account navigation should appear before completion check in the prompt."""
        prompt = build_resume_prompt('netflix', 'premium')
        account_pos = prompt.find('navigate to Account')
        completion_pos = prompt.find('COMPLETION CHECK')
        assert account_pos < completion_pos, 'Account navigation must come before completion check'

    def test_onboarding_means_done(self) -> None:
        prompt = build_resume_prompt('netflix', 'premium')
        assert 'onboarding' in prompt.lower()
        assert 'ALREADY SUCCEEDED' in prompt

    def test_welcome_message_triggers_done(self) -> None:
        prompt = build_resume_prompt('netflix', '')
        assert 'Welcome to netflix' in prompt or 'Welcome back' in prompt

    def test_browse_page_not_done(self) -> None:
        """The prompt must warn that seeing content does NOT mean done."""
        prompt = build_resume_prompt('peacock', 'premium')
        assert 'home/browse page' in prompt.lower() or 'browse page' in prompt.lower()
        assert 'NOT' in prompt


class TestServiceHints:
    """SERVICE_HINTS dict coverage."""

    def test_all_seven_services_present(self) -> None:
        expected = {'netflix', 'hulu', 'disney', 'paramount', 'peacock', 'appletv', 'max'}
        assert expected == set(SERVICE_HINTS.keys())

    def test_each_service_has_required_keys(self) -> None:
        required = {'login_url', 'signin_button', 'email_field', 'password_field'}
        for service, hints in SERVICE_HINTS.items():
            for key in required:
                assert key in hints, f'{service} missing key: {key}'


# ===========================================================================
# VLM client: _extract_json tests
# ===========================================================================


class TestExtractJson:
    """JSON extraction from VLM output."""

    def test_plain_json(self) -> None:
        raw = '{"action": "click", "confidence": 0.9}'
        result = _extract_json(raw)
        assert result['action'] == 'click'
        assert result['confidence'] == 0.9

    def test_json_in_code_fence(self) -> None:
        raw = '```json\n{"action": "done", "state": "signed in"}\n```'
        result = _extract_json(raw)
        assert result['action'] == 'done'

    def test_json_in_bare_fence(self) -> None:
        raw = '```\n{"action": "wait"}\n```'
        result = _extract_json(raw)
        assert result['action'] == 'wait'

    def test_json_with_preamble(self) -> None:
        raw = 'I can see the login page. Here is my analysis:\n{"action": "click", "target_description": "email field"}'
        result = _extract_json(raw)
        assert result['action'] == 'click'

    def test_nested_braces_in_reasoning(self) -> None:
        raw = '{"action": "click", "reasoning": "The button {Sign In} is visible"}'
        result = _extract_json(raw)
        assert result['action'] == 'click'

    def test_invalid_json_raises(self) -> None:
        with pytest.raises(ValueError, match='Could not extract JSON'):
            _extract_json('This is not JSON at all')

    def test_whitespace_padding(self) -> None:
        raw = '   \n  {"action": "type_text"}  \n  '
        result = _extract_json(raw)
        assert result['action'] == 'type_text'


class TestVLMClientInit:
    """VLMClient construction (no HTTP calls)."""

    def test_strips_trailing_v1_and_slash(self) -> None:
        client = VLMClient(
            base_url='https://api.example.com/v1/',
            api_key='test-key',
            model='test-model',
        )
        assert client.base_url == 'https://api.example.com'
        client.close()

    def test_strips_trailing_v1(self) -> None:
        client = VLMClient(
            base_url='https://api.example.com/v1',
            api_key='test-key',
            model='test-model',
        )
        assert client.base_url == 'https://api.example.com'
        client.close()

    def test_preserves_base_url_without_v1(self) -> None:
        client = VLMClient(
            base_url='https://api.example.com',
            api_key='test-key',
            model='test-model',
        )
        assert client.base_url == 'https://api.example.com'
        client.close()

    def test_context_manager(self) -> None:
        with VLMClient(
            base_url='https://api.example.com/v1',
            api_key='key',
            model='model',
        ) as client:
            assert client.model == 'model'


class TestVLMClientAnalyze:
    """VLMClient.analyze with mocked HTTP via monkeypatch."""

    @staticmethod
    def _make_response(json_data):
        """Create an httpx.Response with a fake request attached."""
        import httpx
        resp = httpx.Response(200, json=json_data)
        resp._request = httpx.Request('POST', 'https://fake.example.com')
        return resp

    def test_successful_analysis(self, monkeypatch) -> None:
        """Mock a successful VLM response and verify parsing."""
        import httpx

        mock_json = {
            'choices': [{
                'message': {
                    'content': json.dumps({
                        'state': 'login page',
                        'action': 'click',
                        'target_description': 'email field',
                        'bounding_box': [100, 200, 300, 230],
                        'confidence': 0.95,
                        'reasoning': 'I see the email field',
                    }),
                },
            }],
        }

        def mock_post(self_client, url, **kwargs):
            return TestVLMClientAnalyze._make_response(mock_json)

        monkeypatch.setattr(httpx.Client, 'post', mock_post)

        with VLMClient(
            base_url='https://api.example.com',
            api_key='test-key',
            model='test-model',
        ) as client:
            result, scale_factor = client.analyze(
                screenshot_b64=_make_test_png_b64(),
                system_prompt='test prompt',
            )

        assert result['action'] == 'click'
        assert result['bounding_box'] == [100, 200, 300, 230]
        assert result['confidence'] == 0.95
        assert scale_factor == 1.0  # 200px wide, under MAX_IMAGE_WIDTH

    def test_sends_correct_payload(self, monkeypatch) -> None:
        """Verify the request payload structure."""
        import httpx

        captured_kwargs: dict = {}

        def mock_post(self_client, url, **kwargs):
            captured_kwargs.update(kwargs)
            captured_kwargs['url'] = url
            return TestVLMClientAnalyze._make_response(
                {'choices': [{'message': {'content': '{"action": "done"}'}}]},
            )

        monkeypatch.setattr(httpx.Client, 'post', mock_post)

        test_png = _make_test_png_b64()
        with VLMClient(
            base_url='https://api.example.com',
            api_key='test-key',
            model='grok-2-vision',
            max_tokens=1024,
            temperature=0.2,
        ) as client:
            _result, scale = client.analyze(
                screenshot_b64=test_png,
                system_prompt='sys prompt',
                user_message='custom message',
            )

        assert scale == 1.0
        body = captured_kwargs['json']
        assert body['model'] == 'grok-2-vision'
        assert body['max_tokens'] == 1024
        assert body['temperature'] == 0.2
        assert body['messages'][0]['role'] == 'system'
        assert body['messages'][0]['content'] == 'sys prompt'
        assert body['messages'][1]['role'] == 'user'
        # Image content (converted to JPEG by _resize_if_needed)
        img_part = body['messages'][1]['content'][0]
        assert img_part['type'] == 'image_url'
        assert img_part['image_url']['url'].startswith('data:image/jpeg;base64,')
        # Text content
        text_part = body['messages'][1]['content'][1]
        assert text_part['text'] == 'custom message'

    def test_default_user_message_includes_dimensions(self, monkeypatch) -> None:
        """When no user_message is provided, the default includes image dimensions."""
        import httpx

        captured_kwargs: dict = {}

        def mock_post(self_client, url, **kwargs):
            captured_kwargs.update(kwargs)
            return TestVLMClientAnalyze._make_response(
                {'choices': [{'message': {'content': '{"action": "done"}'}}]},
            )

        monkeypatch.setattr(httpx.Client, 'post', mock_post)

        test_png = _make_test_png_b64(width=200, height=100)
        with VLMClient(
            base_url='https://api.example.com',
            api_key='test-key',
            model='test-model',
        ) as client:
            client.analyze(screenshot_b64=test_png, system_prompt='test')

        text_part = captured_kwargs['json']['messages'][1]['content'][1]
        assert '200x100' in text_part['text']
        assert 'absolute pixels' in text_part['text']

    def test_oversized_image_returns_scale_factor(self, monkeypatch) -> None:
        """Verify that an image wider than MAX_IMAGE_WIDTH returns a scale factor > 1."""
        import httpx

        mock_json = {
            'choices': [{
                'message': {
                    'content': json.dumps({
                        'state': 'page',
                        'action': 'click',
                        'bounding_box': [100, 50, 200, 80],
                        'confidence': 0.9,
                    }),
                },
            }],
        }

        def mock_post(self_client, url, **kwargs):
            return TestVLMClientAnalyze._make_response(mock_json)

        monkeypatch.setattr(httpx.Client, 'post', mock_post)

        # 2560px wide image, MAX_IMAGE_WIDTH is 1280 -> scale_factor = 2.0
        big_png = _make_test_png_b64(width=2560, height=1440)
        with VLMClient(
            base_url='https://api.example.com',
            api_key='test-key',
            model='test-model',
        ) as client:
            result, scale_factor = client.analyze(
                screenshot_b64=big_png,
                system_prompt='test prompt',
            )

        assert scale_factor == 2.0
        # VLM returns coords in resized space; caller is responsible for scaling
        assert result['bounding_box'] == [100, 50, 200, 80]

    def test_qwen_model_denormalizes_bbox(self, monkeypatch) -> None:
        """Qwen-VL models return 0-1000 normalized coords; should convert to pixels."""
        import httpx

        mock_json = {
            'choices': [{
                'message': {
                    'content': json.dumps({
                        'state': 'page',
                        'action': 'click',
                        'bounding_box': [321, 335, 666, 398],
                        'confidence': 0.95,
                    }),
                },
            }],
        }

        def mock_post(self_client, url, **kwargs):
            return TestVLMClientAnalyze._make_response(mock_json)

        monkeypatch.setattr(httpx.Client, 'post', mock_post)

        # 200x100 image (won't be resized), model name contains 'qwen'
        test_png = _make_test_png_b64(width=200, height=100)
        with VLMClient(
            base_url='https://api.example.com',
            api_key='test-key',
            model='qwen/qwen3-vl-32b-instruct',
        ) as client:
            result, scale_factor = client.analyze(
                screenshot_b64=test_png,
                system_prompt='test prompt',
            )

        assert scale_factor == 1.0
        # 321/1000 * 200 = 64.2, 335/1000 * 100 = 33.5, etc.
        bbox = result['bounding_box']
        assert abs(bbox[0] - 64.2) < 0.1
        assert abs(bbox[1] - 33.5) < 0.1
        assert abs(bbox[2] - 133.2) < 0.1
        assert abs(bbox[3] - 39.8) < 0.1

    def test_non_qwen_model_preserves_bbox(self, monkeypatch) -> None:
        """Non-Qwen models return absolute pixel coords; should not convert."""
        import httpx

        mock_json = {
            'choices': [{
                'message': {
                    'content': json.dumps({
                        'state': 'page',
                        'action': 'click',
                        'bounding_box': [100, 200, 300, 250],
                        'confidence': 0.9,
                    }),
                },
            }],
        }

        def mock_post(self_client, url, **kwargs):
            return TestVLMClientAnalyze._make_response(mock_json)

        monkeypatch.setattr(httpx.Client, 'post', mock_post)

        test_png = _make_test_png_b64(width=200, height=100)
        with VLMClient(
            base_url='https://api.example.com',
            api_key='test-key',
            model='grok-2-vision',
        ) as client:
            result, _scale = client.analyze(
                screenshot_b64=test_png,
                system_prompt='test prompt',
            )

        assert result['bounding_box'] == [100, 200, 300, 250]


# ===========================================================================
# Credential templating tests
# ===========================================================================


class TestResolveCredential:
    """Credential keyword matching and templating."""

    def test_email_keyword(self) -> None:
        template, actual, sensitive = _resolve_credential(
            'the email address', {'email': 'test@example.com', 'pass': 'secret'},
        )
        assert template == '{email}'
        assert actual == 'test@example.com'
        assert sensitive is False

    def test_password_keyword(self) -> None:
        template, actual, sensitive = _resolve_credential(
            'the password', {'email': 'test@example.com', 'pass': 'secret'},
        )
        assert template == '{pass}'
        assert actual == 'secret'
        assert sensitive is True

    def test_username_keyword(self) -> None:
        template, actual, sensitive = _resolve_credential(
            'Enter your username', {'email': 'user@test.com'},
        )
        assert template == '{email}'
        assert actual == 'user@test.com'

    def test_e_mail_hyphenated(self) -> None:
        template, actual, _ = _resolve_credential(
            'Type the e-mail', {'email': 'foo@bar.com'},
        )
        assert template == '{email}'

    def test_literal_text(self) -> None:
        template, actual, sensitive = _resolve_credential(
            'some random text', {'email': 'x@y.com'},
        )
        assert template == 'some random text'
        assert actual == 'some random text'
        assert sensitive is False

    def test_missing_credential_key(self) -> None:
        template, actual, sensitive = _resolve_credential(
            'the password', {},  # no 'pass' key
        )
        assert template == '{pass}'
        assert actual == ''  # empty string, not KeyError
        assert sensitive is True

    def test_name_keyword(self) -> None:
        template, actual, _ = _resolve_credential(
            'Enter your full name', {'name': 'Test User'},
        )
        assert template == '{name}'
        assert actual == 'Test User'

    def test_zip_keyword(self) -> None:
        template, actual, _ = _resolve_credential(
            'Enter your zip code', {'zip': '10001'},
        )
        assert template == '{zip}'
        assert actual == '10001'


# ===========================================================================
# Auto-type inference tests
# ===========================================================================


class TestInferCredentialFromTarget:
    """_infer_credential_from_target: detect credential fields from click targets."""

    def _make_recorder(self) -> PlaybookRecorder:
        vlm = VLMClient(
            base_url='https://stub.example.com',
            api_key='stub',
            model='stub',
        )
        rec = PlaybookRecorder(
            vlm=vlm, service='netflix', flow='cancel',
            credentials={'email': 'x@y.com', 'pass': 'pw'},
        )
        return rec

    def test_email_field(self) -> None:
        rec = self._make_recorder()
        assert rec._infer_credential_from_target('Email or phone number field') == 'the email address'
        rec.vlm.close()

    def test_password_field(self) -> None:
        rec = self._make_recorder()
        assert rec._infer_credential_from_target('Password field') == 'the password'
        rec.vlm.close()

    def test_email_input_box(self) -> None:
        rec = self._make_recorder()
        assert rec._infer_credential_from_target('Email input box') == 'the email address'
        rec.vlm.close()

    def test_username_field(self) -> None:
        rec = self._make_recorder()
        assert rec._infer_credential_from_target('Username field') == 'the email address'
        rec.vlm.close()

    def test_button_not_matched(self) -> None:
        rec = self._make_recorder()
        assert rec._infer_credential_from_target('Sign In button') is None
        rec.vlm.close()

    def test_link_not_matched(self) -> None:
        rec = self._make_recorder()
        assert rec._infer_credential_from_target('Cancel Membership link') is None
        rec.vlm.close()

    def test_menu_not_matched(self) -> None:
        rec = self._make_recorder()
        assert rec._infer_credential_from_target('Account menu') is None
        rec.vlm.close()

    def test_password_reset_button_not_matched(self) -> None:
        """A button with 'password' in it should not trigger auto-type."""
        rec = self._make_recorder()
        assert rec._infer_credential_from_target('Reset Password button') is None
        rec.vlm.close()

    def test_continue_button_near_email_field_not_matched(self) -> None:
        """Button description mentioning nearby email field should not trigger."""
        rec = self._make_recorder()
        assert rec._infer_credential_from_target(
            'the red Continue button below the email input field'
        ) is None
        rec.vlm.close()

    def test_case_insensitive(self) -> None:
        rec = self._make_recorder()
        assert rec._infer_credential_from_target('EMAIL FIELD') == 'the email address'
        assert rec._infer_credential_from_target('PASSWORD INPUT') == 'the password'
        rec.vlm.close()


# ===========================================================================
# Stuck detection tests
# ===========================================================================


class TestStuckDetector:
    """Stuck detection logic."""

    def test_not_stuck_initially(self) -> None:
        sd = _StuckDetector(threshold=3)
        assert sd.check('page A', 'click', 'screenshot1') is False

    def test_not_stuck_with_variety(self) -> None:
        sd = _StuckDetector(threshold=3)
        sd.check('page A', 'click', 'ss1')
        sd.check('page B', 'type_text', 'ss2')
        assert sd.check('page C', 'scroll', 'ss3') is False

    def test_stuck_same_state_action(self) -> None:
        sd = _StuckDetector(threshold=3)
        sd.check('login page', 'click', 'ss_a')
        sd.check('login page', 'click', 'ss_b')
        assert sd.check('login page', 'click', 'ss_c') is True

    def test_stuck_same_screenshot(self) -> None:
        sd = _StuckDetector(threshold=3)
        # Same screenshot data but different state descriptions
        sd.check('state1', 'action1', 'same_screenshot')
        sd.check('state2', 'action2', 'same_screenshot')
        assert sd.check('state3', 'action3', 'same_screenshot') is True

    def test_reset_clears_history(self) -> None:
        sd = _StuckDetector(threshold=3)
        sd.check('page A', 'click', 'ss1')
        sd.check('page A', 'click', 'ss1')
        sd.reset()
        # After reset, same state+action should not trigger
        sd.check('page A', 'click', 'ss1')
        assert sd.check('page A', 'click', 'ss1') is False

    def test_custom_threshold(self) -> None:
        sd = _StuckDetector(threshold=2)
        sd.check('same', 'same', 'different1')
        assert sd.check('same', 'same', 'different2') is True


# ===========================================================================
# PlaybookRecorder unit tests (no browser/VLM interaction)
# ===========================================================================


class TestPlaybookRecorderInit:
    """Recorder construction and prompt chain building."""

    def _make_recorder(self, flow: str = 'cancel', **kwargs) -> PlaybookRecorder:
        """Helper to build a recorder with a stub VLMClient."""
        vlm = VLMClient(
            base_url='https://stub.example.com',
            api_key='stub',
            model='stub',
        )
        return PlaybookRecorder(
            vlm=vlm,
            service='netflix',
            flow=flow,
            credentials={'email': 'test@test.com', 'pass': 'pass123'},
            **kwargs,
        )

    def test_cancel_prompt_chain(self) -> None:
        rec = self._make_recorder(flow='cancel')
        assert len(rec._prompts) == 2
        assert 'sign in' in rec._prompts[0].lower() or 'Sign In' in rec._prompts[0]
        assert 'cancel' in rec._prompts[1].lower()
        rec.vlm.close()

    def test_resume_prompt_chain(self) -> None:
        rec = self._make_recorder(flow='resume', plan_tier='premium')
        assert len(rec._prompts) == 2
        assert 'premium' in rec._prompts[1]
        rec.vlm.close()

    def test_invalid_flow_raises(self) -> None:
        with pytest.raises(ValueError, match='Unknown flow'):
            self._make_recorder(flow='invalid')

    def test_playbook_filename_no_variant(self) -> None:
        rec = self._make_recorder()
        assert rec._playbook_filename() == 'netflix_cancel'
        rec.vlm.close()

    def test_playbook_filename_with_variant(self) -> None:
        rec = self._make_recorder(variant='home')
        assert rec._playbook_filename() == 'netflix_cancel_home'
        rec.vlm.close()

    def test_playbook_filename_with_plan_tier(self) -> None:
        rec = self._make_recorder(flow='resume', plan_tier='premium')
        assert rec._playbook_filename() == 'netflix_resume_premium'
        rec.vlm.close()

    def test_playbook_filename_plan_and_variant(self) -> None:
        rec = self._make_recorder(flow='resume', plan_tier='premium', variant='home')
        assert rec._playbook_filename() == 'netflix_resume_premium_home'
        rec.vlm.close()

    def test_plan_display_used_in_prompt(self) -> None:
        rec = self._make_recorder(
            flow='resume', plan_tier='standard_with_ads',
            plan_display='Standard with ads',
        )
        # The resume prompt should contain the display name, not the slug
        assert 'Standard with ads' in rec._prompts[1]
        assert 'standard_with_ads' not in rec._prompts[1]
        rec.vlm.close()

    def test_plan_display_falls_back_to_tier(self) -> None:
        rec = self._make_recorder(flow='resume', plan_tier='premium')
        assert rec.plan_display == 'premium'
        rec.vlm.close()

    def test_prompt_labels(self) -> None:
        rec = self._make_recorder(flow='cancel')
        assert rec._prompt_labels == ['sign-in', 'cancel']
        rec.vlm.close()

        rec2 = self._make_recorder(flow='resume')
        assert rec2._prompt_labels == ['sign-in', 'resume']
        rec2.vlm.close()


# ===========================================================================
# Integration test: mock VLM produces valid playbook
# ===========================================================================


class TestRecorderIntegration:
    """Full recorder loop with a mock VLM (no real browser).

    Patches browser, screenshot, and input modules to verify the recorder
    produces valid playbook JSON matching the existing schema.
    """

    def _mock_vlm_responses(self) -> list[dict]:
        """Scripted VLM responses simulating a Netflix cancel flow.

        Auto-type means the recorder types credentials immediately after
        clicking an input field, so the VLM sees the field already filled
        and skips to the next action (no separate type_text steps).
        """
        return [
            # Step 1: click email field (auto-types email)
            {
                'state': 'Netflix login page with empty email field',
                'action': 'click',
                'target_description': 'Email or phone number field',
                'bounding_box': [400, 300, 700, 330],
                'text_to_type': '',
                'key_to_press': '',
                'confidence': 0.95,
                'reasoning': 'I see the login form with empty email field',
                'is_checkpoint': False,
                'checkpoint_prompt': '',
            },
            # Step 2: click password field (auto-types password)
            {
                'state': 'Email entered, password field empty',
                'action': 'click',
                'target_description': 'Password field',
                'bounding_box': [400, 360, 700, 390],
                'text_to_type': '',
                'key_to_press': '',
                'confidence': 0.94,
                'reasoning': 'Email filled, clicking password field',
                'is_checkpoint': False,
                'checkpoint_prompt': '',
            },
            # Step 3: click Sign In
            {
                'state': 'Both fields filled',
                'action': 'click',
                'target_description': 'Sign In button',
                'bounding_box': [400, 420, 700, 460],
                'text_to_type': '',
                'key_to_press': '',
                'confidence': 0.96,
                'reasoning': 'Both credentials entered, clicking Sign In',
                'is_checkpoint': True,
                'checkpoint_prompt': 'Am I logged into Netflix?',
            },
            # Step 4: sign-in done (transition to cancel prompt)
            {
                'state': 'Signed in, seeing Netflix browse page',
                'action': 'done',
                'target_description': '',
                'bounding_box': None,
                'text_to_type': '',
                'key_to_press': '',
                'confidence': 0.98,
                'reasoning': 'Successfully signed in to Netflix',
                'is_checkpoint': False,
                'checkpoint_prompt': '',
            },
            # Step 5: on browse page, click Account
            {
                'state': 'Netflix browse page',
                'action': 'click',
                'target_description': 'Account menu',
                'bounding_box': [1100, 20, 1200, 50],
                'text_to_type': '',
                'key_to_press': '',
                'confidence': 0.90,
                'reasoning': 'Need to navigate to account settings',
                'is_checkpoint': False,
                'checkpoint_prompt': '',
            },
            # Step 6: click Cancel Membership
            {
                'state': 'Account settings page',
                'action': 'click',
                'target_description': 'Cancel Membership link',
                'bounding_box': [300, 500, 500, 530],
                'text_to_type': '',
                'key_to_press': '',
                'confidence': 0.91,
                'reasoning': 'Found Cancel Membership link',
                'is_checkpoint': True,
                'checkpoint_prompt': 'Am I on the cancel confirmation page?',
            },
            # Step 7: click Finish Cancellation
            {
                'state': 'Cancel confirmation page',
                'action': 'click',
                'target_description': 'Finish Cancellation button',
                'bounding_box': [400, 600, 600, 640],
                'text_to_type': '',
                'key_to_press': '',
                'confidence': 0.94,
                'reasoning': 'Clicking final confirmation button',
                'is_checkpoint': True,
                'checkpoint_prompt': 'Is cancellation confirmed?',
            },
            # Step 8: cancel done
            {
                'state': 'Cancellation confirmed',
                'action': 'done',
                'target_description': '',
                'bounding_box': None,
                'text_to_type': '',
                'key_to_press': '',
                'confidence': 0.99,
                'reasoning': 'Cancellation complete',
                'is_checkpoint': False,
                'checkpoint_prompt': '',
            },
        ]

    def test_produces_valid_playbook(self, monkeypatch, tmp_path) -> None:
        """Run the recorder with mocked everything and verify output."""
        responses = self._mock_vlm_responses()
        call_idx = {'n': 0}

        class MockVLM:
            last_inference_ms = 0
            _normalized_coords = False
            MAX_IMAGE_WIDTH = 1280

            def analyze(self, screenshot_b64, system_prompt, user_message=''):
                idx = call_idx['n']
                call_idx['n'] += 1
                if idx < len(responses):
                    return responses[idx], 1.0
                return {'action': 'done', 'state': 'fallback done', 'confidence': 1.0}, 1.0

            def close(self):
                pass

        # Mock browser module
        class FakeSession:
            pid = 12345
            process = None
            profile_dir = str(tmp_path / 'chrome-profile')
            window_id = 99
            bounds = {'x': 0, 'y': 0, 'width': 1280, 'height': 900}

        fake_session = FakeSession()

        import agent.recording.recorder as rec_mod

        # Patch PLAYBOOK_DIR and PLAYBOOK_REF_DIR
        monkeypatch.setattr(rec_mod, 'PLAYBOOK_DIR', tmp_path)
        monkeypatch.setattr(rec_mod, 'PLAYBOOK_REF_DIR', tmp_path / 'ref')

        recorder = PlaybookRecorder.__new__(PlaybookRecorder)
        recorder.vlm = MockVLM()
        recorder.service = 'netflix'
        recorder.flow = 'cancel'
        recorder.credentials = {'email': 'test@netflix.com', 'pass': 'hunter2'}
        recorder.plan_tier = ''
        recorder.plan_display = ''
        recorder.variant = ''
        recorder.max_steps = 60
        recorder.settle_delay = 0  # no waiting in tests
        recorder.verbose = False
        recorder._prompts = recorder._build_prompt_chain()
        recorder._prompt_idx = 0
        recorder._prompt_labels = recorder._build_prompt_labels()

        monkeypatch.setattr('time.sleep', lambda _: None)

        # Use a counter to make each screenshot unique (avoids stuck detection)
        ss_counter = {'n': 0}

        def _unique_screenshot(wid):
            ss_counter['n'] += 1
            return f'fake_screenshot_{ss_counter["n"]}'

        # Patch the real module functions (works even when already imported)
        monkeypatch.setattr('agent.browser.create_session', lambda: fake_session)
        monkeypatch.setattr('agent.browser.get_session_window', lambda s: s.bounds)
        monkeypatch.setattr('agent.browser.navigate', lambda s, url, fast=False: None)
        monkeypatch.setattr('agent.screenshot.capture_to_base64', _unique_screenshot)
        monkeypatch.setattr('agent.screenshot.capture_window', lambda wid, path: None)
        monkeypatch.setattr('agent.input.coords.image_to_screen', lambda ix, iy, bounds: (ix, iy))
        monkeypatch.setattr('agent.input.mouse.click', lambda x, y, **kw: None)
        monkeypatch.setattr('agent.input.keyboard.type_text', lambda text, speed='medium', accuracy='high': None)
        monkeypatch.setattr('agent.input.keyboard.press_key', lambda key: None)
        monkeypatch.setattr('agent.input.scroll.scroll', lambda direction, amount: None)

        # Patch _load_session and _save_session
        monkeypatch.setattr(
            PlaybookRecorder, '_load_session',
            staticmethod(lambda sf: fake_session),
        )
        monkeypatch.setattr(
            PlaybookRecorder, '_save_session',
            staticmethod(lambda s, sf: None),
        )

        result = recorder.run('https://www.netflix.com/login')

        # Validate the playbook structure
        assert result['service'] == 'netflix'
        assert result['flow'] == 'cancel'
        assert result['version'] == 1
        assert result['last_validated'] is None
        assert isinstance(result['steps'], list)
        assert len(result['steps']) > 0

        # Check that the navigate step is first
        assert result['steps'][0]['action'] == 'navigate'
        assert result['steps'][0]['url'] == 'https://www.netflix.com/login'

        # Check credential templating (no plaintext credentials in output)
        for step in result['steps']:
            if step.get('action') == 'type_text':
                assert 'test@netflix.com' not in step.get('value', '')
                assert 'hunter2' not in step.get('value', '')

        # Check that auto-type produced template vars
        type_steps = [s for s in result['steps'] if s['action'] == 'type_text']
        values = [s['value'] for s in type_steps]
        assert '{email}' in values
        assert '{pass}' in values

        # Auto-typed steps should immediately follow their click
        step_actions = [s['action'] for s in result['steps']]
        # navigate, click(email), type_text(email), click(password), type_text(password), ...
        email_click_idx = next(
            i for i, s in enumerate(result['steps'])
            if s['action'] == 'click' and 'email' in s.get('target_description', '').lower()
        )
        assert result['steps'][email_click_idx + 1]['action'] == 'type_text'
        assert result['steps'][email_click_idx + 1]['value'] == '{email}'

        # Check password step is marked sensitive
        pass_steps = [s for s in type_steps if s['value'] == '{pass}']
        assert len(pass_steps) == 1
        assert pass_steps[0].get('sensitive') is True

        # Check that checkpoints are preserved
        checkpoint_steps = [s for s in result['steps'] if s.get('checkpoint')]
        assert len(checkpoint_steps) >= 2  # at least sign-in click + cancel steps

        # Cancel flow should NOT have tier in output
        assert 'tier' not in result

        # Verify the file was written
        out_path = tmp_path / 'netflix_cancel.json'
        assert out_path.exists()
        with open(out_path) as f:
            saved = json.load(f)
        assert saved == result

    def test_resume_includes_tier(self, monkeypatch, tmp_path) -> None:
        """Resume playbooks with plan_tier should include 'tier' in output."""
        responses = [
            # Sign-in done immediately
            {'action': 'done', 'state': 'signed in', 'confidence': 0.99,
             'reasoning': 'done', 'target_description': '', 'bounding_box': None,
             'text_to_type': '', 'key_to_press': '', 'is_checkpoint': False,
             'checkpoint_prompt': ''},
            # Resume done immediately
            {'action': 'done', 'state': 'resumed', 'confidence': 0.99,
             'reasoning': 'done', 'target_description': '', 'bounding_box': None,
             'text_to_type': '', 'key_to_press': '', 'is_checkpoint': False,
             'checkpoint_prompt': ''},
        ]
        call_idx = {'n': 0}

        class MockVLM:
            last_inference_ms = 0
            _normalized_coords = False
            MAX_IMAGE_WIDTH = 1280

            def analyze(self, screenshot_b64, system_prompt, user_message=''):
                idx = call_idx['n']
                call_idx['n'] += 1
                if idx < len(responses):
                    return responses[idx], 1.0
                return {'action': 'done', 'state': 'fallback', 'confidence': 1.0}, 1.0
            def close(self):
                pass

        class FakeSession:
            pid = 12345
            process = None
            profile_dir = str(tmp_path / 'chrome-profile')
            window_id = 99
            bounds = {'x': 0, 'y': 0, 'width': 1280, 'height': 900}

        fake_session = FakeSession()

        import agent.recording.recorder as rec_mod
        monkeypatch.setattr(rec_mod, 'PLAYBOOK_DIR', tmp_path)
        monkeypatch.setattr(rec_mod, 'PLAYBOOK_REF_DIR', tmp_path / 'ref')
        monkeypatch.setattr('time.sleep', lambda _: None)

        ss_counter = {'n': 0}
        def _unique_screenshot(wid):
            ss_counter['n'] += 1
            return f'fake_{ss_counter["n"]}'

        monkeypatch.setattr('agent.browser.create_session', lambda: fake_session)
        monkeypatch.setattr('agent.browser.get_session_window', lambda s: s.bounds)
        monkeypatch.setattr('agent.browser.navigate', lambda s, url, fast=False: None)
        monkeypatch.setattr('agent.screenshot.capture_to_base64', _unique_screenshot)
        monkeypatch.setattr('agent.screenshot.capture_window', lambda wid, path: None)
        monkeypatch.setattr('agent.input.coords.image_to_screen', lambda ix, iy, bounds: (ix, iy))
        monkeypatch.setattr('agent.input.mouse.click', lambda x, y, **kw: None)
        monkeypatch.setattr('agent.input.keyboard.type_text', lambda text, speed='medium', accuracy='high': None)
        monkeypatch.setattr('agent.input.keyboard.press_key', lambda key: None)
        monkeypatch.setattr('agent.input.scroll.scroll', lambda direction, amount: None)
        monkeypatch.setattr(
            PlaybookRecorder, '_load_session',
            staticmethod(lambda sf: fake_session),
        )
        monkeypatch.setattr(
            PlaybookRecorder, '_save_session',
            staticmethod(lambda s, sf: None),
        )

        recorder = PlaybookRecorder(
            vlm=MockVLM(),
            service='netflix',
            flow='resume',
            credentials={'email': 'test@test.com', 'pass': 'pw'},
            plan_tier='premium',
        )
        recorder.settle_delay = 0

        result = recorder.run('https://www.netflix.com')

        assert result['tier'] == 'premium'
        assert result['flow'] == 'resume'

        out_path = tmp_path / 'netflix_resume_premium.json'
        assert out_path.exists()
        with open(out_path) as f:
            saved = json.load(f)
        assert saved['tier'] == 'premium'

    def test_variant_in_filename(self, monkeypatch, tmp_path) -> None:
        """Verify variant suffix appears in the output filename."""
        # Quick test: just check filename generation
        vlm = VLMClient(
            base_url='https://stub.example.com',
            api_key='stub',
            model='stub',
        )
        rec = PlaybookRecorder(
            vlm=vlm,
            service='hulu',
            flow='cancel',
            credentials={'email': 'x', 'pass': 'y'},
            variant='settings',
        )
        assert rec._playbook_filename() == 'hulu_cancel_settings'
        vlm.close()


# ===========================================================================
# CLI: _slugify_plan and resume --plan validation
# ===========================================================================


class TestSlugifyPlan:
    """Plan name to variant slug conversion."""

    def test_simple_name(self) -> None:
        from agent.bin.playbook import _slugify_plan
        assert _slugify_plan('Premium') == 'premium'

    def test_name_with_spaces(self) -> None:
        from agent.bin.playbook import _slugify_plan
        assert _slugify_plan('Standard with ads') == 'standard_with_ads'

    def test_name_with_special_chars(self) -> None:
        from agent.bin.playbook import _slugify_plan
        assert _slugify_plan('Basic (Ad-Supported)') == 'basic_ad_supported'

    def test_already_clean(self) -> None:
        from agent.bin.playbook import _slugify_plan
        assert _slugify_plan('standard') == 'standard'

    def test_extra_whitespace(self) -> None:
        from agent.bin.playbook import _slugify_plan
        assert _slugify_plan('  Premium  ') == 'premium'
