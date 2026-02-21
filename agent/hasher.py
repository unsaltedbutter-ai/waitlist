"""3-tier perceptual hashing for screenshot-based page identification.

Tier 1: SHA-256 of raw PNG bytes (exact pixel match)
Tier 2: SHA-256 of blurred, downscaled pixel buffer (tolerates minor rendering diffs)
Tier 3: pHash via imagehash (tolerates layout shifts, color changes, dynamic content)
"""

from __future__ import annotations

import hashlib
import io

import imagehash
from PIL import Image, ImageFilter

# Tier 2: downscale target and blur radius
TIER2_SIZE = (480, 270)
TIER2_BLUR_RADIUS = 2

# Tier 3: pHash parameters
PHASH_HASH_SIZE = 32   # 32x32 = 1024-bit hash
PHASH_THRESHOLD = 100   # max hamming distance for a match


def tier1_hash(img: Image.Image) -> str:
    """SHA-256 of lossless PNG bytes. Exact pixel match only."""
    buf = io.BytesIO()
    img.save(buf, format='PNG')
    return hashlib.sha256(buf.getvalue()).hexdigest()


def tier2_hash(img: Image.Image) -> str:
    """SHA-256 of blurred, downscaled raw pixel buffer.

    Normalizes the image to a fixed size with Gaussian blur to absorb
    minor rendering differences (anti-aliasing, subpixel shifts).
    """
    normalized = img.resize(TIER2_SIZE, Image.LANCZOS).filter(
        ImageFilter.GaussianBlur(radius=TIER2_BLUR_RADIUS),
    )
    return hashlib.sha256(normalized.tobytes()).hexdigest()


def tier3_hash(img: Image.Image) -> imagehash.ImageHash:
    """Perceptual hash (pHash). Tolerates significant visual differences."""
    return imagehash.phash(img, hash_size=PHASH_HASH_SIZE)


def compute_all_hashes(img: Image.Image) -> tuple[str, str, str]:
    """Compute all 3 tiers. Returns (sha256_full, sha256_blurred, phash_hex)."""
    return (
        tier1_hash(img),
        tier2_hash(img),
        str(tier3_hash(img)),
    )
