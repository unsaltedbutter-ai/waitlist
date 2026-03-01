"""
DM message templates for the TTS Bot.
"""

from __future__ import annotations

import math


def estimate_audio_minutes(char_count: int) -> int:
    """Estimate audio duration from character count.

    Rough heuristic: ~180 words/minute spoken, ~5.5 chars/word average.
    """
    words = char_count / 5.5
    minutes = words / 180
    return max(1, math.ceil(minutes))


def price_quote(
    char_count: int,
    price_sats: int,
    cached: bool = False,
    cache_discount_pct: int = 25,
) -> str:
    """Format a price quote DM."""
    duration = estimate_audio_minutes(char_count)

    if cached:
        return (
            f"This post was already converted (~{duration} min audio). "
            f"Cost: {price_sats:,} sats ({cache_discount_pct}% cached discount). "
            f"Pay to listen:"
        )
    else:
        return (
            f"This post is ~{char_count:,} characters (~{duration} min audio). "
            f"Cost: {price_sats:,} sats. "
            f"Pay to listen:"
        )


def listen_link(base_url: str, token: str) -> str:
    """Format the listen link DM."""
    return f"Your audio is ready! Listen here:\n{base_url}/listen/{token}"


def too_long(char_count: int, max_chars: int) -> str:
    """Format the "too long" rejection DM."""
    return (
        f"This post is {char_count:,} characters, which exceeds the "
        f"{max_chars:,} character limit. Try a shorter post."
    )


def already_in_progress() -> str:
    """Format the "one at a time" rate limit DM."""
    return "You already have a request in progress. Please wait for it to complete."


def extraction_failed() -> str:
    """Format the extraction failure DM."""
    return "Sorry, I couldn't extract text from that post. The page may have failed to load or the URL may be invalid."


def synthesis_failed() -> str:
    """Format the synthesis failure DM."""
    return "Sorry, audio generation failed for this post. Please try again later."


def invalid_url() -> str:
    """Format the invalid URL DM."""
    return "Please send me an X.com (Twitter) post URL. Example: https://x.com/username/status/123456789"


def payment_received() -> str:
    """Format the payment confirmation DM."""
    return "Payment received! Generating your audio now..."
