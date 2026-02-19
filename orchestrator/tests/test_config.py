"""Tests for orchestrator configuration loading."""

from __future__ import annotations

import pytest
from dataclasses import FrozenInstanceError

from config import Config

# Minimal required env vars for a valid config
_REQUIRED_ENV = {
    "API_BASE_URL": "https://unsaltedbutter.ai",
    "AGENT_HMAC_SECRET": "test-hmac-secret-value",
    "NOSTR_NSEC": "nsec1testfakensecvalue",
    "VPS_BOT_PUBKEY": "aabbccdd" * 8,
    "ZAP_PROVIDER_PUBKEY": "11223344" * 8,
    "OPERATOR_NPUB": "npub1testfakenpubvalue",
}


@pytest.fixture()
def env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Set all required env vars and clear optional ones."""
    # Clear everything first so dotenv files don't interfere
    all_keys = list(_REQUIRED_ENV.keys()) + [
        "NOSTR_RELAYS", "BASE_URL", "AGENT_URL", "CALLBACK_HOST",
        "CALLBACK_PORT", "DB_PATH", "MAX_CONCURRENT_AGENT_JOBS",
        "ACTION_PRICE_SATS", "OTP_TIMEOUT_SECONDS", "PAYMENT_EXPIRY_SECONDS",
        "OUTREACH_INTERVAL_SECONDS", "TIMER_TICK_SECONDS", "LOG_LEVEL",
        "BOT_NAME", "BOT_ABOUT", "BOT_LUD16",
    ]
    for key in all_keys:
        monkeypatch.delenv(key, raising=False)

    for key, value in _REQUIRED_ENV.items():
        monkeypatch.setenv(key, value)


def test_load_valid_config(env: None) -> None:
    """All required env vars set: Config.load() succeeds with correct values."""
    cfg = Config.load()
    assert cfg.api_base_url == "https://unsaltedbutter.ai"
    assert cfg.hmac_secret == "test-hmac-secret-value"
    assert cfg.nostr_nsec == "nsec1testfakensecvalue"
    assert cfg.vps_bot_pubkey == "aabbccdd" * 8
    assert cfg.zap_provider_pubkey == "11223344" * 8
    assert cfg.operator_npub == "npub1testfakenpubvalue"


def test_load_missing_required(monkeypatch: pytest.MonkeyPatch) -> None:
    """Omitting any single required field raises ValueError."""
    for omit_key in _REQUIRED_ENV:
        # Set all required vars
        for key, value in _REQUIRED_ENV.items():
            monkeypatch.setenv(key, value)
        # Remove the one we want to test
        monkeypatch.delenv(omit_key)

        with pytest.raises(ValueError, match=omit_key):
            Config.load()


def test_load_missing_required_empty_string(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A required field set to empty string is treated as missing."""
    for key, value in _REQUIRED_ENV.items():
        monkeypatch.setenv(key, value)
    monkeypatch.setenv("AGENT_HMAC_SECRET", "   ")

    with pytest.raises(ValueError, match="AGENT_HMAC_SECRET"):
        Config.load()


def test_load_defaults(env: None) -> None:
    """Optional fields get correct defaults when not set."""
    cfg = Config.load()
    assert cfg.base_url == "https://unsaltedbutter.ai"
    assert cfg.agent_url == "http://192.168.1.100:8421"
    assert cfg.callback_host == "0.0.0.0"
    assert cfg.callback_port == 8422
    assert cfg.db_path == "orchestrator.db"
    assert cfg.max_concurrent_agent_jobs == 2
    assert cfg.action_price_sats == 3000
    assert cfg.otp_timeout_seconds == 900
    assert cfg.payment_expiry_seconds == 86400
    assert cfg.outreach_interval_seconds == 172800
    assert cfg.timer_tick_seconds == 60
    assert cfg.log_level == "INFO"
    assert cfg.bot_name == "UnsaltedButter Bot"
    assert "3k sats" in cfg.bot_about
    assert cfg.bot_lud16 == ""


def test_config_frozen(env: None) -> None:
    """Frozen dataclass prevents mutation."""
    cfg = Config.load()
    with pytest.raises(FrozenInstanceError):
        cfg.api_base_url = "https://evil.com"  # type: ignore[misc]


def test_relay_parsing(env: None, monkeypatch: pytest.MonkeyPatch) -> None:
    """Comma-separated NOSTR_RELAYS env var is parsed into a list."""
    monkeypatch.setenv(
        "NOSTR_RELAYS",
        "wss://relay.one, wss://relay.two , wss://relay.three",
    )
    cfg = Config.load()
    assert cfg.nostr_relays == [
        "wss://relay.one",
        "wss://relay.two",
        "wss://relay.three",
    ]


def test_relay_default(env: None) -> None:
    """When NOSTR_RELAYS is not set, the three default relays are used."""
    cfg = Config.load()
    assert len(cfg.nostr_relays) == 3
    assert "wss://relay.damus.io" in cfg.nostr_relays
    assert "wss://nos.lol" in cfg.nostr_relays
    assert "wss://relay.snort.social" in cfg.nostr_relays
