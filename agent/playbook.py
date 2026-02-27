"""Playbook data structures: job context, execution results."""

from __future__ import annotations

from dataclasses import dataclass, field


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
    # credentials keys: email, pass, name, zip, birth, gender

    def resolve_template(self, template: str) -> str:
        """Replace {email}, {pass}, etc. with actual values from credentials."""
        if not template or '{' not in template:
            return template
        result = template
        for key, val in self.credentials.items():
            result = result.replace('{' + key + '}', val)
        return result


# ---------------------------------------------------------------------------
# ExecutionResult
# ---------------------------------------------------------------------------

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
    error_code: str = ''  # structured: 'credential_invalid', 'captcha', ''
    billing_date: str | None = None
    step_results: list[dict] = field(default_factory=list)
    screenshots: list[dict] = field(default_factory=list)  # [{step, timestamp, path}]
