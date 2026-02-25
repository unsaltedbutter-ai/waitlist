"""Composable state machine prompts for VLM-guided playbook recording.

If the unsaltedbutter-prompts package is installed, real prompts are used.
Otherwise, generic example prompts are loaded for development/testing.

Three prompt types that chain together:
- Sign-in prompt (shared across all flows)
- Cancel prompt (after sign-in completes)
- Resume prompt (after sign-in completes)

The VLM never receives actual credentials. It says "type the email address",
and the recorder substitutes locally.
"""

from __future__ import annotations

try:
    from unsaltedbutter_prompts.prompts import (  # type: ignore[import-untyped]
        SERVICE_HINTS,
        build_cancel_prompt,
        build_resume_prompt,
        build_signin_prompt,
    )
except ImportError:
    # ------------------------------------------------------------------
    # Generic stubs: correct interface, no service-specific content.
    # Used when the private unsaltedbutter-prompts package is not installed.
    # ------------------------------------------------------------------

    SERVICE_HINTS: dict[str, dict[str, str]] = {
        'netflix': {
            'login_url': 'https://www.example.com/login',
            'cancel_url': '',
            'account_url': 'https://www.example.com/account',
            'signin_button': 'Sign In',
            'email_field': 'Email',
            'password_field': 'Password',
            'cancel_button_labels': 'Cancel',
            'resume_button_labels': 'Resume',
            'profile_selection': '',
            'notes': '',
        },
        'hulu': {
            'login_url': 'https://www.example.com/login',
            'cancel_url': '',
            'account_url': 'https://www.example.com/account',
            'signin_button': 'Log In',
            'email_field': 'Email',
            'password_field': 'Password',
            'cancel_button_labels': 'Cancel',
            'resume_button_labels': 'Resume',
            'profile_selection': '',
            'notes': '',
        },
        'disney_plus': {
            'login_url': 'https://www.example.com/login',
            'cancel_url': '',
            'account_url': 'https://www.example.com/account',
            'signin_button': 'Log In',
            'email_field': 'Email',
            'password_field': 'Password',
            'cancel_button_labels': 'Cancel',
            'resume_button_labels': 'Resume',
            'profile_selection': '',
            'notes': '',
        },
        'paramount': {
            'login_url': 'https://www.example.com/login',
            'cancel_url': '',
            'account_url': 'https://www.example.com/account',
            'signin_button': 'Sign In',
            'email_field': 'Email',
            'password_field': 'Password',
            'cancel_button_labels': 'Cancel',
            'resume_button_labels': 'Resume',
            'profile_selection': '',
            'notes': '',
        },
        'peacock': {
            'login_url': 'https://www.example.com/login',
            'cancel_url': '',
            'account_url': 'https://www.example.com/account',
            'signin_button': 'Sign In',
            'email_field': 'Email',
            'password_field': 'Password',
            'cancel_button_labels': 'Cancel',
            'resume_button_labels': 'Resume',
            'profile_selection': '',
            'notes': '',
        },
        'max': {
            'login_url': 'https://www.example.com/login',
            'cancel_url': '',
            'account_url': 'https://www.example.com/account',
            'signin_button': 'Sign In',
            'email_field': 'Email',
            'password_field': 'Password',
            'cancel_button_labels': 'Cancel',
            'resume_button_labels': 'Resume',
            'profile_selection': '',
            'notes': '',
        },
    }

    # Fallback for unknown services
    _DEFAULT_HINTS: dict[str, str] = {
        'login_url': '',
        'cancel_url': '',
        'account_url': '',
        'signin_button': 'Sign In',
        'email_field': 'Email',
        'password_field': 'Password',
        'cancel_button_labels': 'Cancel, Cancel Subscription, Cancel Membership',
        'resume_button_labels': 'Resume, Restart, Resubscribe',
        'profile_selection': '',
        'notes': '',
    }

    # JSON response schema (shared across cancel/resume prompts)
    _RESPONSE_SCHEMA = """
"""

    def _get_hints(service: str) -> dict[str, str]:
        """Get service hints, falling back to defaults for unknown services."""
        return SERVICE_HINTS.get(service.lower(), _DEFAULT_HINTS)

    def build_signin_prompt(service: str) -> str:
        """Build the sign-in phase system prompt."""
        hints = _get_hints(service)
        profile_hint = ''
        if hints.get('profile_selection'):
            profile_hint = f' {hints["profile_selection"]}'

        return f"""\
You are a browser automation assistant helping sign in to {service}.

Analyze the screenshot and classify what type of page this is.
"""

    def build_cancel_prompt(service: str) -> str:
        """Build the cancel phase system prompt."""
        hints = _get_hints(service)
        notes = ''
        if hints.get('notes'):
            notes = f'\nService-specific notes: {hints["notes"]}'

        cancel_labels = hints.get('cancel_button_labels', 'Cancel')

        return f"""\
You are a browser automation assistant helping cancel a {service} subscription.

{_RESPONSE_SCHEMA}"""

    def build_resume_prompt(service: str, plan_tier: str) -> str:
        """Build the resume phase system prompt."""
        hints = _get_hints(service)
        resume_labels = hints.get('resume_button_labels', 'Resume, Restart')

        tier_instruction = ''
        if plan_tier:
            tier_instruction = (
                f'\n- Am I on a plan review/confirmation page showing a DIFFERENT plan than '
                f'"{plan_tier}"? -> click "Change" or "Change Plan" to switch plans, '
                f'set is_checkpoint to true'
                f'\n- Am I on a plan selection page? -> click the "{plan_tier}" plan'
            )

        return f"""\

You are a browser automation assistant helping resume a cancelled {service} subscription.

{_RESPONSE_SCHEMA}"""
