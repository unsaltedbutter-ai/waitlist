"""Tests for agent.recording.converter: flat recording to page-based conversion.

Uses synthetic flat playbooks, manifests, and images to validate the full
conversion pipeline without requiring a real recording session.

Run: cd agent && python -m pytest tests/test_converter.py -v
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from PIL import Image

from agent.page_cache import PageCache
from agent.page_playbook import FlowConfig, PagePlaybook
from agent.recording.converter import ConvertResult, convert_recording


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

def _solid_image(color: tuple[int, int, int], size: tuple[int, int] = (1280, 720)) -> Image.Image:
    return Image.new('RGB', size, color)


def _write_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, 'w') as f:
        json.dump(data, f, indent=2)


@pytest.fixture()
def cache(tmp_path: Path) -> PageCache:
    db = tmp_path / 'test_hashes.db'
    c = PageCache(db)
    yield c
    c.close()


@pytest.fixture()
def recording_dir(tmp_path: Path) -> Path:
    """Set up a synthetic recording: flat playbook + manifest + ref screenshots."""
    playbook_dir = tmp_path / 'playbooks'
    ref_dir = tmp_path / 'playbooks' / 'ref' / 'netflix_cancel'
    playbook_dir.mkdir(parents=True)
    ref_dir.mkdir(parents=True)

    # Flat playbook: navigate -> sign-in page steps -> checkpoint wait -> cancel page steps
    flat_steps = [
        {'action': 'navigate', 'url': 'https://www.netflix.com/login'},
        {'action': 'click', 'target_description': 'email input', 'ref_region': [380, 200, 620, 230]},
        {'action': 'type_text', 'value': '{email}'},
        {'action': 'press_key', 'value': 'tab'},
        {'action': 'type_text', 'value': '{pass}', 'sensitive': True},
        {'action': 'press_key', 'value': 'enter'},
        {'action': 'wait', 'wait_after_sec': [2, 4], 'checkpoint': True,
         'checkpoint_prompt': 'sign-in phase complete'},
        {'action': 'click', 'target_description': 'Account link', 'ref_region': [100, 50, 200, 80]},
        {'action': 'click', 'target_description': 'Cancel Membership button',
         'ref_region': [300, 400, 500, 440], 'checkpoint': True},
        {'action': 'click', 'target_description': 'Finish Cancellation button',
         'ref_region': [350, 500, 550, 540]},
    ]

    playbook_data = {
        'service': 'netflix',
        'flow': 'cancel',
        'version': 1,
        'notes': 'Test recording',
        'last_validated': None,
        'steps': flat_steps,
    }
    _write_json(playbook_dir / 'netflix_cancel.json', playbook_data)

    # Manifest: 3 pages
    manifest = {
        'service': 'netflix',
        'flow': 'cancel',
        'start_url': 'https://www.netflix.com/login',
        'recorded_at': '2026-02-21T14:30:00',
        'pages': [
            {
                'page_index': 0,
                'label': 'login',
                'screenshot': 'step_01.png',
                'step_range': [0, 5],
                'boundary': 'checkpoint',
            },
            {
                'page_index': 1,
                'label': 'account',
                'screenshot': 'step_07.png',
                'step_range': [7, 8],
                'boundary': 'checkpoint',
            },
            {
                'page_index': 2,
                'label': 'cancel_confirm',
                'screenshot': 'step_09.png',
                'step_range': [9, 9],
                'boundary': 'end',
            },
        ],
    }
    _write_json(ref_dir / '_manifest.json', manifest)

    # Save ref screenshots (different colors so hashes differ)
    _solid_image((200, 100, 100)).save(ref_dir / 'step_01.png')
    _solid_image((100, 200, 100)).save(ref_dir / 'step_07.png')
    _solid_image((100, 100, 200)).save(ref_dir / 'step_09.png')

    return tmp_path


# ---------------------------------------------------------------------------
# Basic conversion
# ---------------------------------------------------------------------------

class TestConvertRecording:
    def test_creates_page_playbooks(
        self, recording_dir: Path, cache: PageCache, tmp_path: Path, monkeypatch,
    ) -> None:
        """Converter creates one page playbook JSON per manifest page."""
        pages_dir = tmp_path / 'out_pages'
        flows_dir = tmp_path / 'out_flows'
        ref_screenshots_dir = tmp_path / 'out_refs'
        monkeypatch.setattr('agent.recording.converter.PAGES_DIR', pages_dir)
        monkeypatch.setattr('agent.recording.converter.FLOWS_DIR', flows_dir)
        monkeypatch.setattr('agent.recording.converter.REF_SCREENSHOTS_DIR', ref_screenshots_dir)

        result = convert_recording(
            service='netflix',
            flow='cancel',
            playbook_path=recording_dir / 'playbooks' / 'netflix_cancel.json',
            manifest_path=recording_dir / 'playbooks' / 'ref' / 'netflix_cancel' / '_manifest.json',
            ref_dir=recording_dir / 'playbooks' / 'ref' / 'netflix_cancel',
            cache=cache,
        )

        assert result.pages_created == 3
        assert len(result.page_paths) == 3
        assert all(p.exists() for p in result.page_paths)

    def test_page_playbook_content(
        self, recording_dir: Path, cache: PageCache, tmp_path: Path, monkeypatch,
    ) -> None:
        """Page playbooks contain the correct actions (boundary steps filtered out)."""
        pages_dir = tmp_path / 'out_pages'
        flows_dir = tmp_path / 'out_flows'
        ref_screenshots_dir = tmp_path / 'out_refs'
        monkeypatch.setattr('agent.recording.converter.PAGES_DIR', pages_dir)
        monkeypatch.setattr('agent.recording.converter.FLOWS_DIR', flows_dir)
        monkeypatch.setattr('agent.recording.converter.REF_SCREENSHOTS_DIR', ref_screenshots_dir)

        convert_recording(
            service='netflix',
            flow='cancel',
            playbook_path=recording_dir / 'playbooks' / 'netflix_cancel.json',
            manifest_path=recording_dir / 'playbooks' / 'ref' / 'netflix_cancel' / '_manifest.json',
            ref_dir=recording_dir / 'playbooks' / 'ref' / 'netflix_cancel',
            cache=cache,
        )

        # Page 0 (login): steps 0-5, but navigate (step 0) is filtered out
        # Remaining: click, type_text, press_key, type_text, press_key = 5 actions
        pb0 = PagePlaybook.from_file(pages_dir / 'netflix_login.json')
        assert pb0.page_id == 'netflix_login'
        assert pb0.service == 'netflix'
        assert pb0.flows == ('cancel',)
        assert len(pb0.actions) == 5
        assert pb0.actions[0].action == 'click'
        assert pb0.actions[0].target_description == 'email input'
        assert pb0.actions[1].action == 'type_text'
        assert pb0.actions[1].value == '{email}'
        assert pb0.terminal is False

        # Page 1 (account): steps 7-8, both clicks
        pb1 = PagePlaybook.from_file(pages_dir / 'netflix_account.json')
        assert pb1.page_id == 'netflix_account'
        assert len(pb1.actions) == 2
        assert pb1.actions[0].target_description == 'Account link'
        assert pb1.actions[1].target_description == 'Cancel Membership button'
        assert pb1.terminal is False

        # Page 2 (cancel_confirm): step 9, one click, terminal
        pb2 = PagePlaybook.from_file(pages_dir / 'netflix_cancel_confirm.json')
        assert pb2.page_id == 'netflix_cancel_confirm'
        assert len(pb2.actions) == 1
        assert pb2.actions[0].target_description == 'Finish Cancellation button'
        assert pb2.terminal is True

    def test_flow_config_created(
        self, recording_dir: Path, cache: PageCache, tmp_path: Path, monkeypatch,
    ) -> None:
        """Converter creates a FlowConfig with the correct start URL."""
        pages_dir = tmp_path / 'out_pages'
        flows_dir = tmp_path / 'out_flows'
        ref_screenshots_dir = tmp_path / 'out_refs'
        monkeypatch.setattr('agent.recording.converter.PAGES_DIR', pages_dir)
        monkeypatch.setattr('agent.recording.converter.FLOWS_DIR', flows_dir)
        monkeypatch.setattr('agent.recording.converter.REF_SCREENSHOTS_DIR', ref_screenshots_dir)

        result = convert_recording(
            service='netflix',
            flow='cancel',
            playbook_path=recording_dir / 'playbooks' / 'netflix_cancel.json',
            manifest_path=recording_dir / 'playbooks' / 'ref' / 'netflix_cancel' / '_manifest.json',
            ref_dir=recording_dir / 'playbooks' / 'ref' / 'netflix_cancel',
            cache=cache,
        )

        fc = FlowConfig.from_file(result.flow_config_path)
        assert fc.service == 'netflix'
        assert fc.flow == 'cancel'
        assert fc.start_url == 'https://www.netflix.com/login'
        assert fc.max_pages >= 6  # at least 2x page count

    def test_hash_entries_inserted(
        self, recording_dir: Path, cache: PageCache, tmp_path: Path, monkeypatch,
    ) -> None:
        """Converter inserts hash entries for each page with a ref screenshot."""
        pages_dir = tmp_path / 'out_pages'
        flows_dir = tmp_path / 'out_flows'
        ref_screenshots_dir = tmp_path / 'out_refs'
        monkeypatch.setattr('agent.recording.converter.PAGES_DIR', pages_dir)
        monkeypatch.setattr('agent.recording.converter.FLOWS_DIR', flows_dir)
        monkeypatch.setattr('agent.recording.converter.REF_SCREENSHOTS_DIR', ref_screenshots_dir)

        result = convert_recording(
            service='netflix',
            flow='cancel',
            playbook_path=recording_dir / 'playbooks' / 'netflix_cancel.json',
            manifest_path=recording_dir / 'playbooks' / 'ref' / 'netflix_cancel' / '_manifest.json',
            ref_dir=recording_dir / 'playbooks' / 'ref' / 'netflix_cancel',
            cache=cache,
        )

        assert result.hashes_inserted == 3
        stats = cache.stats()
        assert stats['entries'] == 3

        # Verify lookup works for inserted hashes
        login_img = _solid_image((200, 100, 100))
        assert cache.lookup(login_img, 'netflix', 'cancel') == 'netflix_login'

    def test_ref_screenshots_copied(
        self, recording_dir: Path, cache: PageCache, tmp_path: Path, monkeypatch,
    ) -> None:
        """Ref screenshots are copied to REF_SCREENSHOTS_DIR."""
        pages_dir = tmp_path / 'out_pages'
        flows_dir = tmp_path / 'out_flows'
        ref_screenshots_dir = tmp_path / 'out_refs'
        monkeypatch.setattr('agent.recording.converter.PAGES_DIR', pages_dir)
        monkeypatch.setattr('agent.recording.converter.FLOWS_DIR', flows_dir)
        monkeypatch.setattr('agent.recording.converter.REF_SCREENSHOTS_DIR', ref_screenshots_dir)

        result = convert_recording(
            service='netflix',
            flow='cancel',
            playbook_path=recording_dir / 'playbooks' / 'netflix_cancel.json',
            manifest_path=recording_dir / 'playbooks' / 'ref' / 'netflix_cancel' / '_manifest.json',
            ref_dir=recording_dir / 'playbooks' / 'ref' / 'netflix_cancel',
            cache=cache,
        )

        assert len(result.ref_paths) == 3
        assert all(p.exists() for p in result.ref_paths)
        assert (ref_screenshots_dir / 'netflix_login.png').exists()
        assert (ref_screenshots_dir / 'netflix_account.png').exists()
        assert (ref_screenshots_dir / 'netflix_cancel_confirm.png').exists()


# ---------------------------------------------------------------------------
# Custom page naming
# ---------------------------------------------------------------------------

class TestPageNaming:
    def test_custom_namer(
        self, recording_dir: Path, cache: PageCache, tmp_path: Path, monkeypatch,
    ) -> None:
        """page_namer callback controls the page_id."""
        pages_dir = tmp_path / 'out_pages'
        flows_dir = tmp_path / 'out_flows'
        ref_screenshots_dir = tmp_path / 'out_refs'
        monkeypatch.setattr('agent.recording.converter.PAGES_DIR', pages_dir)
        monkeypatch.setattr('agent.recording.converter.FLOWS_DIR', flows_dir)
        monkeypatch.setattr('agent.recording.converter.REF_SCREENSHOTS_DIR', ref_screenshots_dir)

        custom_names = {0: 'my_login', 1: 'my_account', 2: 'my_confirm'}

        def namer(page_index, _entry, _steps):
            return custom_names[page_index]

        result = convert_recording(
            service='netflix',
            flow='cancel',
            playbook_path=recording_dir / 'playbooks' / 'netflix_cancel.json',
            manifest_path=recording_dir / 'playbooks' / 'ref' / 'netflix_cancel' / '_manifest.json',
            ref_dir=recording_dir / 'playbooks' / 'ref' / 'netflix_cancel',
            cache=cache,
            page_namer=namer,
        )

        assert (pages_dir / 'my_login.json').exists()
        assert (pages_dir / 'my_account.json').exists()
        assert (pages_dir / 'my_confirm.json').exists()

    def test_label_based_default_naming(
        self, recording_dir: Path, cache: PageCache, tmp_path: Path, monkeypatch,
    ) -> None:
        """Without a namer, pages with labels use service_label format."""
        pages_dir = tmp_path / 'out_pages'
        flows_dir = tmp_path / 'out_flows'
        ref_screenshots_dir = tmp_path / 'out_refs'
        monkeypatch.setattr('agent.recording.converter.PAGES_DIR', pages_dir)
        monkeypatch.setattr('agent.recording.converter.FLOWS_DIR', flows_dir)
        monkeypatch.setattr('agent.recording.converter.REF_SCREENSHOTS_DIR', ref_screenshots_dir)

        convert_recording(
            service='netflix',
            flow='cancel',
            playbook_path=recording_dir / 'playbooks' / 'netflix_cancel.json',
            manifest_path=recording_dir / 'playbooks' / 'ref' / 'netflix_cancel' / '_manifest.json',
            ref_dir=recording_dir / 'playbooks' / 'ref' / 'netflix_cancel',
            cache=cache,
        )

        # Manifest has labels: 'login', 'account', 'cancel_confirm'
        assert (pages_dir / 'netflix_login.json').exists()
        assert (pages_dir / 'netflix_account.json').exists()
        assert (pages_dir / 'netflix_cancel_confirm.json').exists()


# ---------------------------------------------------------------------------
# Edge cases
# ---------------------------------------------------------------------------

class TestEdgeCases:
    def test_missing_screenshot_skips_hash(
        self, tmp_path: Path, cache: PageCache, monkeypatch,
    ) -> None:
        """Pages with missing ref screenshots skip hash insertion gracefully."""
        pages_dir = tmp_path / 'out_pages'
        flows_dir = tmp_path / 'out_flows'
        ref_screenshots_dir = tmp_path / 'out_refs'
        monkeypatch.setattr('agent.recording.converter.PAGES_DIR', pages_dir)
        monkeypatch.setattr('agent.recording.converter.FLOWS_DIR', flows_dir)
        monkeypatch.setattr('agent.recording.converter.REF_SCREENSHOTS_DIR', ref_screenshots_dir)

        # Minimal recording with missing screenshot file
        pb_dir = tmp_path / 'pb'
        ref_dir = tmp_path / 'ref'
        pb_dir.mkdir()
        ref_dir.mkdir()

        _write_json(pb_dir / 'test_cancel.json', {
            'service': 'test',
            'flow': 'cancel',
            'version': 1,
            'steps': [
                {'action': 'navigate', 'url': 'https://example.com'},
                {'action': 'click', 'target_description': 'Button'},
            ],
        })
        _write_json(ref_dir / '_manifest.json', {
            'service': 'test',
            'flow': 'cancel',
            'start_url': 'https://example.com',
            'recorded_at': '2026-02-21T00:00:00',
            'pages': [{
                'page_index': 0,
                'label': '',
                'screenshot': 'step_01.png',  # file does not exist
                'step_range': [0, 1],
                'boundary': 'end',
            }],
        })

        result = convert_recording(
            service='test',
            flow='cancel',
            playbook_path=pb_dir / 'test_cancel.json',
            manifest_path=ref_dir / '_manifest.json',
            ref_dir=ref_dir,
            cache=cache,
        )

        assert result.pages_created == 1
        assert result.hashes_inserted == 0
        assert len(result.ref_paths) == 0

    def test_no_start_url_in_manifest_falls_back_to_steps(
        self, tmp_path: Path, cache: PageCache, monkeypatch,
    ) -> None:
        """start_url from navigate step when manifest has empty start_url."""
        pages_dir = tmp_path / 'out_pages'
        flows_dir = tmp_path / 'out_flows'
        ref_screenshots_dir = tmp_path / 'out_refs'
        monkeypatch.setattr('agent.recording.converter.PAGES_DIR', pages_dir)
        monkeypatch.setattr('agent.recording.converter.FLOWS_DIR', flows_dir)
        monkeypatch.setattr('agent.recording.converter.REF_SCREENSHOTS_DIR', ref_screenshots_dir)

        pb_dir = tmp_path / 'pb'
        ref_dir = tmp_path / 'ref'
        pb_dir.mkdir()
        ref_dir.mkdir()

        _write_json(pb_dir / 'hulu_cancel.json', {
            'service': 'hulu',
            'flow': 'cancel',
            'version': 1,
            'steps': [
                {'action': 'navigate', 'url': 'https://www.hulu.com/account'},
                {'action': 'click', 'target_description': 'Cancel'},
            ],
        })
        _write_json(ref_dir / '_manifest.json', {
            'service': 'hulu',
            'flow': 'cancel',
            'start_url': '',
            'recorded_at': '2026-02-21T00:00:00',
            'pages': [{
                'page_index': 0,
                'label': '',
                'screenshot': '',
                'step_range': [0, 1],
                'boundary': 'end',
            }],
        })

        result = convert_recording(
            service='hulu',
            flow='cancel',
            playbook_path=pb_dir / 'hulu_cancel.json',
            manifest_path=ref_dir / '_manifest.json',
            ref_dir=ref_dir,
            cache=cache,
        )

        fc = FlowConfig.from_file(result.flow_config_path)
        assert fc.start_url == 'https://www.hulu.com/account'

    def test_no_start_url_anywhere_raises(
        self, tmp_path: Path, cache: PageCache, monkeypatch,
    ) -> None:
        """Raises ValueError when no start_url can be found."""
        pages_dir = tmp_path / 'out_pages'
        flows_dir = tmp_path / 'out_flows'
        ref_screenshots_dir = tmp_path / 'out_refs'
        monkeypatch.setattr('agent.recording.converter.PAGES_DIR', pages_dir)
        monkeypatch.setattr('agent.recording.converter.FLOWS_DIR', flows_dir)
        monkeypatch.setattr('agent.recording.converter.REF_SCREENSHOTS_DIR', ref_screenshots_dir)

        pb_dir = tmp_path / 'pb'
        ref_dir = tmp_path / 'ref'
        pb_dir.mkdir()
        ref_dir.mkdir()

        _write_json(pb_dir / 'x_cancel.json', {
            'service': 'x',
            'flow': 'cancel',
            'version': 1,
            'steps': [{'action': 'click', 'target_description': 'Button'}],
        })
        _write_json(ref_dir / '_manifest.json', {
            'service': 'x',
            'flow': 'cancel',
            'start_url': '',
            'recorded_at': '2026-02-21T00:00:00',
            'pages': [{
                'page_index': 0,
                'label': '',
                'screenshot': '',
                'step_range': [0, 0],
                'boundary': 'end',
            }],
        })

        with pytest.raises(ValueError, match='No start_url'):
            convert_recording(
                service='x',
                flow='cancel',
                playbook_path=pb_dir / 'x_cancel.json',
                manifest_path=ref_dir / '_manifest.json',
                ref_dir=ref_dir,
                cache=cache,
            )

    def test_sensitive_steps_preserved(
        self, recording_dir: Path, cache: PageCache, tmp_path: Path, monkeypatch,
    ) -> None:
        """Sensitive flag on steps is preserved through conversion."""
        pages_dir = tmp_path / 'out_pages'
        flows_dir = tmp_path / 'out_flows'
        ref_screenshots_dir = tmp_path / 'out_refs'
        monkeypatch.setattr('agent.recording.converter.PAGES_DIR', pages_dir)
        monkeypatch.setattr('agent.recording.converter.FLOWS_DIR', flows_dir)
        monkeypatch.setattr('agent.recording.converter.REF_SCREENSHOTS_DIR', ref_screenshots_dir)

        convert_recording(
            service='netflix',
            flow='cancel',
            playbook_path=recording_dir / 'playbooks' / 'netflix_cancel.json',
            manifest_path=recording_dir / 'playbooks' / 'ref' / 'netflix_cancel' / '_manifest.json',
            ref_dir=recording_dir / 'playbooks' / 'ref' / 'netflix_cancel',
            cache=cache,
        )

        # Page 0 has a sensitive type_text step ({pass})
        pb0 = PagePlaybook.from_file(pages_dir / 'netflix_login.json')
        sensitive_steps = [a for a in pb0.actions if a.is_sensitive]
        assert len(sensitive_steps) == 1
        assert sensitive_steps[0].value == '{pass}'


# ---------------------------------------------------------------------------
# Manifest page boundary helpers (unit tests for the recorder's tracking)
# ---------------------------------------------------------------------------

class TestRecorderPageTracking:
    """Test the page boundary tracking methods on PlaybookRecorder directly."""

    def test_close_and_open_pages(self) -> None:
        """Pages are tracked correctly through open/close cycles."""
        from agent.recording.recorder import PlaybookRecorder
        from unittest.mock import MagicMock

        vlm = MagicMock()
        recorder = PlaybookRecorder(
            vlm=vlm,
            service='netflix',
            flow='cancel',
            credentials={'email': 'test@test.com', 'pass': 'test'},
        )

        # Open first page
        recorder._open_new_page(0, 'step_00.png', 'sign-in')
        assert recorder._current_page_start == 0

        # Close first page at step 5
        recorder._close_current_page(5, 'checkpoint')
        assert len(recorder._pages) == 1
        assert recorder._pages[0]['page_index'] == 0
        assert recorder._pages[0]['label'] == 'sign-in'
        assert recorder._pages[0]['step_range'] == [0, 4]
        assert recorder._pages[0]['boundary'] == 'checkpoint'

        # Open second page
        recorder._open_new_page(6, 'step_06.png', 'cancel')
        assert recorder._current_page_start == 6

        # Close second page at step 9
        recorder._close_current_page(9, 'end')
        assert len(recorder._pages) == 2
        assert recorder._pages[1]['page_index'] == 1
        assert recorder._pages[1]['step_range'] == [6, 8]

    def test_close_without_open_is_noop(self) -> None:
        """Closing when no page is open does nothing."""
        from agent.recording.recorder import PlaybookRecorder
        from unittest.mock import MagicMock

        vlm = MagicMock()
        recorder = PlaybookRecorder(
            vlm=vlm,
            service='test',
            flow='cancel',
            credentials={},
        )

        recorder._close_current_page(5, 'end')
        assert len(recorder._pages) == 0

    def test_write_manifest(self, tmp_path: Path) -> None:
        """Manifest JSON is written with correct structure."""
        from agent.recording.recorder import PlaybookRecorder
        from unittest.mock import MagicMock

        vlm = MagicMock()
        recorder = PlaybookRecorder(
            vlm=vlm,
            service='netflix',
            flow='cancel',
            credentials={},
        )

        # Simulate two pages
        recorder._open_new_page(0, 'step_00.png', 'sign-in')
        recorder._close_current_page(3, 'checkpoint')
        recorder._open_new_page(4, 'step_04.png', 'cancel')
        recorder._close_current_page(7, 'end')

        recorder._write_manifest(tmp_path, 'https://www.netflix.com/login')

        manifest_path = tmp_path / '_manifest.json'
        assert manifest_path.exists()

        with open(manifest_path) as f:
            manifest = json.load(f)

        assert manifest['service'] == 'netflix'
        assert manifest['flow'] == 'cancel'
        assert manifest['start_url'] == 'https://www.netflix.com/login'
        assert len(manifest['pages']) == 2
        assert manifest['pages'][0]['page_index'] == 0
        assert manifest['pages'][0]['screenshot'] == 'step_00.png'
        assert manifest['pages'][1]['page_index'] == 1
