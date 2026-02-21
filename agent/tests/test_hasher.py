"""Tests for agent.hasher: 3-tier perceptual hashing.

Uses synthetic Pillow-generated images to validate hash computation
and tier behavior without any external dependencies.

Run: cd agent && python -m pytest tests/test_hasher.py -v
"""

from __future__ import annotations

from PIL import Image, ImageDraw

from agent.hasher import (
    PHASH_HASH_SIZE,
    PHASH_THRESHOLD,
    TIER2_SIZE,
    compute_all_hashes,
    tier1_hash,
    tier2_hash,
    tier3_hash,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _solid_image(color: tuple[int, int, int], size: tuple[int, int] = (1280, 720)) -> Image.Image:
    """Create a solid-color RGB image."""
    return Image.new('RGB', size, color)


def _image_with_text(text: str, size: tuple[int, int] = (1280, 720)) -> Image.Image:
    """Create a white image with black text drawn on it."""
    img = Image.new('RGB', size, (255, 255, 255))
    draw = ImageDraw.Draw(img)
    draw.text((100, 100), text, fill=(0, 0, 0))
    return img


def _slightly_modified(img: Image.Image) -> Image.Image:
    """Return a copy with a few pixels changed (simulates minor rendering diff)."""
    copy = img.copy()
    copy.putpixel((0, 0), (1, 1, 1))
    copy.putpixel((1, 0), (2, 2, 2))
    copy.putpixel((0, 1), (3, 3, 3))
    return copy


# ---------------------------------------------------------------------------
# Tier 1: SHA-256 exact
# ---------------------------------------------------------------------------

class TestTier1Hash:
    def test_deterministic(self) -> None:
        """Same image produces the same hash."""
        img = _solid_image((255, 0, 0))
        assert tier1_hash(img) == tier1_hash(img)

    def test_different_images_differ(self) -> None:
        """Different images produce different hashes."""
        red = _solid_image((255, 0, 0))
        blue = _solid_image((0, 0, 255))
        assert tier1_hash(red) != tier1_hash(blue)

    def test_single_pixel_change_differs(self) -> None:
        """Even a single pixel change produces a different tier 1 hash."""
        img = _solid_image((128, 128, 128))
        modified = _slightly_modified(img)
        assert tier1_hash(img) != tier1_hash(modified)

    def test_hash_is_hex_string(self) -> None:
        """Hash is a 64-char hex string (SHA-256)."""
        h = tier1_hash(_solid_image((0, 0, 0)))
        assert len(h) == 64
        assert all(c in '0123456789abcdef' for c in h)


# ---------------------------------------------------------------------------
# Tier 2: blurred SHA-256
# ---------------------------------------------------------------------------

class TestTier2Hash:
    def test_deterministic(self) -> None:
        img = _solid_image((255, 0, 0))
        assert tier2_hash(img) == tier2_hash(img)

    def test_different_colors_differ(self) -> None:
        red = _solid_image((255, 0, 0))
        blue = _solid_image((0, 0, 255))
        assert tier2_hash(red) != tier2_hash(blue)

    def test_minor_pixel_change_same(self) -> None:
        """Minor pixel changes in a content-rich image are absorbed by blur + downscale."""
        # Use a realistic image with varied content (not a solid color where
        # any pixel change at the edge visibly shifts the downscaled output)
        img = _image_with_text('Login to Netflix')
        # Modify a few pixels in the interior (simulates anti-aliasing diff)
        modified = img.copy()
        modified.putpixel((640, 360), (254, 254, 254))
        modified.putpixel((641, 360), (253, 253, 253))
        modified.putpixel((640, 361), (254, 254, 254))
        assert tier2_hash(img) == tier2_hash(modified)

    def test_different_source_sizes_same(self) -> None:
        """Images of different sizes with same content produce the same hash."""
        small = _solid_image((200, 100, 50), size=(640, 360))
        large = _solid_image((200, 100, 50), size=(1920, 1080))
        assert tier2_hash(small) == tier2_hash(large)

    def test_hash_is_hex_string(self) -> None:
        h = tier2_hash(_solid_image((0, 0, 0)))
        assert len(h) == 64


# ---------------------------------------------------------------------------
# Tier 3: pHash
# ---------------------------------------------------------------------------

class TestTier3Hash:
    def test_deterministic(self) -> None:
        img = _solid_image((255, 0, 0))
        assert tier3_hash(img) == tier3_hash(img)

    def test_similar_images_close(self) -> None:
        """Similar images (same structure, slight color shift) have small hamming distance."""
        img = _solid_image((100, 100, 100))
        # Slightly different shade (simulates brightness/contrast diff between renders)
        similar = _solid_image((105, 105, 105))
        h1 = tier3_hash(img)
        h2 = tier3_hash(similar)
        distance = h1 - h2
        assert distance <= PHASH_THRESHOLD

    def test_very_different_images_far(self) -> None:
        """Very different images have large hamming distance."""
        white = _solid_image((255, 255, 255))
        checkerboard = Image.new('RGB', (1280, 720))
        draw = ImageDraw.Draw(checkerboard)
        for x in range(0, 1280, 40):
            for y in range(0, 720, 40):
                color = (0, 0, 0) if (x // 40 + y // 40) % 2 == 0 else (255, 255, 255)
                draw.rectangle([x, y, x + 39, y + 39], fill=color)
        h1 = tier3_hash(white)
        h2 = tier3_hash(checkerboard)
        # They should be different (distance > 0)
        assert (h1 - h2) > 0

    def test_hash_size(self) -> None:
        """pHash has the expected bit size."""
        h = tier3_hash(_solid_image((100, 100, 100)))
        # imagehash.ImageHash stores hash_size^2 bits
        assert h.hash.size == PHASH_HASH_SIZE ** 2


# ---------------------------------------------------------------------------
# compute_all_hashes
# ---------------------------------------------------------------------------

class TestComputeAllHashes:
    def test_returns_three_strings(self) -> None:
        img = _solid_image((50, 50, 50))
        sha_full, sha_blur, phash_hex = compute_all_hashes(img)
        assert isinstance(sha_full, str)
        assert isinstance(sha_blur, str)
        assert isinstance(phash_hex, str)
        assert len(sha_full) == 64
        assert len(sha_blur) == 64

    def test_consistency(self) -> None:
        """compute_all_hashes matches individual tier functions."""
        img = _image_with_text('Consistency test')
        sha_full, sha_blur, phash_hex = compute_all_hashes(img)
        assert sha_full == tier1_hash(img)
        assert sha_blur == tier2_hash(img)
        assert phash_hex == str(tier3_hash(img))
