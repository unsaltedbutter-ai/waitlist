"""Tests for prompt construction and password guard.

Run: python -m pytest inference/tests/test_prompts.py -v
"""

from __future__ import annotations

import pytest

from inference.prompts import (
    build_checkpoint_prompt,
    build_find_element_prompt,
    build_infer_action_prompt,
    check_password_guard,
)


# ---------------------------------------------------------------------------
# Password guard
# ---------------------------------------------------------------------------

class TestPasswordGuard:
    """The server must refuse prompts that ask to read password contents."""

    @pytest.mark.parametrize("text", [
        "Read the password field value",
        "What is the password text in this field?",
        "Extract the password from the input",
        "OCR the password field",
        "Show password contents",
        "What's the password on screen?",
        "Reveal password text",
        "What is the PASSWORD TEXT displayed?",
    ])
    def test_blocked_phrases(self, text: str) -> None:
        assert check_password_guard(text) is True

    @pytest.mark.parametrize("text", [
        "Click the password field",
        "Find the password input box",
        "Is there a password field on this page?",
        "The password reset link",
        "Navigate to the change password page",
        "Click the 'forgot password' button",
        "Find the Sign In button",
        "Is the login form visible?",
    ])
    def test_allowed_phrases(self, text: str) -> None:
        assert check_password_guard(text) is False

    def test_case_insensitive(self) -> None:
        assert check_password_guard("READ THE PASSWORD") is True
        assert check_password_guard("read the password") is True
        assert check_password_guard("Read The Password") is True

    def test_empty_string(self) -> None:
        assert check_password_guard("") is False


# ---------------------------------------------------------------------------
# Prompt builders
# ---------------------------------------------------------------------------

class TestBuildFindElementPrompt:
    """Prompt for the find_element endpoint."""

    def test_basic(self) -> None:
        prompt = build_find_element_prompt("Sign In button")
        assert "Sign In button" in prompt
        assert "Find this UI element" in prompt

    def test_with_context(self) -> None:
        prompt = build_find_element_prompt(
            "Cancel Subscription button",
            context="Service: Netflix, Flow: cancel",
        )
        assert "Cancel Subscription button" in prompt
        assert "Netflix" in prompt
        assert "Context:" in prompt

    def test_no_context(self) -> None:
        prompt = build_find_element_prompt("Email input field")
        assert "Context:" not in prompt


class TestBuildCheckpointPrompt:
    """Prompt for the checkpoint endpoint."""

    def test_basic(self) -> None:
        prompt = build_checkpoint_prompt("Is the login page shown?")
        assert "login page" in prompt
        assert "Does the page match" in prompt

    def test_with_context(self) -> None:
        prompt = build_checkpoint_prompt(
            "Is the cancellation confirmed?",
            context="Service: Hulu, Flow: cancel, Step: 5",
        )
        assert "cancellation confirmed" in prompt
        assert "Hulu" in prompt


class TestBuildInferActionPrompt:
    """Prompt for the infer_action endpoint."""

    def test_basic(self) -> None:
        prompt = build_infer_action_prompt()
        assert "action" in prompt.lower()

    def test_with_context(self) -> None:
        prompt = build_infer_action_prompt(
            context="Service: Disney+, Flow: cancel, trying to find the cancel button"
        )
        assert "Disney+" in prompt
        assert "Context:" in prompt
