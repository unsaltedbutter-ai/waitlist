"""Tests for sealed-box credential decryption (credential_crypto.py)."""

from __future__ import annotations

import base64
import tempfile
from pathlib import Path

import pytest
from nacl.public import PrivateKey, SealedBox

from credential_crypto import CredentialDecryptor


@pytest.fixture
def key_pair(tmp_path: Path):
    """Generate an X25519 keypair and write the private key to a temp file."""
    private_key = PrivateKey.generate()
    key_file = tmp_path / "credential.key"
    key_file.write_bytes(bytes(private_key))
    return private_key, key_file


def _seal(public_key, plaintext: str) -> str:
    """Encrypt plaintext with the public key and return base64."""
    box = SealedBox(public_key)
    ciphertext = box.encrypt(plaintext.encode("utf-8"))
    return base64.b64encode(ciphertext).decode("ascii")


class TestCredentialDecryptor:
    def test_round_trip(self, key_pair):
        private_key, key_file = key_pair
        decryptor = CredentialDecryptor(str(key_file))

        sealed = _seal(private_key.public_key, "hunter2")
        assert decryptor.decrypt(sealed) == "hunter2"

    def test_decrypt_credentials(self, key_pair):
        private_key, key_file = key_pair
        decryptor = CredentialDecryptor(str(key_file))

        email_sealed = _seal(private_key.public_key, "user@example.com")
        pass_sealed = _seal(private_key.public_key, "s3cret")

        result = decryptor.decrypt_credentials({
            "email_sealed": email_sealed,
            "password_sealed": pass_sealed,
        })
        assert result == {"email": "user@example.com", "password": "s3cret"}

    def test_unicode_round_trip(self, key_pair):
        private_key, key_file = key_pair
        decryptor = CredentialDecryptor(str(key_file))

        sealed = _seal(private_key.public_key, "p@$$w\u00f6rd!")
        assert decryptor.decrypt(sealed) == "p@$$w\u00f6rd!"

    def test_file_not_found(self, tmp_path: Path):
        with pytest.raises(FileNotFoundError, match="not found"):
            CredentialDecryptor(str(tmp_path / "nonexistent.key"))

    def test_wrong_key_length(self, tmp_path: Path):
        key_file = tmp_path / "bad.key"
        key_file.write_bytes(b"\x00" * 16)
        with pytest.raises(ValueError, match="32 bytes"):
            CredentialDecryptor(str(key_file))

    def test_wrong_key_fails_decrypt(self, key_pair, tmp_path: Path):
        private_key, _ = key_pair

        # Create a different key
        other_key = PrivateKey.generate()
        other_file = tmp_path / "other.key"
        other_file.write_bytes(bytes(other_key))

        decryptor = CredentialDecryptor(str(other_file))
        sealed = _seal(private_key.public_key, "secret")

        with pytest.raises(Exception):
            decryptor.decrypt(sealed)
