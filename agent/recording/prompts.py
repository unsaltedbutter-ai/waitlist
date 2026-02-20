"""Composable state machine prompts for VLM-guided playbook recording.

Three prompt types that chain together:
- Sign-in prompt (shared across all flows)
- Cancel prompt (after sign-in completes)
- Resume prompt (after sign-in completes)

The VLM never receives actual credentials. It says "type the email address",
and the recorder substitutes locally.
"""

from __future__ import annotations

# ---------------------------------------------------------------------------
# Service-specific hints
# ---------------------------------------------------------------------------

SERVICE_HINTS: dict[str, dict[str, str]] = {
    'netflix': {
        'login_url': 'https://www.netflix.com/login',
        'cancel_url': 'https://www.netflix.com/cancelplan',
        'account_url': 'https://www.netflix.com/account',
        'signin_button': 'Sign In',
        'email_field': 'Email or mobile number',
        'password_field': 'Password',
        'multi_step_login': True,
        'cancel_button_labels': 'Cancel Membership, Continue Cancellation, Finish Cancellation',
        'resume_button_labels': 'Restart Membership, Resume, Rejoin',
        'profile_selection': 'May show profile picker after login. Click the first/main profile.',
        'notes': 'Netflix uses multi-page retention offers during cancel. Click through all of them.',
    },
    'hulu': {
        'login_url': 'https://auth.hulu.com/web/login',
        'cancel_url': '',
        'account_url': 'https://secure.hulu.com/account',
        'signin_button': 'Log In',
        'email_field': 'Email',
        'password_field': 'Password',
        'cancel_button_labels': 'Cancel Subscription, Cancel Plan',
        'resume_button_labels': 'Reactivate, Resume Subscription',
        'profile_selection': '',
        'notes': '',
    },
    'disney': {
        'login_url': 'https://www.disneyplus.com/login',
        'cancel_url': '',
        'account_url': 'https://www.disneyplus.com/account',
        'signin_button': 'Log In',
        'email_field': 'Email',
        'password_field': 'Password',
        'cancel_button_labels': 'Cancel Subscription',
        'resume_button_labels': 'Resubscribe, Restart Subscription',
        'profile_selection': 'May show profile picker (Who is watching?). Click the first profile.',
        'notes': '',
    },
    'paramount': {
        'login_url': 'https://www.paramountplus.com/account/signin/',
        'cancel_url': '',
        'account_url': 'https://www.paramountplus.com/account/',
        'signin_button': 'Sign In',
        'email_field': 'Email',
        'password_field': 'Password',
        'cancel_button_labels': 'Cancel Plan, Cancel Subscription',
        'resume_button_labels': 'Restart Plan, Resubscribe',
        'profile_selection': '',
        'notes': '',
    },
    'peacock': {
        'login_url': 'https://www.peacocktv.com/signin',
        'cancel_url': '',
        'account_url': 'https://www.peacocktv.com/account',
        'signin_button': 'Sign In',
        'email_field': 'Email',
        'password_field': 'Password',
        'cancel_button_labels': 'Cancel Plan',
        'resume_button_labels': 'Reactivate',
        'profile_selection': '',
        'notes': '',
    },
    'appletv': {
        'login_url': 'https://tv.apple.com/',
        'cancel_url': '',
        'account_url': '',
        'signin_button': 'Sign In',
        'email_field': 'Apple ID',
        'password_field': 'Password',
        'cancel_button_labels': 'Cancel Subscription',
        'resume_button_labels': 'Resubscribe',
        'profile_selection': '',
        'notes': 'Apple TV+ cancel may redirect to Apple account settings.',
    },
    'max': {
        'login_url': 'https://play.max.com/sign-in',
        'cancel_url': '',
        'account_url': 'https://play.max.com/account',
        'signin_button': 'Sign In',
        'email_field': 'Email',
        'password_field': 'Password',
        'cancel_button_labels': 'Cancel Subscription',
        'resume_button_labels': 'Restart Subscription, Resubscribe',
        'profile_selection': 'May show profile picker (Who is watching?). Click the first profile.',
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

# ---------------------------------------------------------------------------
# JSON response schema (shared across all prompts)
# ---------------------------------------------------------------------------

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
- IMPORTANT: The screenshot includes the browser tab bar and address bar at the top (~150 pixels). These are NOT part of the web page. Never target anything in the browser chrome area. Only interact with web page content below the address bar.
- CRITICAL: When targeting form fields (email, password), the bounding_box MUST cover the actual text INPUT BOX (the rectangular field with a border where you type text, often containing gray placeholder text like "Email or mobile number"). NEVER target heading text, labels, or instructions above the field.
- For type_text, NEVER include actual credentials. Use semantic descriptions like "the email address" or "the password"
- Set is_checkpoint to true when a significant page transition is expected (login submitted, page navigated, form submitted)
- Set action to "done" when the current phase is complete
- Set action to "wait" if the page is still loading
- If you see a CAPTCHA, 2FA prompt, or something unexpected, set state to "need_human"\
"""


# ---------------------------------------------------------------------------
# Prompt builders
# ---------------------------------------------------------------------------

def _get_hints(service: str) -> dict[str, str]:
    """Get service hints, falling back to defaults for unknown services."""
    return SERVICE_HINTS.get(service.lower(), _DEFAULT_HINTS)


def build_signin_prompt(service: str) -> str:
    """Build the sign-in phase system prompt.

    This prompt guides the VLM through the login flow: finding the sign-in
    form, entering credentials, clicking submit, and handling profile selection.
    Returns "done" when the user is signed in.
    """
    hints = _get_hints(service)
    profile_note = ''
    if hints.get('profile_selection'):
        profile_note = f'\n- Profile selection screen? -> click the first/main profile. {hints["profile_selection"]}'

    return f"""\
You are a browser automation assistant helping sign in to {service}.

Your job is to analyze the screenshot and determine the single best next action.

Context for {service}:
- Sign-in button is typically labeled: {hints['signin_button']}
- Email field is typically labeled: {hints['email_field']}
- Password field is typically labeled: {hints['password_field']}

IMPORTANT: Some services use multi-step login (email on one page, password on a separate page after clicking Continue/Next). Only interact with fields that are ACTUALLY VISIBLE on the current screenshot. Never assume a field exists if you cannot see it.

Decision tree (check in order):
- Am I already signed in (seeing the main browse page, account page, or dashboard)? -> action: "done"
- Am I on a sign-in page with an empty email field? -> click the email text INPUT BOX (the rectangular form field with placeholder text "{hints['email_field']}"). Do NOT click heading text or labels above the input box.
- The email field has text and I can see a password INPUT BOX on the page? -> click the password text INPUT BOX (the rectangular form field with placeholder text "{hints['password_field']}")
- The email field has text but there is NO password field visible, and I see a "Continue" or "Next" button? -> click that button, set is_checkpoint to true
- Both email and password fields have text? -> click the {hints['signin_button']} button, set is_checkpoint to true
- Am I on a "Who is watching?" profile selection screen? -> click the first/main profile{profile_note}
- Page says to check email, tap a link, or use a sign-in link sent via email (passwordless login)? -> set state to "need_human"
- No sign-in form visible but I see a "Sign In" link or button? -> click it
- CAPTCHA, 2FA, phone verification, or something unexpected? -> set state to "need_human"

{_RESPONSE_SCHEMA}"""


def build_cancel_prompt(service: str) -> str:
    """Build the cancel phase system prompt.

    This prompt guides the VLM through the cancellation flow: navigating to
    the cancel page, clicking through retention offers, confirming cancellation.
    Returns "done" when cancellation is confirmed.
    """
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
- Am I on the main browse/home page? -> find and click Account, Settings, or navigate to the cancel page
- Am I on the account/settings page? -> find the Cancel Membership or Cancel Subscription link and click it
- Am I on a retention offer page (offers to change plan, pause, discount)? -> find and click "Continue Cancellation" or the button that rejects the offer and proceeds with cancellation
- Am I on the final confirmation page? -> click "Finish Cancellation" or "Complete Cancellation", set is_checkpoint to true
- Do I see a cancellation confirmation message (your membership will end on date X)? -> action: "done"
- Loading spinner or page transition? -> action: "wait"
- CAPTCHA or something unexpected? -> set state to "need_human"

Important: streaming services aggressively show retention offers. Always look for the less prominent "Continue Cancellation" or "Cancel Anyway" link, often styled smaller or as a text link rather than a button.

{_RESPONSE_SCHEMA}"""


def build_resume_prompt(service: str, plan_tier: str) -> str:
    """Build the resume phase system prompt.

    This prompt guides the VLM through restarting a cancelled subscription:
    navigating to the account page, clicking resume/restart, selecting a plan
    tier if needed, and confirming payment.
    Returns "done" when the subscription is reactivated.
    """
    hints = _get_hints(service)
    resume_labels = hints.get('resume_button_labels', 'Resume, Restart')

    tier_instruction = ''
    if plan_tier:
        tier_instruction = (
            f'\n- Am I on a plan review/confirmation page showing a DIFFERENT plan than '
            f'"{plan_tier}"? -> click "Change" or "Change Plan" to switch plans, '
            f'set is_checkpoint to true'
            f'\n- Am I on a plan selection page (list of available plans)? -> '
            f'click the "{plan_tier}" plan'
        )

    return f"""\
You are a browser automation assistant helping resume a cancelled {service} subscription.
The user is already signed in. Your job is to navigate the resume flow.
The goal is to reactivate the subscription. Once you see a success or welcome message,
the job is DONE. Do NOT continue through any onboarding, setup, or profile wizards.

Context for {service}:
- Account page URL: {hints.get('account_url', 'unknown')}
- Common resume button labels: {resume_labels}
- Target plan: {plan_tier if plan_tier else 'any (no specific tier)'}

Decision tree (check in order, STOP at the first match):
- SUCCESS CHECK (HIGHEST PRIORITY): Do I see any of these success indicators? -> action: "done"
  * "Welcome to {service}" or "Welcome back"
  * "You've started your membership" or "membership restarted"
  * "Your subscription is active" or "subscription reactivated"
  * Any congratulations or success confirmation page
  * An onboarding wizard (choose devices, create profiles, set preferences, pick languages) means the resume ALREADY SUCCEEDED. Do NOT click Next or continue. -> action: "done"
- Am I on the main browse/home page (showing content to watch, not an account page)? -> find and click Account or Settings{tier_instruction}
- Am I on the account page showing cancelled/expired status? -> find and click the Restart or Resume Membership button
- Am I on a payment confirmation page? -> confirm the existing payment method, set is_checkpoint to true
- Loading spinner or page transition? -> action: "wait"
- CAPTCHA or something unexpected? -> set state to "need_human"

{_RESPONSE_SCHEMA}"""
