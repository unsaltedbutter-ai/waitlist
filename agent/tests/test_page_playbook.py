"""Tests for agent.page_playbook: PagePlaybook and FlowConfig dataclasses.

Tests load/save/parse of page playbooks and flow configs using temp files.

Run: cd agent && python -m pytest tests/test_page_playbook.py -v
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from agent.page_playbook import FlowConfig, PagePlaybook
from agent.playbook import PlaybookStep


# ---------------------------------------------------------------------------
# PagePlaybook
# ---------------------------------------------------------------------------

class TestPagePlaybook:
    def test_from_file(self, tmp_path: Path) -> None:
        """Load a page playbook from a JSON file."""
        data = {
            'page_id': 'netflix_login',
            'service': 'netflix',
            'flows': ['cancel', 'resume'],
            'actions': [
                {
                    'action': 'type_text',
                    'target_description': 'Email field',
                    'value': '{email}',
                    'ref_region': [380, 200, 620, 230],
                },
                {
                    'action': 'click',
                    'target_description': 'Sign In button',
                    'ref_region': [380, 310, 620, 360],
                },
            ],
            'wait_after_sec': [2, 5],
            'terminal': False,
            'notes': 'Netflix login form',
        }
        path = tmp_path / 'netflix_login.json'
        path.write_text(json.dumps(data))

        pb = PagePlaybook.from_file(path)
        assert pb.page_id == 'netflix_login'
        assert pb.service == 'netflix'
        assert pb.flows == ('cancel', 'resume')
        assert len(pb.actions) == 2
        assert pb.actions[0].action == 'type_text'
        assert pb.actions[0].value == '{email}'
        assert pb.actions[1].action == 'click'
        assert pb.wait_after_sec == (2, 5)
        assert pb.terminal is False
        assert pb.notes == 'Netflix login form'

    def test_from_file_defaults(self, tmp_path: Path) -> None:
        """Missing optional fields get defaults."""
        data = {
            'page_id': 'minimal_page',
            'service': 'example',
            'actions': [],
        }
        path = tmp_path / 'minimal.json'
        path.write_text(json.dumps(data))

        pb = PagePlaybook.from_file(path)
        assert pb.flows == ()
        assert pb.wait_after_sec == (1.0, 2.0)
        assert pb.terminal is False
        assert pb.notes == ''

    def test_terminal_page(self, tmp_path: Path) -> None:
        """Terminal page with no actions."""
        data = {
            'page_id': 'cancel_confirmed',
            'service': 'netflix',
            'flows': ['cancel'],
            'actions': [],
            'terminal': True,
        }
        path = tmp_path / 'cancel_confirmed.json'
        path.write_text(json.dumps(data))

        pb = PagePlaybook.from_file(path)
        assert pb.terminal is True
        assert len(pb.actions) == 0

    def test_to_dict(self) -> None:
        """Serialize to dict and back."""
        pb = PagePlaybook(
            page_id='test_page',
            service='hulu',
            flows=('cancel',),
            actions=(
                PlaybookStep(action='click', target_description='Button'),
            ),
            wait_after_sec=(3.0, 6.0),
            terminal=True,
            notes='Test page',
        )
        d = pb.to_dict()
        assert d['page_id'] == 'test_page'
        assert d['service'] == 'hulu'
        assert d['flows'] == ['cancel']
        assert len(d['actions']) == 1
        assert d['wait_after_sec'] == [3.0, 6.0]
        assert d['terminal'] is True
        assert d['notes'] == 'Test page'

    def test_to_dict_omits_defaults(self) -> None:
        """Default values are omitted from dict."""
        pb = PagePlaybook(
            page_id='p',
            service='s',
            flows=(),
            actions=(),
            wait_after_sec=(1.0, 2.0),
            terminal=False,
            notes='',
        )
        d = pb.to_dict()
        assert 'wait_after_sec' not in d
        assert 'terminal' not in d
        assert 'notes' not in d

    def test_actions_are_playbook_steps(self, tmp_path: Path) -> None:
        """Actions deserialize as PlaybookStep instances."""
        data = {
            'page_id': 'p',
            'service': 's',
            'actions': [
                {'action': 'click', 'target_description': 'X', 'optional': True},
            ],
        }
        path = tmp_path / 'p.json'
        path.write_text(json.dumps(data))
        pb = PagePlaybook.from_file(path)
        assert isinstance(pb.actions[0], PlaybookStep)
        assert pb.actions[0].optional is True

    def test_load_by_id(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        """PagePlaybook.load() finds by page_id in PAGES_DIR."""
        data = {
            'page_id': 'test_load',
            'service': 'example',
            'actions': [],
        }
        (tmp_path / 'test_load.json').write_text(json.dumps(data))
        monkeypatch.setattr('agent.page_playbook.PAGES_DIR', tmp_path)

        pb = PagePlaybook.load('test_load')
        assert pb.page_id == 'test_load'

    def test_load_missing_raises(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        """PagePlaybook.load() raises FileNotFoundError for missing page."""
        monkeypatch.setattr('agent.page_playbook.PAGES_DIR', tmp_path)
        with pytest.raises(FileNotFoundError):
            PagePlaybook.load('nonexistent')


# ---------------------------------------------------------------------------
# FlowConfig
# ---------------------------------------------------------------------------

class TestFlowConfig:
    def test_from_file(self, tmp_path: Path) -> None:
        data = {
            'service': 'netflix',
            'flow': 'cancel',
            'start_url': 'https://www.netflix.com/login',
            'max_pages': 15,
            'version': 2,
        }
        path = tmp_path / 'netflix_cancel.json'
        path.write_text(json.dumps(data))

        fc = FlowConfig.from_file(path)
        assert fc.service == 'netflix'
        assert fc.flow == 'cancel'
        assert fc.start_url == 'https://www.netflix.com/login'
        assert fc.max_pages == 15
        assert fc.version == 2

    def test_from_file_defaults(self, tmp_path: Path) -> None:
        data = {
            'service': 'hulu',
            'flow': 'resume',
            'start_url': 'https://www.hulu.com/account',
        }
        path = tmp_path / 'hulu_resume.json'
        path.write_text(json.dumps(data))

        fc = FlowConfig.from_file(path)
        assert fc.max_pages == 15
        assert fc.version == 1

    def test_to_dict(self) -> None:
        fc = FlowConfig(
            service='disney', flow='cancel',
            start_url='https://www.disneyplus.com/login',
            max_pages=10, version=3,
        )
        d = fc.to_dict()
        assert d == {
            'service': 'disney',
            'flow': 'cancel',
            'start_url': 'https://www.disneyplus.com/login',
            'max_pages': 10,
            'version': 3,
        }

    def test_load(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        data = {
            'service': 'netflix',
            'flow': 'cancel',
            'start_url': 'https://www.netflix.com/login',
        }
        (tmp_path / 'netflix_cancel.json').write_text(json.dumps(data))
        monkeypatch.setattr('agent.page_playbook.FLOWS_DIR', tmp_path)

        fc = FlowConfig.load('netflix', 'cancel')
        assert fc.service == 'netflix'

    def test_load_missing_raises(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr('agent.page_playbook.FLOWS_DIR', tmp_path)
        with pytest.raises(FileNotFoundError):
            FlowConfig.load('nonexistent', 'cancel')
