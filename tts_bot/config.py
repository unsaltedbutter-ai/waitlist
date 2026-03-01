"""
TTS Bot configuration.

Frozen dataclass loaded from environment variables.
Loads ~/.unsaltedbutter/shared.env first, then ~/.unsaltedbutter/tts_bot.env.
"""

from __future__ import annotations

import math
import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv
from nostr_sdk import PublicKey


def _normalize_pubkey(value: str) -> str:
    """Accept npub1... or hex, return 64-char hex."""
    return PublicKey.parse(value).to_hex()


_REQUIRED_FIELDS = (
    "API_BASE_URL",
    "AGENT_HMAC_SECRET",
    "NOSTR_NSEC",
    "VPS_BOT_PUBKEY",
    "ZAP_PROVIDER_PUBKEY",
)

_DEFAULT_RELAYS = "wss://relay.damus.io,wss://nos.lol,wss://relay.snort.social"


def _parse_price_tiers(raw: str) -> list[tuple[int, int]]:
    """Parse 'max_chars:sats,...' into sorted list of (max_chars, sats) tuples."""
    tiers = []
    for pair in raw.split(","):
        pair = pair.strip()
        if not pair:
            continue
        chars_str, sats_str = pair.split(":")
        tiers.append((int(chars_str), int(sats_str)))
    tiers.sort(key=lambda t: t[0])
    return tiers


@dataclass(frozen=True)
class Config:
    """Immutable TTS bot configuration."""

    # VPS connection
    api_base_url: str
    hmac_secret: str

    # TTS Agent
    tts_agent_url: str

    # Nostr identity
    nostr_nsec: str
    nostr_relays: list[str]
    vps_bot_pubkey: str

    # Audio settings
    max_chars: int
    price_tiers: list[tuple[int, int]]
    cache_discount_pct: int
    max_plays: int
    default_voice: str

    # Zap validation
    zap_provider_pubkey: str

    # Logging
    log_level: str

    # Bot profile
    bot_name: str
    bot_about: str
    bot_picture: str
    bot_lud16: str

    @classmethod
    def load(cls) -> Config:
        """Load configuration from environment variables."""
        ub_dir = Path.home() / ".unsaltedbutter"
        shared_env = ub_dir / "shared.env"
        component_env = ub_dir / "tts_bot.env"
        if shared_env.exists():
            load_dotenv(shared_env)
        if component_env.exists():
            load_dotenv(component_env, override=True)

        missing = [
            name for name in _REQUIRED_FIELDS
            if not os.environ.get(name, "").strip()
        ]
        if missing:
            raise ValueError(
                f"Missing required environment variables: {', '.join(missing)}"
            )

        relay_csv = os.environ.get("NOSTR_RELAYS", _DEFAULT_RELAYS)
        relays = [r.strip() for r in relay_csv.split(",") if r.strip()]

        price_tiers_raw = os.environ.get(
            "AUDIO_PRICE_TIERS",
            "8000:500,12000:750,20000:1000,35000:1250,50000:1500",
        )

        return cls(
            api_base_url=os.environ["API_BASE_URL"].strip(),
            hmac_secret=os.environ["AGENT_HMAC_SECRET"].strip(),
            tts_agent_url=os.environ.get(
                "TTS_AGENT_URL", "http://localhost:8425"
            ).strip(),
            nostr_nsec=os.environ["NOSTR_NSEC"].strip(),
            nostr_relays=relays,
            vps_bot_pubkey=_normalize_pubkey(
                os.environ["VPS_BOT_PUBKEY"].strip()
            ),
            zap_provider_pubkey=_normalize_pubkey(
                os.environ["ZAP_PROVIDER_PUBKEY"].strip()
            ),
            max_chars=int(os.environ.get("AUDIO_MAX_CHARS", "50000")),
            price_tiers=_parse_price_tiers(price_tiers_raw),
            cache_discount_pct=int(
                os.environ.get("AUDIO_CACHE_DISCOUNT_PCT", "25")
            ),
            max_plays=int(os.environ.get("AUDIO_MAX_PLAYS", "3")),
            default_voice=os.environ.get(
                "AUDIO_TTS_DEFAULT_VOICE", "af_heart"
            ).strip(),
            log_level=os.environ.get("LOG_LEVEL", "INFO").strip().upper(),
            bot_name=os.environ.get(
                "BOT_NAME", "UnsaltedButter Audio"
            ).strip(),
            bot_about=os.environ.get(
                "BOT_ABOUT",
                "DM me an X.com post URL and I'll turn it into audio. Pay per listen via Lightning.",
            ).strip(),
            bot_picture=os.environ.get(
                "BOT_PICTURE", "https://unsaltedbutter.ai/audio-bot.png"
            ).strip(),
            bot_lud16=os.environ.get("BOT_LUD16", "").strip(),
        )

    def get_price_sats(self, char_count: int) -> int | None:
        """Find the tier price for a given character count.

        Returns sats price, or None if char_count exceeds max_chars.
        """
        if char_count > self.max_chars:
            return None
        for max_chars, sats in self.price_tiers:
            if char_count <= max_chars:
                return sats
        # Fallback: use the last (most expensive) tier
        if self.price_tiers:
            return self.price_tiers[-1][1]
        return None

    def get_cached_price_sats(self, char_count: int) -> int | None:
        """Get the discounted price for a cached tweet."""
        base = self.get_price_sats(char_count)
        if base is None:
            return None
        discount = base * self.cache_discount_pct / 100
        return math.ceil(base - discount)
