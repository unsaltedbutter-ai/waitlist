"""Playbook data structures: step definitions, job context, execution results."""

from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from pathlib import Path

from agent.config import PLAYBOOK_DIR, SENSITIVE_VARS


# ---------------------------------------------------------------------------
# PlaybookStep
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class PlaybookStep:
    """Single step in a playbook flow."""

    step: int
    action: str  # navigate, click, type_text, select_plan, select_payment_method,
                 # handle_retention, verify_success, scroll, press_key, wait

    target_description: str = ''
    url: str = ''
    value: str = ''
    sensitive: bool = False
    optional: bool = False

    checkpoint: bool = False
    checkpoint_prompt: str = ''

    may_repeat: bool = False
    max_repeats: int = 3

    wait_after_sec: tuple[float, float] = (1.0, 2.0)

    fallback: str = ''  # 'infer' = full VLM if step can't be resolved
    expected_title_contains: str = ''

    @property
    def is_sensitive(self) -> bool:
        """True if explicitly sensitive or value contains a sensitive template var."""
        if self.sensitive:
            return True
        return any(var in self.value for var in SENSITIVE_VARS)

    @staticmethod
    def from_dict(d: dict) -> PlaybookStep:
        """Create from a JSON-parsed dict. Unknown keys are silently dropped."""
        wait = d.get('wait_after_sec', [1.0, 2.0])
        if isinstance(wait, list):
            wait = tuple(wait)

        return PlaybookStep(
            step=d['step'],
            action=d['action'],
            target_description=d.get('target_description', ''),
            url=d.get('url', ''),
            value=d.get('value', ''),
            sensitive=d.get('sensitive', False),
            optional=d.get('optional', False),
            checkpoint=d.get('checkpoint', False),
            checkpoint_prompt=d.get('checkpoint_prompt', ''),
            may_repeat=d.get('may_repeat', False),
            max_repeats=d.get('max_repeats', 3),
            wait_after_sec=wait,
            fallback=d.get('fallback', ''),
            expected_title_contains=d.get('expected_title_contains', ''),
        )

    def to_dict(self) -> dict:
        """Serialize to a JSON-compatible dict. Omits default-value fields."""
        d: dict = {'step': self.step, 'action': self.action}
        if self.target_description:
            d['target_description'] = self.target_description
        if self.url:
            d['url'] = self.url
        if self.value:
            d['value'] = self.value
        if self.sensitive:
            d['sensitive'] = True
        if self.optional:
            d['optional'] = True
        if self.checkpoint:
            d['checkpoint'] = True
        if self.checkpoint_prompt:
            d['checkpoint_prompt'] = self.checkpoint_prompt
        if self.may_repeat:
            d['may_repeat'] = True
        if self.max_repeats != 3:
            d['max_repeats'] = self.max_repeats
        if self.wait_after_sec != (1.0, 2.0):
            d['wait_after_sec'] = list(self.wait_after_sec)
        if self.fallback:
            d['fallback'] = self.fallback
        if self.expected_title_contains:
            d['expected_title_contains'] = self.expected_title_contains
        return d


# ---------------------------------------------------------------------------
# Playbook
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class Playbook:
    """A complete playbook for a service flow (signup or cancel)."""

    service: str
    flow: str
    version: int
    notes: str
    last_validated: str | None
    steps: tuple[PlaybookStep, ...]

    @staticmethod
    def load(service: str, flow: str) -> Playbook:
        """Load a playbook from agent/playbooks/<service>_<flow>.json."""
        path = PLAYBOOK_DIR / f'{service}_{flow}.json'
        if not path.exists():
            raise FileNotFoundError(f'Playbook not found: {path}')
        return Playbook.from_file(path)

    @staticmethod
    def from_file(path: Path) -> Playbook:
        """Load a playbook from an arbitrary JSON file path."""
        with open(path) as f:
            data = json.load(f)
        return Playbook(
            service=data['service'],
            flow=data['flow'],
            version=data.get('version', 1),
            notes=data.get('notes', ''),
            last_validated=data.get('last_validated'),
            steps=tuple(PlaybookStep.from_dict(s) for s in data['steps']),
        )

    @staticmethod
    def list_all() -> list[dict]:
        """Return metadata for every playbook JSON in the playbooks dir."""
        results = []
        for path in sorted(PLAYBOOK_DIR.glob('*.json')):
            # Skip versioned backups like netflix_signup_v1.json
            stem = path.stem
            parts = stem.rsplit('_', 1)
            if len(parts) == 2 and parts[1].startswith('v') and parts[1][1:].isdigit():
                continue
            try:
                with open(path) as f:
                    data = json.load(f)
                results.append({
                    'service': data.get('service', stem),
                    'flow': data.get('flow', ''),
                    'version': data.get('version', 1),
                    'steps': len(data.get('steps', [])),
                    'last_validated': data.get('last_validated'),
                    'path': str(path),
                })
            except (json.JSONDecodeError, KeyError):
                continue
        return results

    def to_dict(self) -> dict:
        """Serialize to a JSON-compatible dict."""
        return {
            'service': self.service,
            'flow': self.flow,
            'version': self.version,
            'notes': self.notes,
            'last_validated': self.last_validated,
            'steps': [s.to_dict() for s in self.steps],
        }

    def save(self, path: Path | None = None) -> Path:
        """Write the playbook to JSON. Defaults to canonical path."""
        if path is None:
            path = PLAYBOOK_DIR / f'{self.service}_{self.flow}.json'
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, 'w') as f:
            json.dump(self.to_dict(), f, indent=2)
            f.write('\n')
        return path


# ---------------------------------------------------------------------------
# JobContext
# ---------------------------------------------------------------------------

@dataclass
class JobContext:
    """Runtime context for a single playbook execution (signup or cancel job)."""

    job_id: str
    user_id: str
    service: str
    flow: str
    credentials: dict[str, str] = field(default_factory=dict)
    # credentials keys: email, password, card_number, card_expiry, card_cvv
    gift_card_code: str = ''
    billing_zip: str = ''

    def resolve_template(self, template: str) -> str:
        """Replace {user_email}, {user_password}, etc. with actual values."""
        if not template or '{' not in template:
            return template
        replacements = {
            '{user_email}': self.credentials.get('email', ''),
            '{user_password}': self.credentials.get('password', ''),
            '{card_number}': self.credentials.get('card_number', ''),
            '{card_expiry}': self.credentials.get('card_expiry', ''),
            '{card_cvv}': self.credentials.get('card_cvv', ''),
            '{gift_card_code}': self.gift_card_code,
            '{billing_zip}': self.billing_zip,
        }
        result = template
        for key, val in replacements.items():
            result = result.replace(key, val)
        return result

    def destroy(self) -> None:
        """Zero out all credential fields. Call in finally blocks."""
        for key in list(self.credentials.keys()):
            self.credentials[key] = '\x00' * len(self.credentials[key])
        self.credentials.clear()
        if self.gift_card_code:
            self.gift_card_code = '\x00' * len(self.gift_card_code)
        if self.billing_zip:
            self.billing_zip = '\x00' * len(self.billing_zip)


# ---------------------------------------------------------------------------
# StepResult / ExecutionResult
# ---------------------------------------------------------------------------

@dataclass
class StepResult:
    """Outcome of a single playbook step."""

    step: int
    action: str
    success: bool
    duration_seconds: float = 0.0
    inference_calls: int = 0
    error: str = ''
    skipped: bool = False


@dataclass
class ExecutionResult:
    """Outcome of an entire playbook execution. Maps to action_logs schema."""

    job_id: str
    service: str
    flow: str
    success: bool
    duration_seconds: float
    step_count: int
    inference_count: int
    playbook_version: int
    error_message: str = ''
    step_results: list[StepResult] = field(default_factory=list)
    screenshots: list[dict] = field(default_factory=list)  # [{step, timestamp, path}]
