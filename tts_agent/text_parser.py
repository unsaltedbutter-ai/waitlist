"""
Parse tweet body from raw Cmd+A clipboard dump using an LLM.

Sends the clipboard text to the VLM (Qwen on Mac Studio, already running
on port 8080) with a prompt to extract just the post body. This is more
robust than regex/heuristic parsing because X.com's layout changes
frequently.

The VLM is used as a text-only LLM here (no vision needed), so inference
is fast and cheap.
"""

from __future__ import annotations

import json
import logging

import httpx

log = logging.getLogger(__name__)

# Default VLM endpoint (Qwen on Mac Studio)
DEFAULT_VLM_URL = "http://localhost:8080"

EXTRACTION_PROMPT = """Extract the main post/tweet text from this X.com page content that was copied via Cmd+A.

Rules:
- Start with the first line of the post body (skip the author name, handle, and "Conversation" header)
- End with the post's timestamp (e.g. "7:32 AM · Feb 28, 2026"). Include the timestamp as the last line.
- Do NOT include the author's name, handle, or display name
- Do NOT include reply counts, retweet counts, like counts, view counts, or "Relevant" labels
- Do NOT include "Show more", "Read more", "View quotes", navigation elements, or sidebar content
- Do NOT include replies, quoted tweets, "Relevant people" bios, or trending topics
- Do NOT include any "Translate post" links or accessibility text
- If the post contains multiple paragraphs, preserve them with blank lines between
- If you cannot find a clear post body, return exactly: EXTRACTION_FAILED

Example input (abbreviated):
---
Post
See new posts
Conversation
Jane Doe
@janedoe
This is the actual post text.

It has multiple paragraphs.
7:32 AM · Feb 28, 2026
·
283.9K Views
Relevant people
Jane Doe @janedoe Some bio text...
---

Example output:
---
This is the actual post text.

It has multiple paragraphs.

7:32 AM · Feb 28, 2026
---

Now extract from this page content:
---
{clipboard_text}
---

Post body text:"""

# Maximum clipboard text to send to VLM (avoid overwhelming the context)
MAX_CLIPBOARD_CHARS = 100_000


async def extract_post_text(
    clipboard_text: str,
    vlm_url: str = DEFAULT_VLM_URL,
    vlm_model: str = "qwen",
) -> str | None:
    """Send clipboard dump to VLM, return extracted post body or None.

    Returns None if:
    - VLM returns EXTRACTION_FAILED
    - VLM request fails
    - Extracted text is empty or suspiciously short (<10 chars)
    """
    if not clipboard_text.strip():
        return None

    # Truncate if clipboard is too large
    truncated = clipboard_text[:MAX_CLIPBOARD_CHARS]

    prompt = EXTRACTION_PROMPT.format(clipboard_text=truncated)

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(
                f"{vlm_url}/v1/chat/completions",
                json={
                    "model": vlm_model,
                    "messages": [{"role": "user", "content": prompt}],
                    "temperature": 0.1,
                    "max_tokens": 16384,
                },
            )
            resp.raise_for_status()
            data = resp.json()

        text = data["choices"][0]["message"]["content"].strip()

        if text == "EXTRACTION_FAILED" or not text:
            log.warning("VLM extraction failed or returned empty")
            return None

        if len(text) < 10:
            log.warning("VLM extraction suspiciously short: %d chars", len(text))
            return None

        log.info("VLM extracted %d characters from %d char clipboard", len(text), len(clipboard_text))
        return text

    except Exception:
        log.exception("VLM extraction request failed")
        return None


def extract_author_info(clipboard_text: str) -> tuple[str | None, str | None]:
    """Extract the display name and @handle of the post author.

    Returns (display_name, handle) tuple. Either or both may be None.

    X.com Cmd+A clipboard layout after "Conversation":
        Display Name [emoji...]
        @handle
        Post body starts here...

    The display name is the line immediately before the @handle line.
    Emojis are stripped from the display name (TTS would read them oddly).
    """
    import re
    import unicodedata

    handle: str | None = None
    display_name: str | None = None

    # Try to find @handle right after "Conversation" header
    # The clipboard layout is: "Conversation\nDisplayName\n@handle\nPost body..."
    conv_match = re.search(r"Conversation\s*\n(.{0,500})", clipboard_text, re.DOTALL)
    section = conv_match.group(1) if conv_match else clipboard_text[:500]

    lines = section.split("\n")
    for i, line in enumerate(lines):
        stripped = line.strip()
        handle_match = re.match(r"^@([A-Za-z0-9_]{1,15})$", stripped)
        if handle_match:
            handle = f"@{handle_match.group(1)}"
            # Display name is the line before the @handle
            if i > 0:
                raw_name = lines[i - 1].strip()
                # Strip emoji and other non-letter/space/punctuation chars
                cleaned = ""
                for ch in raw_name:
                    cat = unicodedata.category(ch)
                    # Keep letters, digits, spaces, punctuation (not symbols/emojis)
                    if cat.startswith(("L", "N", "Z", "P")):
                        cleaned += ch
                cleaned = cleaned.strip()
                if cleaned:
                    display_name = cleaned
            break

    # Fallback for handle if "Conversation" pattern didn't match
    if not handle:
        head = clipboard_text[:500]
        matches = re.findall(r"@([A-Za-z0-9_]{1,15})", head)
        if matches:
            handle = f"@{matches[0]}"

    return display_name, handle


def _parse_tweet_timestamp(post_body: str) -> tuple[str, str | None]:
    """Extract and remove the timestamp from the end of the post body.

    X.com timestamps look like: "7:32 AM · Feb 28, 2026"
    The VLM includes this as the last line of the extracted text.

    Returns (body_without_timestamp, formatted_timestamp_or_None).
    The formatted timestamp is TTS-friendly: "On February 28th, 2026 at 7:32 AM"
    """
    import re
    from datetime import datetime

    # Match timestamp pattern at end of text
    # e.g. "7:32 AM · Feb 28, 2026" or "11:05 PM · Jan 3, 2025"
    ts_pattern = r"\n?\s*(\d{1,2}:\d{2}\s*[AP]M)\s*[·]\s*([A-Z][a-z]{2}\s+\d{1,2},\s*\d{4})\s*$"
    match = re.search(ts_pattern, post_body)

    if not match:
        return post_body, None

    time_str = match.group(1).strip()
    date_str = match.group(2).strip()
    body = post_body[:match.start()].rstrip()

    # Parse and reformat for TTS
    try:
        dt = datetime.strptime(f"{date_str} {time_str}", "%b %d, %Y %I:%M %p")
        day = dt.day
        # Ordinal suffix
        if 11 <= day <= 13:
            suffix = "th"
        elif day % 10 == 1:
            suffix = "st"
        elif day % 10 == 2:
            suffix = "nd"
        elif day % 10 == 3:
            suffix = "rd"
        else:
            suffix = "th"
        formatted = f"On {dt.strftime('%B')} {day}{suffix}, {dt.year} at {time_str}"
    except ValueError:
        # Fallback: use raw strings
        formatted = f"On {date_str} at {time_str}"

    return body, formatted


def format_tts_text(
    post_body: str,
    author_name: str | None = None,
    author_handle: str | None = None,
) -> str:
    """Format the full TTS text with author attribution and timestamp.

    Produces a natural spoken preamble:
        "On February 28th, 2026 at 7:32 AM, Peter Girnus posted:

        I work in government affairs at OpenAI..."

    The timestamp is extracted from the end of the post body (where the
    VLM placed it) and moved to the preamble so it's not read twice.
    """
    body, timestamp = _parse_tweet_timestamp(post_body)

    # Build preamble: "On [date], [author] posted:"
    parts = []
    if timestamp:
        parts.append(timestamp)

    if author_name:
        parts.append(author_name)
    elif author_handle:
        parts.append(author_handle)

    if parts:
        preamble = ", ".join(parts) + " posted:"
        # Capitalize first char
        preamble = preamble[0].upper() + preamble[1:]
    else:
        return body

    return f"{preamble}\n\n{body}"
