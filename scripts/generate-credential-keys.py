#!/usr/bin/env python3
"""Generate X25519 keypair for credential encryption.

Run on the orchestrator machine (Mac Mini). The private key stays local,
the public key is set as CREDENTIAL_PUBLIC_KEY on the VPS.

Usage:
    python3 scripts/generate-credential-keys.py

Output:
    - Private key written to ~/.unsaltedbutter/credential.key (chmod 600)
    - Public key hex printed to stdout (copy to VPS .env.production)
"""

import os
import sys
from pathlib import Path

try:
    from nacl.public import PrivateKey
except ImportError:
    print("ERROR: PyNaCl not installed. Run: pip install PyNaCl>=1.5.0")
    sys.exit(1)

KEY_DIR = Path.home() / ".unsaltedbutter"
KEY_FILE = KEY_DIR / "credential.key"


def main() -> None:
    if KEY_FILE.exists():
        print(f"ERROR: {KEY_FILE} already exists. Delete it first to regenerate.")
        sys.exit(1)

    # Generate keypair
    private_key = PrivateKey.generate()
    public_key = private_key.public_key

    # Write private key
    KEY_DIR.mkdir(parents=True, exist_ok=True)
    KEY_FILE.write_bytes(bytes(private_key))
    os.chmod(KEY_FILE, 0o600)

    print(f"Private key written to: {KEY_FILE}")
    print()
    print("Add this to VPS .env.production:")
    print(f"  CREDENTIAL_PUBLIC_KEY={bytes(public_key).hex()}")
    print()
    print("Add this to orchestrator.env:")
    print(f"  CREDENTIAL_PRIVATE_KEY_PATH={KEY_FILE}")


if __name__ == "__main__":
    main()
