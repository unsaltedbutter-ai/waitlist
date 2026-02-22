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

    def destroy(self) -> None:
        """Zero out all credential fields. Call in finally blocks."""
        for key in list(self.credentials.keys()):
            self.credentials[key] = '\x00' * len(self.credentials[key])
        self.credentials.clear()


# ---------------------------------------------------------------------------
# StepResult / ExecutionResult
# ---------------------------------------------------------------------------

@dataclass
class StepResult:
    """Outcome of a single playbook step."""

    index: int  # 0-based position in the steps array
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
    billing_date: str | None = None
    step_results: list[StepResult] = field(default_factory=list)
    screenshots: list[dict] = field(default_factory=list)  # [{step, timestamp, path}]
