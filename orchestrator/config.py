"""
Orchestrator configuration.

Frozen dataclass loaded from environment variables.
Loads ~/.unsaltedbutter/shared.env first (common identity, relays, URLs),
then ~/.unsaltedbutter/orchestrator.env (component-specific overrides).
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

_REQUIRED_FIELDS = (
    "API_BASE_URL",
    "AGENT_HMAC_SECRET",
    "NOSTR_NSEC",
    "VPS_BOT_PUBKEY",
    "ZAP_PROVIDER_PUBKEY",
    "OPERATOR_NPUB",
)

_DEFAULT_RELAYS = "wss://relay.damus.io,wss://nos.lol,wss://relay.snort.social"


@dataclass(frozen=True)
class Config:
    """Immutable orchestrator configuration."""

    # VPS connection
    api_base_url: str
    hmac_secret: str

    # Nostr identity
    nostr_nsec: str
    nostr_relays: list[str]
    vps_bot_pubkey: str
    zap_provider_pubkey: str
    operator_npub: str

    # URLs
    base_url: str
    agent_url: str

    # Callback server
    callback_host: str
    callback_port: int

    # Storage
    db_path: str

    # Operational limits
    max_concurrent_agent_jobs: int
    action_price_sats: int
    otp_timeout_seconds: int
    payment_expiry_seconds: int
    outreach_interval_seconds: int
    timer_tick_seconds: int

    # Logging
    log_level: str

    # Bot profile
    bot_name: str
    bot_about: str
    bot_lud16: str

    @classmethod
    def load(cls) -> Config:
        """Load configuration from environment variables.

        Reads from ~/.unsaltedbutter/orchestrator.env first,
        then falls back to .env in the current directory.
        Raises ValueError if any required field is missing or empty.
        """
        ub_dir = Path.home() / ".unsaltedbutter"
        shared_env = ub_dir / "shared.env"
        component_env = ub_dir / "orchestrator.env"
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

        return cls(
            api_base_url=os.environ["API_BASE_URL"].strip(),
            hmac_secret=os.environ["AGENT_HMAC_SECRET"].strip(),
            nostr_nsec=os.environ["NOSTR_NSEC"].strip(),
            nostr_relays=relays,
            vps_bot_pubkey=os.environ["VPS_BOT_PUBKEY"].strip(),
            zap_provider_pubkey=os.environ["ZAP_PROVIDER_PUBKEY"].strip(),
            operator_npub=os.environ["OPERATOR_NPUB"].strip(),
            base_url=os.environ.get("BASE_URL", "https://unsaltedbutter.ai").strip(),
            agent_url=os.environ.get("AGENT_URL", "http://192.168.1.100:8421").strip(),
            callback_host=os.environ.get("CALLBACK_HOST", "0.0.0.0").strip(),
            callback_port=int(os.environ.get("CALLBACK_PORT", "8422")),
            db_path=os.environ.get("DB_PATH", "orchestrator.db").strip(),
            max_concurrent_agent_jobs=int(
                os.environ.get("MAX_CONCURRENT_AGENT_JOBS", "2")
            ),
            action_price_sats=int(os.environ.get("ACTION_PRICE_SATS", "3000")),
            otp_timeout_seconds=int(os.environ.get("OTP_TIMEOUT_SECONDS", "900")),
            payment_expiry_seconds=int(
                os.environ.get("PAYMENT_EXPIRY_SECONDS", "86400")
            ),
            outreach_interval_seconds=int(
                os.environ.get("OUTREACH_INTERVAL_SECONDS", "172800")
            ),
            timer_tick_seconds=int(os.environ.get("TIMER_TICK_SECONDS", "60")),
            log_level=os.environ.get("LOG_LEVEL", "INFO").strip().upper(),
            bot_name=os.environ.get("BOT_NAME", "UnsaltedButter Bot").strip(),
            bot_about=os.environ.get(
                "BOT_ABOUT",
                "DM me to manage your streaming services. Pay-per-action, 3k sats.",
            ).strip(),
            bot_lud16=os.environ.get("BOT_LUD16", "").strip(),
        )
