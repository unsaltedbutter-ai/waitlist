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
    from unsaltedbutter_prompts.recording import (  # type: ignore[import-untyped]
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
        'disney': {
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
        'appletv': {
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
    _RESPONSE_SCHEMA = """\
You MUST respond with exactly one JSON object (no markdown fences, no extra text):
{
  "state": "description of what you see on the current page",
  "action": "click | type_text | scroll_down | scroll_up | press_key | wait | done",
  "target_description": "human description of the element to interact with",
  "bounding_box": [x1, y1, x2, y2],
  "text_to_type": "semantic hint like 'the email address' or 'the password' (only for type_text)",
  "key_to_press": "enter | tab | escape (only for press_key, empty string otherwise)",
  "confidence": 0.0,
  "reasoning": "brief explanation of why this action is correct",
  "is_checkpoint": false,
  "checkpoint_prompt": ""
}

Rules:
- bounding_box coordinates are in image pixels (origin top-left)
- For type_text, NEVER include actual credentials. Use semantic descriptions.
- Set is_checkpoint to true when a significant page transition is expected
- Set action to "done" when the current phase is complete
- If you see a CAPTCHA or something unexpected, set state to "need_human"\
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

Context for {service}:
- Sign-in button is typically labeled: {hints['signin_button']}
- Email field is typically labeled: {hints['email_field']}
- Password field is typically labeled: {hints['password_field']}

Page types (pick exactly one):
- "user_pass": Both an email/username INPUT BOX and a password INPUT BOX are visible
- "user_only": Only an email/username INPUT BOX is visible (no password field)
- "pass_only": Only a password INPUT BOX is visible
- "button_only": No input fields visible, but a Sign In / Log In button is present
- "profile_select": "Who's watching?" profile picker.{profile_hint}
- "signed_in": Already signed in
- "spinner": Page is loading
- "email_code_single": Verification code sent to email, ONE text input
- "email_code_multi": Verification code sent to email, MULTIPLE digit inputs
- "phone_code_single": Code sent to phone, ONE text input
- "phone_code_multi": Code sent to phone, MULTIPLE digit inputs
- "email_link": Click a link sent to email (no code input)
- "captcha": A CAPTCHA challenge
- "unknown": None of the above

You MUST respond with exactly one JSON object (no markdown fences, no extra text):
{{
  "page_type": "...",
  "email_box": [x1, y1, x2, y2],
  "password_box": [x1, y1, x2, y2],
  "button_box": [x1, y1, x2, y2],
  "profile_box": [x1, y1, x2, y2],
  "code_boxes": [{{"label": "code_1", "box": [x1, y1, x2, y2]}}, ...],
  "page_description": "brief description (unknown state only)",
  "actions": [
    {{"action": "click|type|dismiss", "target": "description", "box": [x1, y1, x2, y2]}}
  ],
  "confidence": 0.0,
  "reasoning": "brief explanation"
}}

Rules:
- All bounding box coordinates are in image pixels (origin at top-left)
- Set a field to null if not applicable for this page_type
- email_box / password_box MUST target the actual text INPUT BOX, NOT heading text or labels
- button_box: the primary action button (Sign In, Continue, Next, Log In)
- profile_box: the first/main profile avatar or name
- code_boxes: list of individual code input fields, ordered left-to-right
- For signed_in, spinner, email_link, captcha: all boxes and actions null"""

    def build_cancel_prompt(service: str) -> str:
        """Build the cancel phase system prompt."""
        hints = _get_hints(service)
        notes = ''
        if hints.get('notes'):
            notes = f'\nService-specific notes: {hints["notes"]}'

        cancel_labels = hints.get('cancel_button_labels', 'Cancel')

        return f"""\
You are a browser automation assistant helping cancel a {service} subscription.
The user is already signed in. Your job is to navigate the cancel flow.

Context for {service}:
- Cancel page URL (if known): {hints.get('cancel_url', 'unknown')}
- Account page URL: {hints.get('account_url', 'unknown')}
- Common cancel button labels: {cancel_labels}{notes}

Decision tree (check in order):
- Am I on the main browse/home page? -> find and click Account or Settings
- Am I on the account/settings page? -> find the Cancel link and click it
- Am I on a retention offer page? -> find and click "Continue Cancellation"
- Am I on the final confirmation page? -> click "Finish Cancellation", set is_checkpoint to true
- Do I see a cancellation confirmation message? -> action: "done"
- Loading spinner or page transition? -> action: "wait"
- CAPTCHA or something unexpected? -> set state to "need_human"

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
The user is already signed in. Your job is to navigate to the Account page, find the
resume/restart option, and reactivate the subscription.

CRITICAL: Seeing the home/browse page with content does NOT mean the task is done.
You MUST navigate to the Account page to check subscription status and find the resume button.
Do NOT continue through any onboarding, setup, or profile wizards after reactivation.

Context for {service}:
- Account page URL: {hints.get('account_url', 'unknown')}
- Common resume button labels: {resume_labels}
- Target plan: {plan_tier if plan_tier else 'any (no specific tier)'}

Decision tree (check in order, STOP at the first match):
- Am I on the main browse/home page or any page that is NOT the account page? -> navigate to Account.{tier_instruction}
- Am I on the account page showing cancelled/expired status? -> find and click Resume
- Am I on a payment confirmation page? -> confirm the existing payment method, set is_checkpoint to true
- COMPLETION CHECK: Do I see an explicit success message confirming reactivation? -> action: "done"
  * "Welcome back" on a confirmation page (NOT the browse page)
  * "membership restarted"
  * "subscription reactivated"
  * The account page now shows an active plan with a future billing date
  * An onboarding wizard means the resume ALREADY SUCCEEDED. Do NOT click Next. -> action: "done"
- Am I on a promotional/upsell page? -> dismiss it
- Loading spinner or page transition? -> action: "wait"
- CAPTCHA or something unexpected? -> set state to "need_human"

{_RESPONSE_SCHEMA}"""
