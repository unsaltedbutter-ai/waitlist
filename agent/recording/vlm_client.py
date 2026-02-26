"""OpenAI-compatible VLM client for playbook recording.

Talks to any OpenAI-compatible vision API (Grok, OpenAI, local vLLM, etc.)
via POST /chat/completions with base64 image content.
"""

from __future__ import annotations

import base64
import io
import json
import logging
import re
import time

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


def _denormalize_bboxes(obj: dict | list, w: int, h: int) -> None:
    """Recursively convert Qwen 0-1000 normalized bboxes to pixels in place.

    Walks the parsed JSON response and converts any 4-element numeric list
    (assumed to be [x1, y1, x2, y2] in Qwen's 0-1000 space) to absolute
    pixel coordinates.
    """
    if isinstance(obj, dict):
        for key in obj:
            val = obj[key]
            if (isinstance(val, list) and len(val) == 4
                    and all(isinstance(v, (int, float)) for v in val)):
                obj[key] = [
                    val[0] * w / 1000,
                    val[1] * h / 1000,
                    val[2] * w / 1000,
                    val[3] * h / 1000,
                ]
            elif isinstance(val, (dict, list)):
                _denormalize_bboxes(val, w, h)
    elif isinstance(obj, list):
        for item in obj:
            if isinstance(item, (dict, list)):
                _denormalize_bboxes(item, w, h)


def _swap_yx_bboxes(obj: dict | list) -> None:
    """Recursively swap [y1, x1, y2, x2] -> [x1, y1, x2, y2] in place.

    Walks the parsed JSON response and swaps indices 0<->1 and 2<->3 in any
    4-element numeric list (assumed to be a bounding box).
    """
    if isinstance(obj, dict):
        for key in obj:
            val = obj[key]
            if (isinstance(val, list) and len(val) == 4
                    and all(isinstance(v, (int, float)) for v in val)):
                obj[key] = [val[1], val[0], val[3], val[2]]
            elif isinstance(val, (dict, list)):
                _swap_yx_bboxes(val)
    elif isinstance(obj, list):
        for item in obj:
            if isinstance(item, (dict, list)):
                _swap_yx_bboxes(item)


class VLMClient:
    """Minimal client for OpenAI-compatible vision APIs.

    Sends base64 screenshots with system/user prompts to /chat/completions
    and parses the JSON response.
    """

    def __init__(
        self,
        base_url: str,
        api_key: str,
        model: str,
        max_tokens: int = 2048,
        temperature: float = 0.0,
        timeout: float = 60.0,
        max_image_width: int | None = None,
        coord_normalize: bool | None = None,
        coord_yx: bool | None = None,
    ) -> None:
        self.base_url = base_url.rstrip('/')
        self.model = model
        self.max_tokens = max_tokens
        self.temperature = temperature

        from agent.config import VLM_MAX_WIDTH, VLM_COORD_NORMALIZE, VLM_COORD_YX
        self._max_image_width = max_image_width if max_image_width is not None else VLM_MAX_WIDTH
        self._normalized_coords = coord_normalize if coord_normalize is not None else VLM_COORD_NORMALIZE
        self._coord_yx = coord_yx if coord_yx is not None else VLM_COORD_YX

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
        user_message: str = '',
    ) -> tuple[dict, float]:
        """Send a screenshot to the VLM and return the parsed JSON response.

        Args:
            screenshot_b64: Base64-encoded PNG screenshot.
            system_prompt: System prompt describing the task.
            user_message: User-role text accompanying the image. If empty,
                a default message including image dimensions is generated.

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
        image_b64, scale_factor, sent_size = self._resize_if_needed(screenshot_b64)

        # Store sent image for debug trace (before building payload)
        self.last_sent_image_b64: str = image_b64

        if not user_message:
            w, h = sent_size
            user_message = (
                f'This screenshot is {w}x{h} pixels. '
                f'Analyze this screenshot and respond with the JSON action.'
            )

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

        t0 = time.monotonic()
        resp = self._client.post('/chat/completions', json=payload)
        self.last_inference_ms = int((time.monotonic() - t0) * 1000)
        if resp.status_code != 200:
            body = resp.text[:500]
            log.error('VLM API error %d: %s', resp.status_code, body)
            raise RuntimeError(f'VLM API {resp.status_code}: {body}')

        data = resp.json()
        raw_text = data['choices'][0]['message']['content']
        log.debug('VLM raw response: %s', raw_text[:500])

        parsed = _extract_json(raw_text)

        # Swap [y,x,y,x] -> [x,y,x,y] before denormalization so that
        # width/height multipliers are applied to the correct indices.
        if self._coord_yx:
            _swap_yx_bboxes(parsed)

        # Convert 0-1000 normalized coords to absolute pixels so callers
        # get consistent pixel coordinates regardless of model.
        if self._normalized_coords:
            w, h = sent_size
            _denormalize_bboxes(parsed, w, h)

        return parsed, scale_factor

    def _resize_if_needed(self, screenshot_b64: str) -> tuple[str, float, tuple[int, int]]:
        """Downscale a base64 PNG to JPEG at _max_image_width if wider.

        Returns (base64_jpeg, scale_factor, (sent_width, sent_height)) where
        scale_factor is original_width / sent_width (1.0 if no resize needed).
        """
        raw = base64.b64decode(screenshot_b64)
        img = Image.open(io.BytesIO(raw))

        scale_factor = 1.0
        if img.width > self._max_image_width:
            scale_factor = img.width / self._max_image_width
            new_size = (self._max_image_width, int(img.height / scale_factor))
            img = img.resize(new_size, Image.LANCZOS)
            log.debug('Resized screenshot %dx%d -> %dx%d (scale_factor=%.3f)',
                       int(new_size[0] * scale_factor), int(new_size[1] * scale_factor),
                       *new_size, scale_factor)

        sent_size = (img.width, img.height)

        # Convert to JPEG (much smaller than PNG for screenshots)
        buf = io.BytesIO()
        img.convert('RGB').save(buf, format='JPEG', quality=85)
        return base64.b64encode(buf.getvalue()).decode('ascii'), scale_factor, sent_size

    def close(self) -> None:
        """Close the underlying HTTP client."""
        self._client.close()

    def __enter__(self) -> VLMClient:
        return self

    def __exit__(self, *args: object) -> None:
        self.close()
