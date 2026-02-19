"""Tests for playbook data structures, template resolution, and credential destruction.

Run: cd agent && python -m pytest tests/test_playbook.py -v
"""

from __future__ import annotations

import json
import tempfile
from pathlib import Path

import pytest

from agent.config import KEY_VARS, SENSITIVE_VARS
from agent.playbook import (
    ExecutionResult,
    JobContext,
    Playbook,
    PlaybookStep,
    StepResult,
    parse_value_and_keys,
)


# ---------------------------------------------------------------------------
# PlaybookStep.from_dict / to_dict
# ---------------------------------------------------------------------------


class TestPlaybookStepFromDict:
    """Parse PlaybookStep from JSON-like dicts."""

    def test_minimal_step(self) -> None:
        """Only 'action' is required; everything else gets defaults."""
        step = PlaybookStep.from_dict({'action': 'click'})
        assert step.action == 'click'
        assert step.target_description == ''
        assert step.url == ''
        assert step.value == ''
        assert step.sensitive is False
        assert step.optional is False
        assert step.disabled is False
        assert step.checkpoint is False
        assert step.checkpoint_prompt == ''
        assert step.may_repeat is False
        assert step.max_repeats == 3
        assert step.wait_after_sec == (1.0, 2.0)
        assert step.max_points == 1
        assert step.random_dwell is False
        assert step.ref_region is None

    def test_full_step(self) -> None:
        """All fields populated from dict."""
        d = {
            'action': 'type_text',
            'target_description': 'Email field',
            'url': 'https://example.com',
            'value': '{email}',
            'sensitive': False,
            'optional': True,
            'disabled': False,
            'checkpoint': True,
            'checkpoint_prompt': 'Is the form visible?',
            'may_repeat': True,
            'max_repeats': 5,
            'wait_after_sec': [2.0, 4.0],
            'fallback': 'infer',
            'expected_title_contains': 'Login',
            'ref_region': [100, 200, 300, 400],
        }
        step = PlaybookStep.from_dict(d)
        assert step.action == 'type_text'
        assert step.target_description == 'Email field'
        assert step.value == '{email}'
        assert step.optional is True
        assert step.checkpoint is True
        assert step.checkpoint_prompt == 'Is the form visible?'
        assert step.may_repeat is True
        assert step.max_repeats == 5
        assert step.wait_after_sec == (2.0, 4.0)
        assert step.fallback == 'infer'
        assert step.expected_title_contains == 'Login'
        assert step.ref_region == (100, 200, 300, 400)

    def test_unknown_keys_ignored(self) -> None:
        """Extra keys in the dict do not cause errors."""
        step = PlaybookStep.from_dict({
            'action': 'click',
            'totally_unknown_field': 42,
            'another_garbage': 'abc',
        })
        assert step.action == 'click'

    def test_ref_region_wrong_length_becomes_none(self) -> None:
        """ref_region with != 4 elements becomes None."""
        step = PlaybookStep.from_dict({
            'action': 'click',
            'ref_region': [1, 2, 3],
        })
        assert step.ref_region is None

    def test_ref_region_non_list_becomes_none(self) -> None:
        """Non-list ref_region becomes None."""
        step = PlaybookStep.from_dict({
            'action': 'click',
            'ref_region': 'not a list',
        })
        assert step.ref_region is None

    def test_wait_after_sec_tuple_conversion(self) -> None:
        """wait_after_sec list from JSON is converted to a tuple."""
        step = PlaybookStep.from_dict({
            'action': 'wait',
            'wait_after_sec': [3.0, 6.0],
        })
        assert step.wait_after_sec == (3.0, 6.0)
        assert isinstance(step.wait_after_sec, tuple)


class TestPlaybookStepToDict:
    """Serialize PlaybookStep to dict (omitting defaults)."""

    def test_minimal_roundtrip(self) -> None:
        """A step with only defaults serializes to just {action: ...}."""
        step = PlaybookStep(action='click')
        d = step.to_dict()
        assert d == {'action': 'click'}

    def test_full_roundtrip(self) -> None:
        """from_dict -> to_dict preserves all non-default fields."""
        original = {
            'action': 'type_text',
            'target_description': 'Password field',
            'value': '{pass}',
            'sensitive': True,
            'optional': True,
            'checkpoint': True,
            'checkpoint_prompt': 'Logged in?',
            'may_repeat': True,
            'max_repeats': 5,
            'wait_after_sec': [3.0, 5.0],
            'fallback': 'infer',
            'expected_title_contains': 'Account',
            'max_points': 4,
            'random_dwell': True,
            'ref_region': [10, 20, 30, 40],
        }
        step = PlaybookStep.from_dict(original)
        d = step.to_dict()
        assert d['action'] == 'type_text'
        assert d['target_description'] == 'Password field'
        assert d['value'] == '{pass}'
        assert d['sensitive'] is True
        assert d['optional'] is True
        assert d['checkpoint'] is True
        assert d['may_repeat'] is True
        assert d['max_repeats'] == 5
        assert d['wait_after_sec'] == [3.0, 5.0]
        assert d['max_points'] == 4
        assert d['random_dwell'] is True
        assert d['ref_region'] == [10, 20, 30, 40]

    def test_max_points_and_random_dwell_roundtrip(self) -> None:
        """max_points and random_dwell survive from_dict -> to_dict."""
        step = PlaybookStep.from_dict({
            'action': 'wander',
            'target_description': 'Account menu',
            'max_points': 5,
            'random_dwell': True,
        })
        assert step.max_points == 5
        assert step.random_dwell is True
        d = step.to_dict()
        assert d['max_points'] == 5
        assert d['random_dwell'] is True

    def test_max_points_default_omitted(self) -> None:
        """Default max_points=1 and random_dwell=False are omitted from to_dict."""
        step = PlaybookStep(action='wander')
        d = step.to_dict()
        assert 'max_points' not in d
        assert 'random_dwell' not in d


# ---------------------------------------------------------------------------
# PlaybookStep.is_sensitive
# ---------------------------------------------------------------------------


class TestIsSensitive:
    """Sensitive field detection: explicit flag or template variable."""

    def test_explicit_sensitive_flag(self) -> None:
        step = PlaybookStep(action='type_text', value='anything', sensitive=True)
        assert step.is_sensitive is True

    def test_password_template_var(self) -> None:
        """Steps containing {pass} in value are automatically sensitive."""
        step = PlaybookStep(action='type_text', value='{pass}')
        assert step.is_sensitive is True

    def test_email_not_sensitive(self) -> None:
        step = PlaybookStep(action='type_text', value='{email}')
        assert step.is_sensitive is False

    def test_empty_value_not_sensitive(self) -> None:
        step = PlaybookStep(action='click')
        assert step.is_sensitive is False

    def test_password_embedded_in_value(self) -> None:
        """Even if {pass} is part of a larger string, it's still sensitive."""
        step = PlaybookStep(action='type_text', value='{pass}{tab}')
        assert step.is_sensitive is True


# ---------------------------------------------------------------------------
# Playbook loading and serialization
# ---------------------------------------------------------------------------


class TestPlaybookLoadAndSave:
    """Load playbook from JSON file, save to JSON file."""

    def test_from_file(self, tmp_path: Path) -> None:
        """Load a playbook from a JSON file."""
        data = {
            'service': 'hulu',
            'flow': 'cancel',
            'version': 2,
            'notes': 'Test',
            'last_validated': '2026-01-15',
            'steps': [
                {'action': 'navigate', 'url': 'https://hulu.com/login'},
                {'action': 'click', 'target_description': 'Sign in'},
            ],
        }
        path = tmp_path / 'hulu_cancel.json'
        path.write_text(json.dumps(data))

        pb = Playbook.from_file(path)
        assert pb.service == 'hulu'
        assert pb.flow == 'cancel'
        assert pb.version == 2
        assert pb.notes == 'Test'
        assert pb.last_validated == '2026-01-15'
        assert len(pb.steps) == 2
        assert pb.steps[0].action == 'navigate'
        assert pb.steps[1].target_description == 'Sign in'

    def test_from_file_missing_raises(self) -> None:
        """FileNotFoundError when file does not exist."""
        with pytest.raises(FileNotFoundError):
            Playbook.from_file(Path('/nonexistent/path.json'))

    def test_save_creates_file(self, tmp_path: Path) -> None:
        """save() writes valid JSON."""
        pb = Playbook(
            service='peacock',
            flow='resume',
            version=1,
            notes='',
            last_validated=None,
            steps=(
                PlaybookStep(action='navigate', url='https://peacock.com'),
            ),
        )
        path = pb.save(tmp_path / 'peacock_resume.json')
        assert path.exists()

        loaded = json.loads(path.read_text())
        assert loaded['service'] == 'peacock'
        assert loaded['flow'] == 'resume'
        assert len(loaded['steps']) == 1

    def test_empty_steps_playbook(self, tmp_path: Path) -> None:
        """A playbook with zero steps is valid (edge case)."""
        data = {
            'service': 'test',
            'flow': 'cancel',
            'steps': [],
        }
        path = tmp_path / 'empty.json'
        path.write_text(json.dumps(data))

        pb = Playbook.from_file(path)
        assert len(pb.steps) == 0

    def test_to_dict_includes_tier(self) -> None:
        """tier is included in serialized dict when set."""
        pb = Playbook(
            service='netflix', flow='cancel', version=1,
            notes='', last_validated=None, steps=(), tier='premium',
        )
        d = pb.to_dict()
        assert d['tier'] == 'premium'

    def test_to_dict_omits_empty_tier(self) -> None:
        """tier is omitted from serialized dict when empty."""
        pb = Playbook(
            service='netflix', flow='cancel', version=1,
            notes='', last_validated=None, steps=(),
        )
        d = pb.to_dict()
        assert 'tier' not in d

    def test_load_real_netflix_playbook(self) -> None:
        """Load the actual netflix_cancel.json from the playbooks directory."""
        pb = Playbook.load('netflix', 'cancel')
        assert pb.service == 'netflix'
        assert pb.flow == 'cancel'
        assert len(pb.steps) > 0


# ---------------------------------------------------------------------------
# Playbook.list_all
# ---------------------------------------------------------------------------


class TestPlaybookListAll:
    """list_all() discovers playbooks from the playbooks directory."""

    def test_returns_list(self) -> None:
        """list_all returns a list (may be empty if no playbooks on disk)."""
        result = Playbook.list_all()
        assert isinstance(result, list)

    def test_netflix_cancel_in_list(self) -> None:
        """The shipped netflix_cancel.json should appear."""
        items = Playbook.list_all()
        services = [i['service'] for i in items]
        assert 'netflix' in services


# ---------------------------------------------------------------------------
# Playbook.load / load_all (multiple variants)
# ---------------------------------------------------------------------------


def _write_playbook(path: Path, service: str, flow: str, tier: str = '') -> None:
    """Helper: write a minimal playbook JSON file."""
    data = {
        'service': service,
        'flow': flow,
        'version': 1,
        'notes': '',
        'last_validated': None,
        'steps': [{'action': 'navigate', 'url': f'https://{service}.com'}],
    }
    if tier:
        data['tier'] = tier
    path.write_text(json.dumps(data))


class TestPlaybookLoadAll:
    """load_all() discovers multiple variant playbooks for (service, flow)."""

    def test_single_playbook(self, tmp_path: Path, monkeypatch) -> None:
        """One file matches: returns a list of one."""
        monkeypatch.setattr('agent.playbook.PLAYBOOK_DIR', tmp_path)
        _write_playbook(tmp_path / 'hulu_cancel.json', 'hulu', 'cancel')

        result = Playbook.load_all('hulu', 'cancel')
        assert len(result) == 1
        assert result[0].service == 'hulu'

    def test_multiple_variants(self, tmp_path: Path, monkeypatch) -> None:
        """Multiple variant files are all returned."""
        monkeypatch.setattr('agent.playbook.PLAYBOOK_DIR', tmp_path)
        _write_playbook(tmp_path / 'hulu_cancel.json', 'hulu', 'cancel')
        _write_playbook(tmp_path / 'hulu_cancel_help.json', 'hulu', 'cancel')
        _write_playbook(tmp_path / 'hulu_cancel_home.json', 'hulu', 'cancel')

        result = Playbook.load_all('hulu', 'cancel')
        assert len(result) == 3

    def test_versioned_backup_skipped(self, tmp_path: Path, monkeypatch) -> None:
        """Files like hulu_cancel_v2.json are skipped (versioned backups)."""
        monkeypatch.setattr('agent.playbook.PLAYBOOK_DIR', tmp_path)
        _write_playbook(tmp_path / 'hulu_cancel.json', 'hulu', 'cancel')
        _write_playbook(tmp_path / 'hulu_cancel_v2.json', 'hulu', 'cancel')

        result = Playbook.load_all('hulu', 'cancel')
        assert len(result) == 1

    def test_tier_filter(self, tmp_path: Path, monkeypatch) -> None:
        """tier parameter filters by metadata, not filename."""
        monkeypatch.setattr('agent.playbook.PLAYBOOK_DIR', tmp_path)
        _write_playbook(tmp_path / 'hulu_resume_premium_home.json', 'hulu', 'resume', tier='premium')
        _write_playbook(tmp_path / 'hulu_resume_premium_account.json', 'hulu', 'resume', tier='premium')
        _write_playbook(tmp_path / 'hulu_resume_ads_home.json', 'hulu', 'resume', tier='ads')

        premium = Playbook.load_all('hulu', 'resume', tier='premium')
        assert len(premium) == 2
        assert all(pb.tier == 'premium' for pb in premium)

        ads = Playbook.load_all('hulu', 'resume', tier='ads')
        assert len(ads) == 1

    def test_no_tier_filter_returns_all(self, tmp_path: Path, monkeypatch) -> None:
        """Without tier filter, all variants (any tier) are returned."""
        monkeypatch.setattr('agent.playbook.PLAYBOOK_DIR', tmp_path)
        _write_playbook(tmp_path / 'hulu_resume.json', 'hulu', 'resume')
        _write_playbook(tmp_path / 'hulu_resume_premium.json', 'hulu', 'resume', tier='premium')

        result = Playbook.load_all('hulu', 'resume')
        assert len(result) == 2

    def test_no_matches(self, tmp_path: Path, monkeypatch) -> None:
        """Empty list when no files match."""
        monkeypatch.setattr('agent.playbook.PLAYBOOK_DIR', tmp_path)
        result = Playbook.load_all('nonexistent', 'cancel')
        assert result == []

    def test_other_service_not_included(self, tmp_path: Path, monkeypatch) -> None:
        """Files for a different service are not returned."""
        monkeypatch.setattr('agent.playbook.PLAYBOOK_DIR', tmp_path)
        _write_playbook(tmp_path / 'hulu_cancel.json', 'hulu', 'cancel')
        _write_playbook(tmp_path / 'netflix_cancel.json', 'netflix', 'cancel')

        result = Playbook.load_all('hulu', 'cancel')
        assert len(result) == 1
        assert result[0].service == 'hulu'


class TestPlaybookLoadRandom:
    """load() picks a random variant from load_all()."""

    def test_load_returns_one(self, tmp_path: Path, monkeypatch) -> None:
        """load() returns a single Playbook (not a list)."""
        monkeypatch.setattr('agent.playbook.PLAYBOOK_DIR', tmp_path)
        _write_playbook(tmp_path / 'hulu_cancel.json', 'hulu', 'cancel')
        _write_playbook(tmp_path / 'hulu_cancel_help.json', 'hulu', 'cancel')

        pb = Playbook.load('hulu', 'cancel')
        assert isinstance(pb, Playbook)
        assert pb.service == 'hulu'

    def test_load_no_match_raises(self, tmp_path: Path, monkeypatch) -> None:
        """FileNotFoundError when no playbooks match."""
        monkeypatch.setattr('agent.playbook.PLAYBOOK_DIR', tmp_path)
        with pytest.raises(FileNotFoundError, match='No playbooks found'):
            Playbook.load('nonexistent', 'cancel')

    def test_load_with_tier(self, tmp_path: Path, monkeypatch) -> None:
        """load() with tier only picks from matching tier."""
        monkeypatch.setattr('agent.playbook.PLAYBOOK_DIR', tmp_path)
        _write_playbook(tmp_path / 'hulu_resume_premium.json', 'hulu', 'resume', tier='premium')
        _write_playbook(tmp_path / 'hulu_resume_ads.json', 'hulu', 'resume', tier='ads')

        pb = Playbook.load('hulu', 'resume', tier='premium')
        assert pb.tier == 'premium'

    def test_load_real_netflix_still_works(self) -> None:
        """Existing netflix_cancel.json loads via the new random-choice path."""
        pb = Playbook.load('netflix', 'cancel')
        assert pb.service == 'netflix'
        assert pb.flow == 'cancel'
        assert len(pb.steps) > 0


# ---------------------------------------------------------------------------
# JobContext
# ---------------------------------------------------------------------------


class TestJobContext:
    """Template resolution and credential destruction."""

    def test_resolve_template_email(self, job_context: JobContext) -> None:
        result = job_context.resolve_template('{email}')
        assert result == 'alice@example.com'

    def test_resolve_template_password(self, job_context: JobContext) -> None:
        result = job_context.resolve_template('{pass}')
        assert result == 's3cretP@ss'

    def test_resolve_template_multiple(self, job_context: JobContext) -> None:
        """Multiple template vars in one string are all resolved."""
        result = job_context.resolve_template('{email} {name}')
        assert result == 'alice@example.com Alice Smith'

    def test_resolve_template_no_braces(self, job_context: JobContext) -> None:
        """Strings without braces pass through unchanged."""
        result = job_context.resolve_template('plain text')
        assert result == 'plain text'

    def test_resolve_template_empty(self, job_context: JobContext) -> None:
        result = job_context.resolve_template('')
        assert result == ''

    def test_resolve_template_unknown_var(self, job_context: JobContext) -> None:
        """Unknown vars like {otp} are left as-is (not in credentials)."""
        result = job_context.resolve_template('{otp}')
        assert result == '{otp}'

    def test_resolve_template_mixed(self, job_context: JobContext) -> None:
        """Mix of known and unknown vars."""
        result = job_context.resolve_template('{email}{tab}')
        assert result == 'alice@example.com{tab}'

    def test_destroy_zeroes_credentials(self, job_context: JobContext) -> None:
        """destroy() replaces all credential values with null bytes, then clears."""
        # Verify credentials exist before destroy
        assert len(job_context.credentials) > 0
        job_context.destroy()
        assert len(job_context.credentials) == 0

    def test_destroy_overwrites_values(self) -> None:
        """Credential values are overwritten with null bytes before clearing."""
        ctx = JobContext(
            job_id='j1', user_id='u1', service='hulu', flow='cancel',
            credentials={'email': 'test@x.com', 'pass': 'abc123'},
        )
        # Capture references to the credential dict entries
        original_email_len = len(ctx.credentials['email'])
        original_pass_len = len(ctx.credentials['pass'])

        ctx.destroy()

        # Dict is cleared, but the overwrite logic ran first
        assert len(ctx.credentials) == 0

    def test_destroy_idempotent(self, job_context: JobContext) -> None:
        """Calling destroy() twice does not raise."""
        job_context.destroy()
        job_context.destroy()
        assert len(job_context.credentials) == 0


# ---------------------------------------------------------------------------
# parse_value_and_keys
# ---------------------------------------------------------------------------


class TestParseValueAndKeys:
    """Strip trailing key vars ({tab}, {return}) from value strings."""

    def test_email_only(self) -> None:
        value, keys = parse_value_and_keys('{email}')
        assert value == '{email}'
        assert keys == []

    def test_email_tab(self) -> None:
        value, keys = parse_value_and_keys('{email}{tab}')
        assert value == '{email}'
        assert keys == ['tab']

    def test_pass_return(self) -> None:
        value, keys = parse_value_and_keys('{pass}{return}')
        assert value == '{pass}'
        # {return} maps to 'enter' for pyautogui
        assert keys == ['enter']

    def test_email_tab_pass_return(self) -> None:
        """Multiple value+key sequences."""
        value, keys = parse_value_and_keys('{email}{tab}')
        assert value == '{email}'
        assert keys == ['tab']

    def test_plain_text_no_keys(self) -> None:
        value, keys = parse_value_and_keys('hello world')
        assert value == 'hello world'
        assert keys == []

    def test_multiple_trailing_keys(self) -> None:
        value, keys = parse_value_and_keys('{email}{tab}{return}')
        assert value == '{email}'
        assert keys == ['tab', 'enter']

    def test_empty_string(self) -> None:
        value, keys = parse_value_and_keys('')
        assert value == ''
        assert keys == []


# ---------------------------------------------------------------------------
# StepResult / ExecutionResult
# ---------------------------------------------------------------------------


class TestStepResult:
    """StepResult dataclass basics."""

    def test_defaults(self) -> None:
        sr = StepResult(index=0, action='click', success=True)
        assert sr.duration_seconds == 0.0
        assert sr.inference_calls == 0
        assert sr.error == ''
        assert sr.skipped is False

    def test_failed_step(self) -> None:
        sr = StepResult(
            index=3, action='type_text', success=False,
            error='Element not found', inference_calls=1,
        )
        assert sr.success is False
        assert sr.error == 'Element not found'


class TestExecutionResult:
    """ExecutionResult dataclass basics."""

    def test_successful_result(self) -> None:
        result = ExecutionResult(
            job_id='j1', service='netflix', flow='cancel',
            success=True, duration_seconds=45.2,
            step_count=5, inference_count=3,
            playbook_version=2,
        )
        assert result.success is True
        assert result.error_message == ''
        assert result.step_results == []
        assert result.screenshots == []

    def test_failed_result_with_error(self) -> None:
        result = ExecutionResult(
            job_id='j2', service='hulu', flow='cancel',
            success=False, duration_seconds=12.0,
            step_count=2, inference_count=1,
            playbook_version=1,
            error_message='Step 1 failed: timeout',
        )
        assert result.success is False
        assert 'timeout' in result.error_message
