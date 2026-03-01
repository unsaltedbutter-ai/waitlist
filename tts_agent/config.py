"""
TTS Agent configuration.

Frozen dataclass loaded from environment variables.
Loads ~/.unsaltedbutter/shared.env first (common identity, relays, URLs),
then ~/.unsaltedbutter/tts_agent.env (component-specific overrides).
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv


_REQUIRED_FIELDS = (
    "API_BASE_URL",
    "AGENT_HMAC_SECRET",
)


@dataclass(frozen=True)
class Config:
    """Immutable TTS agent configuration."""

    # VPS connection
    api_base_url: str
    hmac_secret: str

    # TTS service
    tts_url: str

    # VLM (text extraction)
    vlm_url: str
    vlm_model: str

    # Server
    host: str
    port: int

    # Logging
    log_level: str

    @classmethod
    def load(cls) -> Config:
        """Load configuration from environment variables."""
        ub_dir = Path.home() / ".unsaltedbutter"
        shared_env = ub_dir / "shared.env"
        component_env = ub_dir / "tts_agent.env"
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

        return cls(
            api_base_url=os.environ["API_BASE_URL"].strip(),
            hmac_secret=os.environ["AGENT_HMAC_SECRET"].strip(),
            tts_url=os.environ.get("TTS_URL", "http://localhost:8424").strip(),
            vlm_url=os.environ.get("VLM_URL", "http://localhost:8080").strip(),
            vlm_model=os.environ.get("VLM_MODEL", "qwen").strip(),
            host=os.environ.get("TTS_AGENT_HOST", "0.0.0.0").strip(),
            port=int(os.environ.get("TTS_AGENT_PORT", "8425")),
            log_level=os.environ.get("LOG_LEVEL", "INFO").strip().upper(),
        )
