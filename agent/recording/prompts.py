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
- CRITICAL: When targeting form fields (email, password), the bounding_box MUST cover the actual text INPUT BOX (the rectangular field with a border where you type text, often containing gray placeholder text like "Email or mobile number"). NEVER target heading text, labels, or instructions above the field.
- For type_text, NEVER include actual credentials. Use semantic descriptions like "the email address" or "the password"
- Set is_checkpoint to true when a significant page transition is expected (login submitted, page navigated, form submitted)
- Set action to "done" when the current phase is complete
- Set action to "wait" ONLY if you see a loading spinner or the page is visibly transitioning
- If the page looks fully loaded but you cannot see the button or element you need, use "scroll_down" (not "wait"). Content below the fold requires scrolling, not waiting.
- If you see a CAPTCHA, 2FA prompt, or something unexpected, set state to "need_human"\
"""


# ---------------------------------------------------------------------------
# Prompt builders
# ---------------------------------------------------------------------------

_SIGNIN_EXAMPLES = """\

Examples of correct responses:

Netflix sign-in page with email and password fields, Sign In button:
{"page_type": "user_pass", "email_box": [440, 280, 840, 320], "password_box": [440, 340, 840, 380], "button_box": [440, 410, 840, 460], "profile_box": null, "code_boxes": null, "page_description": null, "actions": null, "confidence": 0.95, "reasoning": "Two input fields visible: email and password, with Sign In button below"}

Hulu password page with email shown as text, one password field, Log In button:
{"page_type": "pass_only", "email_box": null, "password_box": [360, 310, 680, 350], "button_box": [360, 380, 680, 420], "profile_box": null, "code_boxes": null, "page_description": null, "actions": null, "confidence": 0.92, "reasoning": "Email displayed as static text, only password input box visible"}

Verification page with four individual code digit boxes and Verify button:
{"page_type": "email_code_multi", "email_box": null, "password_box": null, "button_box": [400, 420, 600, 460], "profile_box": null, "code_boxes": [{"label": "code_1", "box": [380, 320, 420, 360]}, {"label": "code_2", "box": [430, 320, 470, 360]}, {"label": "code_3", "box": [480, 320, 520, 360]}, {"label": "code_4", "box": [530, 320, 570, 360]}], "page_description": null, "actions": null, "confidence": 0.90, "reasoning": "Four separate digit input boxes in a row, page asks to enter code sent to email"}

Cookie consent banner covering the sign-in form:
{"page_type": "unknown", "email_box": null, "password_box": null, "button_box": null, "profile_box": null, "code_boxes": null, "page_description": "Cookie consent overlay with Accept and Customize buttons, sign-in form partially visible behind it", "actions": [{"action": "click", "target": "Accept All Cookies button", "box": [500, 520, 700, 560]}], "confidence": 0.85, "reasoning": "Cookie banner is blocking the sign-in form, need to dismiss it first"}"""


def _get_hints(service: str) -> dict[str, str]:
    """Get service hints, falling back to defaults for unknown services."""
    return SERVICE_HINTS.get(service.lower(), _DEFAULT_HINTS)


def build_signin_prompt(service: str) -> str:
    """Build the sign-in phase system prompt.

    Uses page-type classification: the VLM identifies the page layout and
    returns bounding boxes for all visible fields in a single call. The
    recorder then executes the full click-type-tab-enter sequence locally
    without additional VLM round-trips.

    14 page types covering sign-in flows, verification codes (single vs
    multi-input), captchas, and obstacle dismissal (cookie banners, popups).
    """
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
- "user_only": Only an email/username INPUT BOX is visible (no password field), with a Continue/Next button
- "pass_only": Only a password INPUT BOX is visible (email may be shown as text but not editable)
- "button_only": No input fields visible, but a Sign In / Log In / Get Started button is present
- "profile_select": "Who's watching?" profile picker.{profile_hint}
- "signed_in": Already signed in (seeing browse page, dashboard, account page, or content)
- "spinner": Page is loading (spinner, progress bar, or blank/white page after form submission)
- "email_code_single": Page asks for a verification code sent to email, with ONE text input
- "email_code_multi": Page asks for a verification code sent to email, with MULTIPLE individual digit inputs
- "phone_code_single": Page asks for a code sent to phone, with ONE text input
- "phone_code_multi": Page asks for a code sent to phone, with MULTIPLE individual digit inputs
- "email_link": Page asks to click a link sent to email (no code input)
- "captcha": A CAPTCHA challenge (image selection, puzzle, reCAPTCHA)
- "unknown": None of the above (cookie banner, notification popup, age gate, error, or unrecognized page)

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
- All bounding box coordinates are in image pixels (origin at top-left of the screenshot)
- Set a field to null if not applicable for this page_type
- email_box / password_box MUST target the actual text INPUT BOX (rectangular field where you type), NOT heading text or labels
- button_box: the primary action button (Sign In, Continue, Next, Log In, Get Started, Verify)
- profile_box: the first/main profile avatar or name
- code_boxes: list of individual code input fields, ordered left-to-right. Use for email_code_single, email_code_multi, phone_code_single, phone_code_multi only.
- actions: list of steps to proceed past an obstacle. Use for unknown state only. Each action has "click" (button/link), "type" (text input), or "dismiss" (close popup/overlay).
- For signed_in, spinner, email_link, captcha: all boxes and actions null

{_SIGNIN_EXAMPLES}"""


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
- Am I on the main browse/home page, profile selection, or any page that is NOT the account page? -> navigate to Account or Settings. Look for an Account button, gear icon, or user avatar in the top-right corner.{tier_instruction}
- Am I on the account page showing cancelled/expired status? -> find and click the Restart or Resume Membership button
- Am I on a payment confirmation page? -> confirm the existing payment method, set is_checkpoint to true
- COMPLETION CHECK: Do I see an explicit success message confirming reactivation? -> action: "done"
  * "Welcome to {service}" or "Welcome back" on a confirmation page (NOT the browse page)
  * "You've started your membership" or "membership restarted"
  * "Your subscription is active" or "subscription reactivated"
  * The account page now shows an active plan with a future billing date
  * An onboarding wizard (choose devices, create profiles, set preferences, pick languages) means the resume ALREADY SUCCEEDED. Do NOT click Next. -> action: "done"
- Am I on a promotional/upsell page? -> dismiss it (click "No thanks", "Maybe later", "Skip")
- Loading spinner or page transition? -> action: "wait"
- CAPTCHA or something unexpected? -> set state to "need_human"

{_RESPONSE_SCHEMA}"""
