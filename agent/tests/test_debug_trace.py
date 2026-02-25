"""Tests for DebugTrace: per-job screenshot + VLM response forensics."""

from __future__ import annotations

import base64
import io
import json
import os
import time
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest
from PIL import Image

from agent.debug_trace import DebugTrace, _draw_bbox_overlay


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# 1x1 red PNG for testing (used by core tests that don't need real image data)
_TINY_PNG = base64.b64encode(
    b'\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01'
    b'\x00\x00\x00\x01\x08\x02\x00\x00\x00\x90wS\xde\x00'
    b'\x00\x00\x0cIDATx\x9cc\xf8\x0f\x00\x00\x01\x01\x00'
    b'\x05\x18\xd8N\x00\x00\x00\x00IEND\xaeB`\x82'
).decode()


def _make_test_png(width: int = 800, height: int = 600) -> str:
    """Create a base64-encoded PNG of the given size."""
    img = Image.new('RGB', (width, height), color=(200, 200, 200))
    buf = io.BytesIO()
    img.save(buf, format='PNG')
    return base64.b64encode(buf.getvalue()).decode()


_TEST_PNG = _make_test_png()

_SAMPLE_RESPONSE = {
    'state': 'account page',
    'action': 'click',
    'target_description': 'Cancel button',
    'bounding_box': [100, 200, 300, 250],
}


# ---------------------------------------------------------------------------
# DebugTrace core tests
# ---------------------------------------------------------------------------

class TestDebugTrace:
    def test_creates_job_dir(self, tmp_path):
        trace = DebugTrace('job-001', base_dir=str(tmp_path))
        assert trace.trace_dir is not None
        assert trace.trace_dir.exists()
        assert trace.trace_dir.name == 'job-001'

    def test_disabled_does_not_create_dir(self, tmp_path):
        trace = DebugTrace('job-002', base_dir=str(tmp_path), enabled=False)
        assert not (tmp_path / 'job-002').exists()

    def test_empty_job_id_does_not_create_dir(self, tmp_path):
        trace = DebugTrace('', base_dir=str(tmp_path))
        assert trace.trace_dir is None

    def test_save_step_writes_png_and_json(self, tmp_path):
        trace = DebugTrace('job-003', base_dir=str(tmp_path))
        trace.save_step(0, _TINY_PNG, _SAMPLE_RESPONSE, phase='cancel')

        png_path = trace.trace_dir / 'step_000.png'
        json_path = trace.trace_dir / 'step_000.json'

        assert png_path.exists()
        assert png_path.read_bytes()[:4] == b'\x89PNG'

        assert json_path.exists()
        data = json.loads(json_path.read_text())
        assert data['step'] == 0
        assert data['phase'] == 'cancel'
        assert data['vlm_response']['action'] == 'click'
        assert 'timestamp' in data

    def test_save_step_with_none_response(self, tmp_path):
        trace = DebugTrace('job-004', base_dir=str(tmp_path))
        trace.save_step(5, _TINY_PNG, None, phase='sign-in')

        json_path = trace.trace_dir / 'step_005.json'
        assert json_path.exists()
        data = json.loads(json_path.read_text())
        assert 'vlm_response' not in data
        assert data['phase'] == 'sign-in'

    def test_save_step_disabled_is_noop(self, tmp_path):
        trace = DebugTrace('job-005', base_dir=str(tmp_path), enabled=False)
        trace.save_step(0, _TINY_PNG, _SAMPLE_RESPONSE)
        assert not (tmp_path / 'job-005').exists()

    def test_save_step_pads_step_number(self, tmp_path):
        trace = DebugTrace('job-006', base_dir=str(tmp_path))
        trace.save_step(42, _TINY_PNG, _SAMPLE_RESPONSE)
        assert (trace.trace_dir / 'step_042.png').exists()
        assert (trace.trace_dir / 'step_042.json').exists()

    def test_save_step_writes_sent_image(self, tmp_path):
        """Sent image (what VLM actually saw) is saved as _sent.jpg."""
        trace = DebugTrace('job-sent', base_dir=str(tmp_path))
        # Create a JPEG to mimic VLMClient._resize_if_needed output
        img = Image.new('RGB', (640, 480), color=(100, 100, 100))
        buf = io.BytesIO()
        img.save(buf, format='JPEG', quality=85)
        sent_b64 = base64.b64encode(buf.getvalue()).decode()

        trace.save_step(0, _TINY_PNG, _SAMPLE_RESPONSE, phase='cancel',
                        scale_factor=1.0, sent_image_b64=sent_b64)

        sent_path = trace.trace_dir / 'step_000_sent.jpg'
        assert sent_path.exists()
        # Verify it's a JPEG
        assert sent_path.read_bytes()[:2] == b'\xff\xd8'

    def test_save_step_writes_prompt(self, tmp_path):
        """System prompt sent to VLM is saved as _prompt.txt."""
        trace = DebugTrace('job-prompt', base_dir=str(tmp_path))
        prompt_text = 'You are a browser automation assistant...'
        trace.save_step(0, _TINY_PNG, _SAMPLE_RESPONSE, phase='cancel',
                        prompt=prompt_text)

        prompt_path = trace.trace_dir / 'step_000_prompt.txt'
        assert prompt_path.exists()
        assert prompt_path.read_text() == prompt_text

    def test_save_step_no_sent_image_no_file(self, tmp_path):
        """No _sent.jpg when sent_image_b64 is empty."""
        trace = DebugTrace('job-nosent', base_dir=str(tmp_path))
        trace.save_step(0, _TINY_PNG, _SAMPLE_RESPONSE, phase='cancel')
        assert not (trace.trace_dir / 'step_000_sent.jpg').exists()

    def test_save_step_no_prompt_no_file(self, tmp_path):
        """No _prompt.txt when prompt is empty."""
        trace = DebugTrace('job-noprompt', base_dir=str(tmp_path))
        trace.save_step(0, _TINY_PNG, _SAMPLE_RESPONSE, phase='cancel')
        assert not (trace.trace_dir / 'step_000_prompt.txt').exists()

    def test_cleanup_success_removes_dir(self, tmp_path):
        trace = DebugTrace('job-007', base_dir=str(tmp_path))
        trace.save_step(0, _TINY_PNG, _SAMPLE_RESPONSE)
        assert trace.trace_dir.exists()

        trace.cleanup_success()
        assert not trace.trace_dir.exists()

    def test_cleanup_success_on_missing_dir_is_noop(self, tmp_path):
        trace = DebugTrace('job-008', base_dir=str(tmp_path))
        trace.trace_dir.rmdir()  # remove before calling cleanup
        trace.cleanup_success()  # should not raise

    def test_cleanup_success_empty_job_id_is_noop(self, tmp_path):
        trace = DebugTrace('', base_dir=str(tmp_path))
        trace.cleanup_success()  # should not raise

    def test_cleanup_success_keeps_trace_when_keep_all(self, tmp_path, monkeypatch):
        monkeypatch.setenv('AGENT_DEBUG_KEEP_ALL', '1')
        trace = DebugTrace('job-keep', base_dir=str(tmp_path))
        trace.save_step(0, _TINY_PNG, _SAMPLE_RESPONSE)
        trace.cleanup_success()
        assert trace.trace_dir.exists()
        assert (trace.trace_dir / 'step_000.json').exists()

    def test_cleanup_success_deletes_when_keep_all_not_set(self, tmp_path, monkeypatch):
        monkeypatch.delenv('AGENT_DEBUG_KEEP_ALL', raising=False)
        trace = DebugTrace('job-del', base_dir=str(tmp_path))
        trace.save_step(0, _TINY_PNG, _SAMPLE_RESPONSE)
        trace.cleanup_success()
        assert not trace.trace_dir.exists()

    def test_cleanup_success_deletes_when_keep_all_zero(self, tmp_path, monkeypatch):
        """AGENT_DEBUG_KEEP_ALL=0 means don't keep."""
        monkeypatch.setenv('AGENT_DEBUG_KEEP_ALL', '0')
        trace = DebugTrace('job-zero', base_dir=str(tmp_path))
        trace.save_step(0, _TINY_PNG, _SAMPLE_RESPONSE)
        trace.cleanup_success()
        assert not trace.trace_dir.exists()

    def test_cleanup_success_keeps_when_keep_all_any_truthy(self, tmp_path, monkeypatch):
        """Any non-zero value for AGENT_DEBUG_KEEP_ALL keeps the trace."""
        monkeypatch.setenv('AGENT_DEBUG_KEEP_ALL', 'yes')
        trace = DebugTrace('job-yes', base_dir=str(tmp_path))
        trace.save_step(0, _TINY_PNG, _SAMPLE_RESPONSE)
        trace.cleanup_success()
        assert trace.trace_dir.exists()


# ---------------------------------------------------------------------------
# Prune old traces
# ---------------------------------------------------------------------------

class TestPruneOld:
    def test_prunes_old_folders(self, tmp_path):
        # Create an "old" folder
        old_dir = tmp_path / 'old-job'
        old_dir.mkdir()
        (old_dir / 'step_000.png').write_bytes(b'fake')
        # Set mtime to 30 days ago
        old_time = time.time() - (30 * 86400)
        os.utime(old_dir, (old_time, old_time))

        # Create a "recent" folder
        recent_dir = tmp_path / 'recent-job'
        recent_dir.mkdir()
        (recent_dir / 'step_000.png').write_bytes(b'fake')

        deleted = DebugTrace.prune_old(base_dir=str(tmp_path), max_age_days=14)
        assert deleted == 1
        assert not old_dir.exists()
        assert recent_dir.exists()

    def test_prune_nonexistent_dir_returns_zero(self, tmp_path):
        deleted = DebugTrace.prune_old(
            base_dir=str(tmp_path / 'nonexistent'),
        )
        assert deleted == 0

    def test_prune_empty_dir_returns_zero(self, tmp_path):
        deleted = DebugTrace.prune_old(base_dir=str(tmp_path))
        assert deleted == 0

    def test_prune_skips_files(self, tmp_path):
        # A stray file in the debug dir should not cause errors
        (tmp_path / 'stray.txt').write_text('junk')
        old_time = time.time() - (30 * 86400)
        os.utime(tmp_path / 'stray.txt', (old_time, old_time))

        deleted = DebugTrace.prune_old(base_dir=str(tmp_path))
        assert deleted == 0
        assert (tmp_path / 'stray.txt').exists()


# ---------------------------------------------------------------------------
# Integration with VLMExecutor
# ---------------------------------------------------------------------------

class TestDebugTraceVLMIntegration:
    """Verify DebugTrace is wired into VLMExecutor correctly."""

    @pytest.fixture(autouse=True)
    def _mock_system(self, monkeypatch, tmp_path):
        """Mock all system interactions for VLMExecutor tests."""
        self.tmp_path = tmp_path
        session = MagicMock()
        session.pid = 12345
        session.window_id = 42
        session.bounds = {'x': 0, 'y': 0, 'width': 1280, 'height': 900}
        session.profile_dir = '/tmp/ub-chrome-test'

        monkeypatch.setattr('agent.vlm_executor.browser.create_session', lambda: session)
        monkeypatch.setattr('agent.vlm_executor.browser.navigate', lambda *a, **kw: None)
        monkeypatch.setattr('agent.vlm_executor.browser.get_session_window', lambda s: s.bounds)
        monkeypatch.setattr('agent.vlm_executor.browser.close_session', lambda s: None)
        monkeypatch.setattr('agent.vlm_executor.ss.capture_to_base64', lambda wid: _TINY_PNG)
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
        monkeypatch.setattr('agent.vlm_executor.random.random', lambda: 0.5)

        # Redirect debug trace to tmp_path
        monkeypatch.setattr('agent.debug_trace.DEFAULT_DEBUG_DIR', str(tmp_path))
        monkeypatch.setattr('agent.vlm_executor.DebugTrace.prune_old',
                            lambda **kw: 0)

    def test_success_cleans_up_trace(self):
        from agent.vlm_executor import VLMExecutor

        signed_in = {'page_type': 'signed_in'}
        cancel_done = {
            'state': 'confirmation', 'action': 'done',
            'billing_end_date': '2026-03-15',
        }
        vlm = MagicMock()
        vlm.analyze = MagicMock(side_effect=[
            (signed_in, 1.0), (cancel_done, 1.0),
        ])

        executor = VLMExecutor(vlm, settle_delay=0, debug=True)
        result = executor.run('netflix', 'cancel', {'email': 'a', 'pass': 'b'},
                              job_id='job-success')
        assert result.success
        # Folder should be cleaned up
        assert not (self.tmp_path / 'job-success').exists()

    def test_failure_keeps_trace(self):
        from agent.vlm_executor import VLMExecutor

        captcha = {'page_type': 'captcha'}
        vlm = MagicMock()
        vlm.analyze = MagicMock(side_effect=[(captcha, 1.0)])

        executor = VLMExecutor(vlm, settle_delay=0, debug=True)
        result = executor.run('netflix', 'cancel', {'email': 'a', 'pass': 'b'},
                              job_id='job-fail')
        assert not result.success
        # Folder should persist with the step
        job_dir = self.tmp_path / 'job-fail'
        assert job_dir.exists()
        assert (job_dir / 'step_000.json').exists()
        assert (job_dir / 'step_000.png').exists()

    def test_debug_disabled_no_trace(self):
        from agent.vlm_executor import VLMExecutor

        captcha = {'page_type': 'captcha'}
        vlm = MagicMock()
        vlm.analyze = MagicMock(side_effect=[(captcha, 1.0)])

        executor = VLMExecutor(vlm, settle_delay=0, debug=False)
        result = executor.run('netflix', 'cancel', {'email': 'a', 'pass': 'b'},
                              job_id='job-nodebug')
        assert not result.success
        assert not (self.tmp_path / 'job-nodebug').exists()

    def test_no_job_id_no_trace(self):
        from agent.vlm_executor import VLMExecutor

        signed_in = {'page_type': 'signed_in'}
        cancel_done = {
            'state': 'confirmation', 'action': 'done',
            'billing_end_date': None,
        }
        vlm = MagicMock()
        vlm.analyze = MagicMock(side_effect=[
            (signed_in, 1.0), (cancel_done, 1.0),
        ])

        executor = VLMExecutor(vlm, settle_delay=0, debug=True)
        result = executor.run('netflix', 'cancel', {'email': 'a', 'pass': 'b'})
        assert result.success
        # No job_id means no trace folder at all
        assert len(list(self.tmp_path.iterdir())) == 0

    def test_vlm_error_still_saves_step(self):
        from agent.vlm_executor import VLMExecutor

        cancel_done = {
            'state': 'confirmation', 'action': 'done',
            'billing_end_date': None,
        }
        vlm = MagicMock()
        vlm.analyze = MagicMock(side_effect=[
            ({'page_type': 'signed_in'}, 1.0),
            RuntimeError('API timeout'),
            (cancel_done, 1.0),
        ])

        executor = VLMExecutor(vlm, settle_delay=0, debug=True)
        result = executor.run('netflix', 'cancel', {'email': 'a', 'pass': 'b'},
                              job_id='job-vlmerr')
        assert result.success
        # Folder cleaned up on success, but the error step was recorded
        assert not (self.tmp_path / 'job-vlmerr').exists()

    def test_failure_saves_sent_image_and_prompt(self):
        """Failed jobs save sent image and prompt alongside screenshot."""
        from agent.vlm_executor import VLMExecutor

        # Build a valid base64 JPEG to simulate VLMClient._resize_if_needed output
        img = Image.new('RGB', (640, 480), color=(100, 100, 100))
        buf = io.BytesIO()
        img.save(buf, format='JPEG', quality=85)
        sent_b64 = base64.b64encode(buf.getvalue()).decode()

        captcha = {'page_type': 'captcha'}
        vlm = MagicMock()
        vlm.analyze = MagicMock(side_effect=[(captcha, 1.0)])
        vlm.last_sent_image_b64 = sent_b64

        executor = VLMExecutor(vlm, settle_delay=0, debug=True)
        result = executor.run('netflix', 'cancel', {'email': 'a', 'pass': 'b'},
                              job_id='job-artifacts')
        assert not result.success

        job_dir = self.tmp_path / 'job-artifacts'
        assert job_dir.exists()
        # Prompt should be saved
        prompt_path = job_dir / 'step_000_prompt.txt'
        assert prompt_path.exists()
        assert len(prompt_path.read_text()) > 0
        # Sent image should be saved
        sent_path = job_dir / 'step_000_sent.jpg'
        assert sent_path.exists()
        assert sent_path.read_bytes()[:2] == b'\xff\xd8'  # JPEG magic


# ---------------------------------------------------------------------------
# Bbox overlay tests
# ---------------------------------------------------------------------------

class TestDrawBboxOverlay:
    """Tests for _draw_bbox_overlay and save_step overlay generation."""

    def test_overlay_created_with_scale_factor(self, tmp_path):
        """Overlay PNG is written when scale_factor > 0 and response has bboxes."""
        trace = DebugTrace('job-overlay', base_dir=str(tmp_path))
        trace.save_step(0, _TEST_PNG, _SAMPLE_RESPONSE, phase='cancel',
                        scale_factor=1.0)
        overlay_path = trace.trace_dir / 'step_000_overlay.png'
        assert overlay_path.exists()
        # Verify it's a valid PNG
        img = Image.open(overlay_path)
        assert img.size == (800, 600)

    def test_no_overlay_when_scale_factor_zero(self, tmp_path):
        """Default scale_factor=0 produces no overlay."""
        trace = DebugTrace('job-no-overlay', base_dir=str(tmp_path))
        trace.save_step(0, _TEST_PNG, _SAMPLE_RESPONSE, phase='cancel')
        overlay_path = trace.trace_dir / 'step_000_overlay.png'
        assert not overlay_path.exists()

    def test_no_overlay_when_response_none(self, tmp_path):
        """No overlay when vlm_response is None (VLM error case)."""
        trace = DebugTrace('job-none-resp', base_dir=str(tmp_path))
        trace.save_step(0, _TEST_PNG, None, phase='cancel', scale_factor=1.0)
        overlay_path = trace.trace_dir / 'step_000_overlay.png'
        assert not overlay_path.exists()

    def test_no_overlay_when_no_bboxes(self, tmp_path):
        """No overlay when response has no bbox keys."""
        response = {'state': 'loading', 'action': 'wait'}
        trace = DebugTrace('job-no-bbox', base_dir=str(tmp_path))
        trace.save_step(0, _TEST_PNG, response, phase='cancel',
                        scale_factor=1.0)
        overlay_path = trace.trace_dir / 'step_000_overlay.png'
        assert not overlay_path.exists()

    def test_original_png_preserved(self, tmp_path):
        """Original screenshot PNG is unchanged when overlay is drawn."""
        trace = DebugTrace('job-preserve', base_dir=str(tmp_path))
        trace.save_step(0, _TEST_PNG, _SAMPLE_RESPONSE, phase='cancel',
                        scale_factor=1.0)
        original_path = trace.trace_dir / 'step_000.png'
        original_bytes = original_path.read_bytes()
        expected_bytes = base64.b64decode(_TEST_PNG)
        assert original_bytes == expected_bytes

    def test_signin_response_boxes(self):
        """Sign-in response with email_box, password_box, button_box."""
        response = {
            'page_type': 'user_pass',
            'email_box': [10, 20, 200, 50],
            'password_box': [10, 70, 200, 100],
            'button_box': [50, 120, 150, 150],
            'profile_box': None,
            'code_boxes': None,
        }
        result = _draw_bbox_overlay(_TEST_PNG, response, 1.0)
        assert result is not None
        img = Image.open(io.BytesIO(result))
        assert img.size == (800, 600)

    def test_code_boxes_handled(self):
        """code_boxes list entries are drawn."""
        response = {
            'page_type': 'email_code_single',
            'email_box': None,
            'password_box': None,
            'button_box': [200, 400, 350, 440],
            'profile_box': None,
            'code_boxes': [{'label': 'code', 'box': [100, 300, 400, 340]}],
        }
        result = _draw_bbox_overlay(_TEST_PNG, response, 1.0)
        assert result is not None

    def test_scale_factor_applied(self):
        """Bboxes are scaled by scale_factor (VLM coords != image coords)."""
        response = {
            'state': 'page',
            'action': 'click',
            'target_description': 'button',
            'bounding_box': [100, 100, 200, 200],
        }
        # scale_factor=2.0 means box drawn at [200,200,400,400]
        result = _draw_bbox_overlay(_TEST_PNG, response, 2.0)
        assert result is not None
        # Check the overlay is different from a 1.0 scale overlay
        result_1x = _draw_bbox_overlay(_TEST_PNG, response, 1.0)
        assert result != result_1x

    def test_overlay_uses_sent_image_when_available(self, tmp_path):
        """Overlay is drawn on VLM-sent image (not full-res) when provided."""
        # Full-res screenshot: 800x600
        full_res = _make_test_png(800, 600)
        # Sent image: 640x480 (what VLM saw after resize)
        sent_img = Image.new('RGB', (640, 480), color=(150, 150, 150))
        buf = io.BytesIO()
        sent_img.save(buf, format='JPEG', quality=85)
        sent_b64 = base64.b64encode(buf.getvalue()).decode()

        trace = DebugTrace('job-overlay-sent', base_dir=str(tmp_path))
        trace.save_step(0, full_res, _SAMPLE_RESPONSE, phase='cancel',
                        scale_factor=1.25, sent_image_b64=sent_b64)

        overlay_path = trace.trace_dir / 'step_000_overlay.png'
        assert overlay_path.exists()
        overlay_img = Image.open(overlay_path)
        # Overlay should be 640x480 (sent image size), not 800x600
        assert overlay_img.size == (640, 480)

    def test_overlay_falls_back_to_original_without_sent_image(self, tmp_path):
        """Without sent_image_b64, overlay uses the original screenshot."""
        trace = DebugTrace('job-overlay-fallback', base_dir=str(tmp_path))
        trace.save_step(0, _TEST_PNG, _SAMPLE_RESPONSE, phase='cancel',
                        scale_factor=1.0)

        overlay_path = trace.trace_dir / 'step_000_overlay.png'
        assert overlay_path.exists()
        overlay_img = Image.open(overlay_path)
        assert overlay_img.size == (800, 600)
