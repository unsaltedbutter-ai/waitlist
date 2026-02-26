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

    SERVICE_HINTS: dict[str, dict[str, dict[str, str]]] = {
        'netflix': {
            'signin': {
                'login_url': 'https://www.example.com/login',
                'button': 'Sign In',
                'email_field': 'Email',
                'password_field': 'Password',
                'profile_selection': '',
                'notes': '',
            },
            'cancel': {
                'button_labels': 'Cancel',
                'notes': '',
            },
            'resume': {
                'button_labels': 'Resume',
                'notes': '',
            },
        },
        'hulu': {
            'signin': {
                'login_url': 'https://www.example.com/login',
                'button': 'Log In',
                'email_field': 'Email',
                'password_field': 'Password',
                'profile_selection': '',
                'notes': '',
            },
            'cancel': {
                'button_labels': 'Cancel',
                'notes': '',
            },
            'resume': {
                'button_labels': 'Resume',
                'notes': '',
            },
        },
        'disney_plus': {
            'signin': {
                'login_url': 'https://www.example.com/login',
                'button': 'Log In',
                'email_field': 'Email',
                'password_field': 'Password',
                'profile_selection': '',
                'notes': '',
            },
            'cancel': {
                'button_labels': 'Cancel',
                'notes': '',
            },
            'resume': {
                'button_labels': 'Resume',
                'notes': '',
            },
        },
        'paramount': {
            'signin': {
                'login_url': 'https://www.example.com/login',
                'button': 'Sign In',
                'email_field': 'Email',
                'password_field': 'Password',
                'profile_selection': '',
                'notes': '',
            },
            'cancel': {
                'button_labels': 'Cancel',
                'notes': '',
            },
            'resume': {
                'button_labels': 'Resume',
                'notes': '',
            },
        },
        'peacock': {
            'signin': {
                'login_url': 'https://www.example.com/login',
                'button': 'Sign In',
                'email_field': 'Email',
                'password_field': 'Password',
                'profile_selection': '',
                'notes': '',
            },
            'cancel': {
                'button_labels': 'Cancel',
                'notes': '',
            },
            'resume': {
                'button_labels': 'Resume',
                'notes': '',
            },
        },
        'max': {
            'signin': {
                'login_url': 'https://www.example.com/login',
                'button': 'Sign In',
                'email_field': 'Email',
                'password_field': 'Password',
                'profile_selection': '',
                'notes': '',
            },
            'cancel': {
                'button_labels': 'Cancel',
                'notes': '',
            },
            'resume': {
                'button_labels': 'Resume',
                'notes': '',
            },
        },
    }

    # Fallback for unknown services
    _DEFAULT_HINTS: dict[str, dict[str, str]] = {
        'signin': {
            'login_url': '',
            'button': 'Sign In',
            'email_field': 'Email',
            'password_field': 'Password',
            'profile_selection': '',
            'notes': '',
        },
        'cancel': {
            'button_labels': 'Cancel, Cancel Subscription, Cancel Membership',
            'notes': '',
        },
        'resume': {
            'button_labels': 'Resume, Restart, Resubscribe',
            'notes': '',
        },
    }

    # JSON response schema (shared across cancel/resume prompts)
    _RESPONSE_SCHEMA = """
"""

    def _get_hints(service: str) -> dict[str, dict[str, str]]:
        """Get service hints, falling back to defaults for unknown services."""
        return SERVICE_HINTS.get(service.lower(), _DEFAULT_HINTS)

    def build_signin_prompt(service: str) -> str:
        """Build the sign-in phase system prompt."""
        s = _get_hints(service)['signin']
        return f"""\
You are an automation assistant helping sign in to {service}.

Analyze the screenshot and classify what type of page this is.
"""

    def build_cancel_prompt(service: str) -> str:
        """Build the cancel phase system prompt."""
        c = _get_hints(service)['cancel']
        return f"""\
You are an automation assistant helping cancel a {service} subscription.

{_RESPONSE_SCHEMA}"""

    def build_resume_prompt(service: str, plan_tier: str) -> str:
        """Build the resume phase system prompt."""
        r = _get_hints(service)['resume']
        return f"""\
You are an automation assistant helping resume a cancelled {service} subscription.

{_RESPONSE_SCHEMA}"""
