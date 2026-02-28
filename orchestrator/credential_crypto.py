"""Sealed-box credential decryption using X25519 private key.

The VPS encrypts credentials with crypto_box_seal (libsodium sealed boxes).
Only the orchestrator holds the private key and can decrypt.
"""

from __future__ import annotations

import base64
import logging
from pathlib import Path

from nacl.public import PrivateKey, SealedBox

log = logging.getLogger(__name__)


class CredentialDecryptor:
    """Decrypts sealed-box credentials using a local X25519 private key."""

    def __init__(self, key_path: str) -> None:
        path = Path(key_path)
        if not path.exists():
            raise FileNotFoundError(f"Credential private key not found: {path}")
        key_bytes = path.read_bytes()
        if len(key_bytes) != 32:
            raise ValueError(
                f"Credential private key must be 32 bytes, got {len(key_bytes)}"
            )
        self._box = SealedBox(PrivateKey(key_bytes))

    def decrypt(self, sealed_b64: str) -> str:
        """Decrypt a base64-encoded sealed box ciphertext to plaintext string."""
        ciphertext = base64.b64decode(sealed_b64)
        return self._box.decrypt(ciphertext).decode("utf-8")

    def decrypt_credentials(self, data: dict) -> dict:
        """Decrypt {email_sealed, password_sealed} to {email, password}."""
        return {
            "email": self.decrypt(data["email_sealed"]),
            "password": self.decrypt(data["password_sealed"]),
        }
