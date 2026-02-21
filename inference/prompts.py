"""Prompt templates for VLM inference.

If the unsaltedbutter-prompts package is installed, real prompts are used.
Otherwise, generic example prompts are loaded for development/testing.

Each endpoint (find_element, checkpoint, infer_action) has a system prompt
and a user prompt builder. The VLM is instructed to return structured JSON,
which the response parser converts into typed results.

NEVER ask the VLM to read, describe, or extract password field contents.
The agent handles sensitive fields by only screenshotting them when empty,
but the server enforces this as a second layer of defense.
"""

from __future__ import annotations

try:
    from unsaltedbutter_prompts.inference import (  # type: ignore[import-untyped]
        CHECKPOINT_SYSTEM,
        FIND_ELEMENT_SYSTEM,
        INFER_ACTION_SYSTEM,
        PASSWORD_GUARD_PHRASES,
        build_checkpoint_prompt,
        build_find_element_prompt,
        build_infer_action_prompt,
        check_password_guard,
    )
except ImportError:
    # ------------------------------------------------------------------
    # Generic stubs: correct interface, no service-specific content.
    # Used when the private unsaltedbutter-prompts package is not installed.
    # ------------------------------------------------------------------

    PASSWORD_GUARD_PHRASES = (
        "password text",
        "password value",
        "password content",
        "read the password",
        "extract the password",
        "what is the password",
        "what's the password",
        "type in password",
        "password field value",
        "password field content",
        "password field text",
        "contents of the password",
        "text in the password",
        "value of the password",
        "show password",
        "reveal password",
        "read password",
        "extract password",
        "ocr the password",
        "ocr password",
    )

    def check_password_guard(text: str) -> bool:
        """Return True if the text triggers the password guard (should be rejected).

        This is a best-effort safety layer. The agent is the primary defense
        (it only screenshots empty password fields), but we refuse to process
        prompts that explicitly ask to read password contents.
        """
        lower = text.lower()
        return any(phrase in lower for phrase in PASSWORD_GUARD_PHRASES)

    FIND_ELEMENT_SYSTEM = (
        "You are a visual UI element locator. You receive a screenshot of a browser "
        "window and a description of a UI element to find.\n\n"
        "Your job: locate the described element and return its bounding box as pixel "
        "coordinates within the image.\n\n"
        "Rules:\n"
        '- Return ONLY valid JSON: {"x1": int, "y1": int, "x2": int, "y2": int, "confidence": float}\n'
        "- Coordinates are in image pixels (top-left origin)\n"
        "- x1,y1 is the top-left corner of the bounding box\n"
        "- x2,y2 is the bottom-right corner of the bounding box\n"
        "- confidence is 0.0 to 1.0 (how sure you are this is the right element)\n"
        "- If you cannot find the element, return confidence < 0.3 with your best guess\n"
        "- NEVER read, describe, or extract the contents of password fields\n"
        "- Do not include any text outside the JSON object"
    )

    CHECKPOINT_SYSTEM = (
        "You are a visual page state verifier. You receive a screenshot of a browser "
        "window and a description of what the page should look like.\n\n"
        "Your job: determine whether the current page state matches the expected description.\n\n"
        "Rules:\n"
        '- Return ONLY valid JSON: {"on_track": bool, "confidence": float, "reasoning": string}\n'
        "- on_track: true if the page matches the expected state, false otherwise\n"
        "- confidence: 0.0 to 1.0\n"
        "- reasoning: brief explanation (1-2 sentences) of why the page does or does not match\n"
        "- NEVER read, describe, or extract the contents of password fields\n"
        "- Do not include any text outside the JSON object"
    )

    INFER_ACTION_SYSTEM = (
        "You are a browser automation assistant. You receive a screenshot of a browser "
        "window and context about what the user is trying to accomplish.\n\n"
        "Your job: recommend the next action to take.\n\n"
        "Rules:\n"
        '- Return ONLY valid JSON: {"action": string, "target_x": int, "target_y": int, '
        '"text": string, "confidence": float, "reasoning": string}\n'
        '- action: one of "click", "type_text", "scroll_up", "scroll_down", "press_enter", '
        '"press_tab", "press_escape", "wait"\n'
        "- target_x, target_y: pixel coordinates where the action should happen (for click/type_text)\n"
        "- text: text to type (for type_text actions only, empty string otherwise)\n"
        "- confidence: 0.0 to 1.0\n"
        "- reasoning: brief explanation of why this action is appropriate\n"
        "- NEVER type, read, describe, or extract passwords\n"
        "- NEVER recommend typing into a password field\n"
        "- Do not include any text outside the JSON object"
    )

    def build_find_element_prompt(description: str, context: str = "") -> str:
        """Build the user prompt for find_element requests."""
        parts = [f"Find this UI element in the screenshot: {description}"]
        if context:
            parts.append(f"Context: {context}")
        return "\n".join(parts)

    def build_checkpoint_prompt(prompt: str, context: str = "") -> str:
        """Build the user prompt for checkpoint requests."""
        parts = [f"Does the page match this description? {prompt}"]
        if context:
            parts.append(f"Context: {context}")
        return "\n".join(parts)

    def build_infer_action_prompt(context: str = "") -> str:
        """Build the user prompt for infer_action requests."""
        parts = ["What action should be taken next on this page?"]
        if context:
            parts.append(f"Context: {context}")
        return "\n".join(parts)
