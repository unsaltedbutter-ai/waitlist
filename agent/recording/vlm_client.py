"""OpenAI-compatible VLM client for playbook recording.

Talks to any OpenAI-compatible vision API (Grok, OpenAI, local vLLM, etc.)
via POST /v1/chat/completions with base64 image content.
"""

from __future__ import annotations

import base64
import io
import json
import logging
import re

import httpx
from PIL import Image

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

    # Max pixel width for screenshots sent to the VLM.  Retina captures are
    # typically 3000+ px wide; resizing to 1280 keeps payloads well under API
    # limits while retaining enough detail for UI element recognition.
    MAX_IMAGE_WIDTH = 1280

    def __init__(
        self,
        base_url: str,
        api_key: str,
        model: str,
        max_tokens: int = 2048,
        temperature: float = 0.1,
        timeout: float = 60.0,
    ) -> None:
        # Strip trailing /v1 so we can always append /v1/chat/completions
        self.base_url = base_url.rstrip('/')
        if self.base_url.endswith('/v1'):
            self.base_url = self.base_url[:-3]
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
    ) -> tuple[dict, float]:
        """Send a screenshot to the VLM and return the parsed JSON response.

        Args:
            screenshot_b64: Base64-encoded PNG screenshot.
            system_prompt: System prompt describing the task.
            user_message: User-role text accompanying the image.

        Returns:
            Tuple of (parsed JSON dict, scale_factor). The scale_factor is
            original_width / sent_width. Multiply any pixel coordinates in the
            response by scale_factor to map them back to original image space.
            Returns 1.0 when no resizing occurred.

        Raises:
            httpx.HTTPStatusError: On non-2xx response.
            ValueError: If JSON cannot be extracted from the response.
        """
        # Resize oversized screenshots to stay under API payload limits
        image_b64, scale_factor = self._resize_if_needed(screenshot_b64)

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
                                'url': f'data:image/jpeg;base64,{image_b64}',
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

        return _extract_json(raw_text), scale_factor

    def _resize_if_needed(self, screenshot_b64: str) -> tuple[str, float]:
        """Downscale a base64 PNG to JPEG at MAX_IMAGE_WIDTH if wider.

        Returns (base64_jpeg, scale_factor) where scale_factor is
        original_width / sent_width (1.0 if no resize needed).
        """
        raw = base64.b64decode(screenshot_b64)
        img = Image.open(io.BytesIO(raw))

        scale_factor = 1.0
        if img.width > self.MAX_IMAGE_WIDTH:
            scale_factor = img.width / self.MAX_IMAGE_WIDTH
            new_size = (self.MAX_IMAGE_WIDTH, int(img.height / scale_factor))
            img = img.resize(new_size, Image.LANCZOS)
            log.debug('Resized screenshot %dx%d -> %dx%d (scale_factor=%.3f)',
                       int(new_size[0] * scale_factor), int(new_size[1] * scale_factor),
                       *new_size, scale_factor)

        # Convert to JPEG (much smaller than PNG for screenshots)
        buf = io.BytesIO()
        img.convert('RGB').save(buf, format='JPEG', quality=85)
        return base64.b64encode(buf.getvalue()).decode('ascii'), scale_factor

    def close(self) -> None:
        """Close the underlying HTTP client."""
        self._client.close()

    def __enter__(self) -> VLMClient:
        return self

    def __exit__(self, *args: object) -> None:
        self.close()
