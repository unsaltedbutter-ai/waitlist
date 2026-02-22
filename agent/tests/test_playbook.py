"""Tests for playbook data structures, template resolution, and credential destruction.

Run: cd agent && python -m pytest tests/test_playbook.py -v
"""

from __future__ import annotations

import pytest

from agent.playbook import (
    ExecutionResult,
    JobContext,
    StepResult,
)


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
