"""Tests for VLM recording utilities: prompts, VLM client, browser chrome cropping.

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

try:
    import unsaltedbutter_prompts  # noqa: F401
    _HAS_PRIVATE_PROMPTS = True
except ImportError:
    _HAS_PRIVATE_PROMPTS = False

_skip_without_private = pytest.mark.skipif(
    not _HAS_PRIVATE_PROMPTS,
    reason='unsaltedbutter-prompts not installed (service-specific content)',
)
from agent.recording.vlm_client import VLMClient, _denormalize_bboxes, _extract_json
from agent.screenshot import CHROME_HEIGHT_LOGICAL, crop_browser_chrome


# ===========================================================================
# Browser chrome cropping tests
# ===========================================================================


class TestCropBrowserChrome:
    """crop_browser_chrome: remove tab bar + address bar from screenshots."""

    def test_crops_correct_height_non_retina(self, monkeypatch) -> None:
        """Non-Retina (scale=1.0): crop 88px from top."""
        monkeypatch.setattr('agent.input.window.get_retina_scale', lambda: 1.0)
        img_b64 = _make_test_png_b64(1280, 900)
        cropped_b64, chrome_px = crop_browser_chrome(img_b64)
        assert chrome_px == 88

        raw = base64.b64decode(cropped_b64)
        img = Image.open(io.BytesIO(raw))
        assert img.width == 1280
        assert img.height == 900 - 88

    def test_crops_correct_height_retina(self, monkeypatch) -> None:
        """Retina (scale=2.0): crop 176px from top."""
        monkeypatch.setattr('agent.input.window.get_retina_scale', lambda: 2.0)
        img_b64 = _make_test_png_b64(2560, 1800)
        cropped_b64, chrome_px = crop_browser_chrome(img_b64)
        assert chrome_px == 176

        raw = base64.b64decode(cropped_b64)
        img = Image.open(io.BytesIO(raw))
        assert img.width == 2560
        assert img.height == 1800 - 176

    def test_too_short_image_not_cropped(self, monkeypatch) -> None:
        """If the image is shorter than the chrome height, don't crop."""
        monkeypatch.setattr('agent.input.window.get_retina_scale', lambda: 1.0)
        img_b64 = _make_test_png_b64(200, 50)  # shorter than 88px
        cropped_b64, chrome_px = crop_browser_chrome(img_b64)
        assert chrome_px == 0
        assert cropped_b64 == img_b64

    def test_chrome_height_constant(self) -> None:
        assert CHROME_HEIGHT_LOGICAL == 88

    def test_returns_valid_png(self, monkeypatch) -> None:
        """Output is a valid PNG that can be re-opened."""
        monkeypatch.setattr('agent.input.window.get_retina_scale', lambda: 1.0)
        img_b64 = _make_test_png_b64(1280, 900)
        cropped_b64, _ = crop_browser_chrome(img_b64)
        raw = base64.b64decode(cropped_b64)
        img = Image.open(io.BytesIO(raw))
        img.verify()  # raises if invalid


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
        assert '"page_type"' in prompt
        assert '"email_box"' in prompt
        assert '"password_box"' in prompt
        assert '"code_boxes"' in prompt
        assert '"page_description"' in prompt
        assert '"actions"' in prompt

    @_skip_without_private
    def test_uses_service_hints(self) -> None:
        prompt = build_signin_prompt('netflix')
        assert 'Sign In' in prompt
        assert 'Email or mobile number' in prompt

    def test_unknown_service_uses_defaults(self) -> None:
        prompt = build_signin_prompt('unknownservice')
        assert 'unknownservice' in prompt
        assert 'Email' in prompt

    def test_contains_new_states(self) -> None:
        prompt = build_signin_prompt('netflix')
        assert 'email_code_single' in prompt
        assert 'email_code_multi' in prompt
        assert 'phone_code_single' in prompt
        assert 'phone_code_multi' in prompt
        assert '"captcha"' in prompt
        assert '"unknown"' in prompt

    @_skip_without_private
    def test_contains_few_shot_examples(self) -> None:
        prompt = build_signin_prompt('netflix')
        assert 'Examples of correct responses' in prompt
        assert 'Cookie consent banner' in prompt

    def test_no_browser_chrome_warning(self) -> None:
        prompt = build_signin_prompt('netflix')
        assert 'browser tab bar' not in prompt
        assert '~150 pixels' not in prompt

    def test_profile_selection_hint(self) -> None:
        prompt = build_signin_prompt('netflix')
        assert 'profile' in prompt.lower()


class TestBuildCancelPrompt:
    """Cancel prompt builder."""

    def test_contains_cancel_keywords(self) -> None:
        prompt = build_cancel_prompt('netflix')
        assert 'cancel' in prompt.lower()
        assert 'retention' in prompt.lower()

    @_skip_without_private
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
# Qwen bbox denormalization tests
# ===========================================================================


class TestDenormalizeBboxes:
    """Recursive Qwen 0-1000 bbox denormalization."""

    def test_top_level_bbox(self) -> None:
        obj = {'bounding_box': [500, 500, 1000, 1000]}
        _denormalize_bboxes(obj, 1280, 800)
        assert obj['bounding_box'] == [640.0, 400.0, 1280.0, 800.0]

    def test_nested_dict_bbox(self) -> None:
        """code_boxes with nested box fields should be denormalized."""
        obj = {
            'code_boxes': [
                {'label': 'code_1', 'box': [322, 355, 367, 444]},
                {'label': 'code_2', 'box': [380, 355, 425, 444]},
            ],
        }
        _denormalize_bboxes(obj, 1280, 800)
        assert abs(obj['code_boxes'][0]['box'][0] - 412.16) < 0.1
        assert abs(obj['code_boxes'][0]['box'][1] - 284.0) < 0.1
        assert abs(obj['code_boxes'][1]['box'][0] - 486.4) < 0.1

    def test_actions_list_bbox(self) -> None:
        """actions list with nested box fields should be denormalized."""
        obj = {
            'actions': [
                {'action': 'click', 'target': 'Accept', 'box': [500, 500, 700, 560]},
            ],
        }
        _denormalize_bboxes(obj, 1280, 800)
        assert obj['actions'][0]['box'] == [640.0, 400.0, 896.0, 448.0]

    def test_non_bbox_lists_untouched(self) -> None:
        """Lists that aren't 4-element numeric should be left alone."""
        obj = {
            'wait_after_sec': [2, 4],
            'tags': ['a', 'b', 'c', 'd'],
            'confidence': 0.95,
        }
        _denormalize_bboxes(obj, 1280, 800)
        assert obj['wait_after_sec'] == [2, 4]
        assert obj['tags'] == ['a', 'b', 'c', 'd']
        assert obj['confidence'] == 0.95

    def test_mixed_top_and_nested(self) -> None:
        """Both top-level and nested bboxes in the same response."""
        obj = {
            'email_box': [100, 200, 500, 250],
            'code_boxes': [{'label': 'c1', 'box': [100, 300, 200, 400]}],
        }
        _denormalize_bboxes(obj, 1280, 800)
        assert obj['email_box'] == [128.0, 160.0, 640.0, 200.0]
        assert obj['code_boxes'][0]['box'] == [128.0, 240.0, 256.0, 320.0]


