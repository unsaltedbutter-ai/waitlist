"""
Normalize X.com / Twitter URLs and extract tweet IDs.
"""

from __future__ import annotations

import re
from urllib.parse import urlparse


# Matches x.com or twitter.com status URLs
_TWEET_URL_RE = re.compile(
    r"^https?://(?:www\.)?(?:x\.com|twitter\.com)/([A-Za-z0-9_]+)/status/(\d+)",
)


def parse_tweet_url(text: str) -> tuple[str | None, str | None]:
    """Extract (normalized_url, tweet_id) from a message.

    Scans the text for the first x.com or twitter.com status URL.
    Returns (None, None) if no valid URL is found.

    The normalized URL always uses x.com (canonical).
    """
    match = _TWEET_URL_RE.search(text)
    if not match:
        return None, None

    username = match.group(1)
    tweet_id = match.group(2)

    # Normalize to x.com
    normalized = f"https://x.com/{username}/status/{tweet_id}"

    return normalized, tweet_id


def is_valid_tweet_id(tweet_id: str) -> bool:
    """Check if a tweet ID looks valid (numeric snowflake)."""
    return tweet_id.isdigit() and len(tweet_id) >= 10
