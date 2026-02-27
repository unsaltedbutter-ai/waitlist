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
from agent.recording.vlm_client import VLMClient, _denormalize_bboxes, _extract_json, _swap_yx_bboxes
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

    def test_chrome_height_default(self) -> None:
        assert CHROME_HEIGHT_LOGICAL >= 0  # env-configurable, default 88

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

    @_skip_without_private
    def test_contains_response_schema(self) -> None:
        prompt = build_signin_prompt('netflix')
        assert '"page_type"' in prompt
        assert '"email_point"' in prompt
        assert '"password_point"' in prompt
        assert '"code_points"' in prompt
        assert '"actions"' in prompt

    @_skip_without_private
    def test_uses_service_hints(self) -> None:
        prompt = build_signin_prompt('netflix')
        assert 'Sign In' in prompt
        assert 'Email or mobile number' in prompt

    @_skip_without_private
    def test_unknown_service_uses_defaults(self) -> None:
        prompt = build_signin_prompt('unknownservice')
        assert 'unknownservice' in prompt
        assert 'Email' in prompt

    @_skip_without_private
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

    @_skip_without_private
    def test_profile_selection_hint(self) -> None:
        prompt = build_signin_prompt('netflix')
        assert 'profile' in prompt.lower()


class TestBuildCancelPrompt:
    """Cancel prompt builder."""

    @_skip_without_private
    def test_contains_cancel_keywords(self) -> None:
        prompt = build_cancel_prompt('netflix')
        assert 'cancel' in prompt.lower()
        assert 'retention' in prompt.lower()

    @_skip_without_private
    def test_contains_service_specific_labels(self) -> None:
        prompt = build_cancel_prompt('netflix')
        assert 'Cancel Membership' in prompt

    @_skip_without_private
    def test_contains_response_schema(self) -> None:
        prompt = build_cancel_prompt('netflix')
        assert '"click_point"' in prompt

    def test_unknown_service(self) -> None:
        prompt = build_cancel_prompt('foobar')
        assert 'foobar' in prompt


class TestBuildResumePrompt:
    """Resume prompt builder."""

    def test_contains_resume_keywords(self) -> None:
        prompt = build_resume_prompt('netflix', 'premium')
        assert 'resume' in prompt.lower() or 'restart' in prompt.lower()

    @_skip_without_private
    def test_includes_plan_tier(self) -> None:
        prompt = build_resume_prompt('netflix', 'premium')
        assert 'premium' in prompt

    def test_no_plan_tier(self) -> None:
        prompt = build_resume_prompt('netflix', '')
        # Should still produce a valid prompt without plan-specific instructions
        assert 'netflix' in prompt.lower() or 'Netflix' in prompt
        # Should not include plan change instructions
        assert 'Change Plan' not in prompt

    @_skip_without_private
    def test_contains_response_schema(self) -> None:
        prompt = build_resume_prompt('hulu', 'basic')
        assert '"action"' in prompt

    @_skip_without_private
    def test_plan_mismatch_triggers_change(self) -> None:
        prompt = build_resume_prompt('netflix', 'Standard with ads')
        assert 'Change' in prompt
        assert 'Standard with ads' in prompt
        # Should instruct to click Change when wrong plan is shown
        assert 'DIFFERENT plan' in prompt

    @_skip_without_private
    def test_account_navigation_before_completion(self) -> None:
        """Account navigation should appear before completion check in the prompt."""
        prompt = build_resume_prompt('netflix', 'premium')
        account_pos = prompt.find('navigate to Account')
        completion_pos = prompt.find('COMPLETION CHECK')
        assert account_pos < completion_pos, 'Account navigation must come before completion check'

    @_skip_without_private
    def test_onboarding_means_done(self) -> None:
        prompt = build_resume_prompt('netflix', 'premium')
        assert 'onboarding' in prompt.lower()
        assert 'ALREADY SUCCEEDED' in prompt

    @_skip_without_private
    def test_welcome_message_triggers_done(self) -> None:
        prompt = build_resume_prompt('netflix', '')
        assert 'Welcome to netflix' in prompt or 'Welcome back' in prompt

    @_skip_without_private
    def test_browse_page_not_done(self) -> None:
        """The prompt must warn that seeing content does NOT mean done."""
        prompt = build_resume_prompt('peacock', 'premium')
        assert 'home/browse page' in prompt.lower() or 'browse page' in prompt.lower()
        assert 'NOT' in prompt


class TestServiceHints:
    """SERVICE_HINTS dict coverage."""

    def test_all_six_services_present(self) -> None:
        expected = {'netflix', 'hulu', 'disney_plus', 'paramount', 'peacock', 'max'}
        assert expected == set(SERVICE_HINTS.keys())

    def test_each_service_has_required_phase_keys(self) -> None:
        signin_required = {'login_url', 'button', 'email_field', 'password_field'}
        cancel_required = {'button_labels'}
        resume_required = {'button_labels'}
        for service, phases in SERVICE_HINTS.items():
            assert 'signin' in phases, f'{service} missing phase: signin'
            assert 'cancel' in phases, f'{service} missing phase: cancel'
            assert 'resume' in phases, f'{service} missing phase: resume'
            for key in signin_required:
                assert key in phases['signin'], f'{service}.signin missing key: {key}'
            for key in cancel_required:
                assert key in phases['cancel'], f'{service}.cancel missing key: {key}'
            for key in resume_required:
                assert key in phases['resume'], f'{service}.resume missing key: {key}'


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

    def test_malformed_json_regex_fallback(self) -> None:
        """VLM truncated output with mismatched brackets: regex extracts fields."""
        raw = (
            '{\n'
            '  "page_type": "email_code_single",\n'
            '  "email_point": [425, 201],\n'
            '  "password_point": null,\n'
            '  "button_point": null,\n'
            '  "profile_point": null,\n'
            '  "code_points": [{"label": "code_1", "point": [350, 264}]\n'
        )
        result = _extract_json(raw)
        assert result['page_type'] == 'email_code_single'
        assert result['email_point'] == [425, 201]
        assert result['password_point'] is None
        assert result['button_point'] is None
        assert result['code_points'] is None  # too broken to extract

    def test_truncated_json_regex_fallback(self) -> None:
        """VLM output cut off mid-response: regex extracts available fields."""
        raw = '{"page_type": "user_pass", "email_point": [500, 300], "password_point": [500'
        result = _extract_json(raw)
        assert result['page_type'] == 'user_pass'
        assert result['email_point'] == [500, 300]
        assert result['password_point'] is None  # incomplete


class TestVLMClientInit:
    """VLMClient construction (no HTTP calls)."""

    def test_strips_trailing_slash(self) -> None:
        client = VLMClient(
            base_url='https://api.example.com/v1/',
            api_key='test-key',
            model='test-model',
        )
        assert client.base_url == 'https://api.example.com/v1'
        client.close()

    def test_preserves_v1_in_url(self) -> None:
        client = VLMClient(
            base_url='https://api.example.com/v1',
            api_key='test-key',
            model='test-model',
        )
        assert client.base_url == 'https://api.example.com/v1'
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
            coord_normalize=False,
        ) as client:
            result, scale_factor = client.analyze(
                screenshot_b64=_make_test_png_b64(),
                system_prompt='test prompt',
            )

        assert result['action'] == 'click'
        assert result['bounding_box'] == [100, 200, 300, 230]
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
        """Verify that an image wider than max_image_width returns a scale factor > 1."""
        import httpx

        mock_json = {
            'choices': [{
                'message': {
                    'content': json.dumps({
                        'state': 'page',
                        'action': 'click',
                        'bounding_box': [100, 50, 200, 80],
                    }),
                },
            }],
        }

        def mock_post(self_client, url, **kwargs):
            return TestVLMClientAnalyze._make_response(mock_json)

        monkeypatch.setattr(httpx.Client, 'post', mock_post)

        # 2560px wide, max_image_width=1280 -> scale_factor = 2.0
        big_png = _make_test_png_b64(width=2560, height=1440)
        with VLMClient(
            base_url='https://api.example.com',
            api_key='test-key',
            model='test-model',
            max_image_width=1280,
            coord_normalize=False,
        ) as client:
            result, scale_factor = client.analyze(
                screenshot_b64=big_png,
                system_prompt='test prompt',
            )

        assert scale_factor == 2.0
        # VLM returns coords in resized space; caller is responsible for scaling
        assert result['bounding_box'] == [100, 50, 200, 80]

    def test_coord_normalize_denormalizes_bbox(self, monkeypatch) -> None:
        """coord_normalize=True converts 0-1000 coords to pixels (model name irrelevant)."""
        import httpx

        mock_json = {
            'choices': [{
                'message': {
                    'content': json.dumps({
                        'state': 'page',
                        'action': 'click',
                        'bounding_box': [321, 335, 666, 398],
                    }),
                },
            }],
        }

        def mock_post(self_client, url, **kwargs):
            return TestVLMClientAnalyze._make_response(mock_json)

        monkeypatch.setattr(httpx.Client, 'post', mock_post)

        # 200x100 image (won't be resized), non-qwen model name with coord_normalize=True
        test_png = _make_test_png_b64(width=200, height=100)
        with VLMClient(
            base_url='https://api.example.com',
            api_key='test-key',
            model='some-proxy-model',
            coord_normalize=True,
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

    def test_default_preserves_bbox(self, monkeypatch) -> None:
        """Without coord_normalize, even a qwen model name preserves pixel coords."""
        import httpx

        mock_json = {
            'choices': [{
                'message': {
                    'content': json.dumps({
                        'state': 'page',
                        'action': 'click',
                        'bounding_box': [100, 200, 300, 250],
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
            model='qwen/qwen3-vl-32b-instruct',
            coord_normalize=False,
        ) as client:
            result, _scale = client.analyze(
                screenshot_b64=test_png,
                system_prompt='test prompt',
            )

        assert result['bounding_box'] == [100, 200, 300, 250]

    def test_coord_square_pad_adjusts_for_padding(self, monkeypatch) -> None:
        """coord_square_pad=True denormalizes relative to padded square, not sent dims."""
        import httpx

        # Simulate what MLX does: image is 200x100, padded to 200x200.
        # Model sees element at center of original image: (100, 50) in img pixels.
        # In padded-square 0-1000 space: x=500, y=(50+50)/200*1000=500
        # where pad_top = (200-100)/2 = 50, so padded_y = 50+50 = 100, norm = 100/200*1000 = 500
        # Without square_pad: 500/1000*100 = 50 (correct by coincidence for center)
        # Better test: element at y=25 in image.
        # padded_y = 25 + 50 = 75, norm_y = 75/200*1000 = 375
        # Without square_pad: 375/1000*100 = 37.5 (WRONG, should be 25)
        # With square_pad: 375/1000*200 - 50 = 75 - 50 = 25 (CORRECT)
        mock_json = {
            'choices': [{
                'message': {
                    'content': json.dumps({
                        'state': 'page',
                        'action': 'click',
                        'bounding_box': [250, 375, 750, 625],
                    }),
                },
            }],
        }

        def mock_post(self_client, url, **kwargs):
            return TestVLMClientAnalyze._make_response(mock_json)

        monkeypatch.setattr(httpx.Client, 'post', mock_post)

        # 200x100 landscape image
        test_png = _make_test_png_b64(width=200, height=100)
        with VLMClient(
            base_url='https://api.example.com',
            api_key='test-key',
            model='test-model',
            coord_normalize=True,
            coord_square_pad=True,
        ) as client:
            result, scale_factor = client.analyze(
                screenshot_b64=test_png,
                system_prompt='test prompt',
            )

        assert scale_factor == 1.0
        bbox = result['bounding_box']
        # s=200, pad_x=0, pad_y=50
        # x1: 250/1000*200 - 0 = 50.0
        # y1: 375/1000*200 - 50 = 75 - 50 = 25.0
        # x2: 750/1000*200 - 0 = 150.0
        # y2: 625/1000*200 - 50 = 125 - 50 = 75.0
        assert abs(bbox[0] - 50.0) < 0.1
        assert abs(bbox[1] - 25.0) < 0.1
        assert abs(bbox[2] - 150.0) < 0.1
        assert abs(bbox[3] - 75.0) < 0.1

    def test_coord_square_pad_noop_for_square_image(self, monkeypatch) -> None:
        """coord_square_pad=True has no effect when image is already square."""
        import httpx

        mock_json = {
            'choices': [{
                'message': {
                    'content': json.dumps({
                        'state': 'page',
                        'action': 'click',
                        'bounding_box': [321, 335, 666, 398],
                    }),
                },
            }],
        }

        def mock_post(self_client, url, **kwargs):
            return TestVLMClientAnalyze._make_response(mock_json)

        monkeypatch.setattr(httpx.Client, 'post', mock_post)

        # Square image: no padding needed
        test_png = _make_test_png_b64(width=200, height=200)
        with VLMClient(
            base_url='https://api.example.com',
            api_key='test-key',
            model='test-model',
            coord_normalize=True,
            coord_square_pad=True,
        ) as client:
            result, _ = client.analyze(
                screenshot_b64=test_png,
                system_prompt='test prompt',
            )

        bbox = result['bounding_box']
        # Same as regular denormalization: 321/1000*200 = 64.2, etc.
        assert abs(bbox[0] - 64.2) < 0.1
        assert abs(bbox[1] - 67.0) < 0.1

    def test_coord_yx_swaps_before_denorm(self, monkeypatch) -> None:
        """Both coord_yx and coord_normalize: swap [y,x,y,x] then denormalize."""
        import httpx

        # VLM returns [y1, x1, y2, x2] in 0-1000 space
        mock_json = {
            'choices': [{
                'message': {
                    'content': json.dumps({
                        'state': 'page',
                        'action': 'click',
                        'bounding_box': [335, 321, 398, 666],
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
            model='some-model',
            coord_normalize=True,
            coord_yx=True,
        ) as client:
            result, scale_factor = client.analyze(
                screenshot_b64=test_png,
                system_prompt='test prompt',
            )

        assert scale_factor == 1.0
        # After swap: [321, 335, 666, 398], then denorm: 321/1000*200=64.2, etc.
        bbox = result['bounding_box']
        assert abs(bbox[0] - 64.2) < 0.1
        assert abs(bbox[1] - 33.5) < 0.1
        assert abs(bbox[2] - 133.2) < 0.1
        assert abs(bbox[3] - 39.8) < 0.1

    def test_config_fallback(self, monkeypatch) -> None:
        """VLMClient picks up env values via get_vlm_config when params not passed."""
        monkeypatch.setattr('agent.config.get_vlm_config', lambda: {
            'url': '', 'key': '', 'model': 'qwen3-vl-32b',
            'max_width': 800,
            'coord_normalize': True,
            'coord_yx': True,
            'coord_square_pad': True,
        })

        client = VLMClient(
            base_url='https://api.example.com',
            api_key='test-key',
            model='test-model',
        )
        assert client._max_image_width == 800
        assert client._normalized_coords is True
        assert client._coord_yx is True
        assert client._coord_square_pad is True
        client.close()

    def test_max_image_width_from_config(self, monkeypatch) -> None:
        """VLM_MAX_WIDTH config controls resize threshold."""
        import httpx

        monkeypatch.setattr('agent.config.get_vlm_config', lambda: {
            'url': '', 'key': '', 'model': 'qwen3-vl-32b',
            'max_width': 800,
            'coord_normalize': False,
            'coord_yx': False,
            'coord_square_pad': False,
        })

        mock_json = {
            'choices': [{
                'message': {
                    'content': json.dumps({'action': 'done'}),
                },
            }],
        }

        def mock_post(self_client, url, **kwargs):
            return TestVLMClientAnalyze._make_response(mock_json)

        monkeypatch.setattr(httpx.Client, 'post', mock_post)

        # 1600px wide, config max=800 -> scale_factor = 2.0
        big_png = _make_test_png_b64(width=1600, height=900)
        with VLMClient(
            base_url='https://api.example.com',
            api_key='test-key',
            model='test-model',
        ) as client:
            _, scale_factor = client.analyze(
                screenshot_b64=big_png,
                system_prompt='test prompt',
            )

        assert scale_factor == 2.0


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

    def test_with_offsets_for_square_padding(self) -> None:
        """Offsets subtract padding from denormalized coords."""
        # Simulate 1024x656 image padded to 1024x1024: pad_y = (1024-656)/2 = 184
        obj = {'bounding_box': [500, 500, 1000, 1000]}
        _denormalize_bboxes(obj, 1024, 1024, offset_x=0.0, offset_y=184.0)
        # x1: 500/1000*1024 - 0 = 512.0
        # y1: 500/1000*1024 - 184 = 512 - 184 = 328.0
        assert abs(obj['bounding_box'][0] - 512.0) < 0.1
        assert abs(obj['bounding_box'][1] - 328.0) < 0.1
        assert abs(obj['bounding_box'][2] - 1024.0) < 0.1
        assert abs(obj['bounding_box'][3] - 840.0) < 0.1


# ===========================================================================
# YX bbox swap tests
# ===========================================================================


class TestSwapYxBboxes:
    """Recursive [y1, x1, y2, x2] -> [x1, y1, x2, y2] swap."""

    def test_top_level_swap(self) -> None:
        obj = {'bounding_box': [10, 20, 30, 40]}
        _swap_yx_bboxes(obj)
        assert obj['bounding_box'] == [20, 10, 40, 30]

    def test_nested_dicts(self) -> None:
        obj = {
            'code_boxes': [
                {'label': 'c1', 'box': [100, 200, 300, 400]},
            ],
        }
        _swap_yx_bboxes(obj)
        assert obj['code_boxes'][0]['box'] == [200, 100, 400, 300]

    def test_nested_lists(self) -> None:
        obj = {
            'actions': [
                {'action': 'click', 'box': [10, 20, 30, 40]},
                {'action': 'click', 'box': [50, 60, 70, 80]},
            ],
        }
        _swap_yx_bboxes(obj)
        assert obj['actions'][0]['box'] == [20, 10, 40, 30]
        assert obj['actions'][1]['box'] == [60, 50, 80, 70]

    def test_non_bbox_lists_untouched(self) -> None:
        obj = {
            'tags': ['a', 'b', 'c', 'd'],
            'pair': [1, 2],
            'confidence': 0.95,
        }
        _swap_yx_bboxes(obj)
        assert obj['tags'] == ['a', 'b', 'c', 'd']
        assert obj['pair'] == [1, 2]
        assert obj['confidence'] == 0.95


