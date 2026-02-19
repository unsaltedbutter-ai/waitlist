"""OpenAI-compatible VLM client for playbook recording.

Talks to any OpenAI-compatible vision API (Grok, OpenAI, local vLLM, etc.)
via POST /v1/chat/completions with base64 image content.
"""

from __future__ import annotations

import json
import logging
import re

import httpx

log = logging.getLogger(__name__)


def _extract_json(raw: str) -> dict:
    """Extract the first JSON object from VLM output.

    VLMs sometimes wrap JSON in markdown code fences or add preamble text.
    Strategies tried in order:
    1. Direct json.loads on the full string
    2. Extract from ```json ... ``` fences
    3. Find first { ... } without nested braces
    4. Find first { ... } with nested braces (balanced brace scan)
    """
    text = raw.strip()

    # Strategy 1: direct parse
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass

    # Strategy 2: markdown code fence
    fence_match = re.search(r"```(?:json)?\s*\n?(.*?)\n?\s*```", text, re.DOTALL)
    if fence_match:
        try:
            return json.loads(fence_match.group(1).strip())
        except json.JSONDecodeError:
            pass

    # Strategy 3: first { ... } without nested braces
    brace_match = re.search(r"\{[^{}]*\}", text, re.DOTALL)
    if brace_match:
        try:
            return json.loads(brace_match.group(0))
        except json.JSONDecodeError:
            pass

    # Strategy 4: balanced brace scan
    depth = 0
    start = -1
    for i, ch in enumerate(text):
        if ch == "{":
            if depth == 0:
                start = i
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0 and start >= 0:
                try:
                    return json.loads(text[start : i + 1])
                except json.JSONDecodeError:
                    start = -1

    raise ValueError(f"Could not extract JSON from VLM output: {text[:200]}")


class VLMClient:
    """Minimal client for OpenAI-compatible vision APIs.

    Sends base64 screenshots with system/user prompts to /v1/chat/completions
    and parses the JSON response.
    """

    def __init__(
        self,
        base_url: str,
        api_key: str,
        model: str,
        max_tokens: int = 2048,
        temperature: float = 0.1,
        timeout: float = 60.0,
    ) -> None:
        self.base_url = base_url.rstrip('/')
        self.model = model
        self.max_tokens = max_tokens
        self.temperature = temperature
        self._client = httpx.Client(
            base_url=self.base_url,
            headers={
                'Authorization': f'Bearer {api_key}',
                'Content-Type': 'application/json',
            },
            timeout=timeout,
        )

    def analyze(
        self,
        screenshot_b64: str,
        system_prompt: str,
        user_message: str = 'Analyze this screenshot and respond with the JSON action.',
    ) -> dict:
        """Send a screenshot to the VLM and return the parsed JSON response.

        Args:
            screenshot_b64: Base64-encoded PNG screenshot.
            system_prompt: System prompt describing the task.
            user_message: User-role text accompanying the image.

        Returns:
            Parsed JSON dict from the VLM response.

        Raises:
            httpx.HTTPStatusError: On non-2xx response.
            ValueError: If JSON cannot be extracted from the response.
        """
        payload = {
            'model': self.model,
            'max_tokens': self.max_tokens,
            'temperature': self.temperature,
            'messages': [
                {'role': 'system', 'content': system_prompt},
                {
                    'role': 'user',
                    'content': [
                        {
                            'type': 'image_url',
                            'image_url': {
                                'url': f'data:image/png;base64,{screenshot_b64}',
                            },
                        },
                        {'type': 'text', 'text': user_message},
                    ],
                },
            ],
        }

        resp = self._client.post('/v1/chat/completions', json=payload)
        resp.raise_for_status()

        data = resp.json()
        raw_text = data['choices'][0]['message']['content']
        log.debug('VLM raw response: %s', raw_text[:500])

        return _extract_json(raw_text)

    def close(self) -> None:
        """Close the underlying HTTP client."""
        self._client.close()

    def __enter__(self) -> VLMClient:
        return self

    def __exit__(self, *args: object) -> None:
        self.close()
