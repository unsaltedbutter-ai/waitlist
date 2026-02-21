"""SQLite-backed 3-tier page hash cache for fast page identification.

Lookup order:
  1. SHA-256 exact match (tier 1)
  2. SHA-256 blurred/downscaled match (tier 2)
  3. pHash hamming distance within threshold, scoped by service (tier 3)

On miss, returns None so the caller can fall back to VLM.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

import imagehash
from PIL import Image

from agent.hasher import (
    PHASH_THRESHOLD,
    compute_all_hashes,
    tier1_hash,
    tier2_hash,
    tier3_hash,
)

_SCHEMA = """\
CREATE TABLE IF NOT EXISTS page_hashes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    page_id TEXT NOT NULL,
    service TEXT NOT NULL,
    sha256_full TEXT NOT NULL,
    sha256_blurred TEXT NOT NULL,
    phash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_hit TEXT,
    hit_count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_page_hashes_service ON page_hashes(service);
CREATE INDEX IF NOT EXISTS idx_page_hashes_sha256_full ON page_hashes(sha256_full);
CREATE INDEX IF NOT EXISTS idx_page_hashes_sha256_blurred ON page_hashes(sha256_blurred);

CREATE TABLE IF NOT EXISTS page_flows (
    page_id TEXT NOT NULL,
    flow TEXT NOT NULL,
    PRIMARY KEY (page_id, flow)
);
"""


class PageCache:
    """3-tier page lookup backed by a local SQLite database."""

    def __init__(self, db_path: Path | str) -> None:
        self._db_path = str(db_path)
        self._conn = sqlite3.connect(self._db_path)
        self._conn.row_factory = sqlite3.Row
        self._conn.executescript(_SCHEMA)

    # ------------------------------------------------------------------
    # Lookup
    # ------------------------------------------------------------------

    def lookup(self, img: Image.Image, service: str, flow: str) -> str | None:
        """3-tier lookup. Returns page_id or None on complete miss."""
        # Tier 1: exact SHA-256
        sha_full = tier1_hash(img)
        page_id = self._lookup_by_column('sha256_full', sha_full, service, flow)
        if page_id:
            return page_id

        # Tier 2: blurred SHA-256
        sha_blur = tier2_hash(img)
        page_id = self._lookup_by_column('sha256_blurred', sha_blur, service, flow)
        if page_id:
            return page_id

        # Tier 3: pHash hamming distance
        phash = tier3_hash(img)
        return self._lookup_by_phash(phash, service, flow)

    def _lookup_by_column(
        self, column: str, value: str, service: str, flow: str,
    ) -> str | None:
        """Exact match on a hash column, scoped by service and flow."""
        # column is always one of our known column names, not user input
        row = self._conn.execute(
            f"""
            SELECT ph.page_id FROM page_hashes ph
            JOIN page_flows pf ON ph.page_id = pf.page_id
            WHERE ph.{column} = ? AND ph.service = ? AND pf.flow = ?
            LIMIT 1
            """,
            (value, service, flow),
        ).fetchone()
        if row:
            page_id = row['page_id']
            self._record_hit(page_id)
            return page_id
        return None

    def _lookup_by_phash(
        self, phash: imagehash.ImageHash, service: str, flow: str,
    ) -> str | None:
        """Scan service-scoped entries for closest pHash within threshold."""
        rows = self._conn.execute(
            """
            SELECT ph.page_id, ph.phash FROM page_hashes ph
            JOIN page_flows pf ON ph.page_id = pf.page_id
            WHERE ph.service = ? AND pf.flow = ?
            """,
            (service, flow),
        ).fetchall()

        best_page_id: str | None = None
        best_distance = PHASH_THRESHOLD + 1

        for row in rows:
            stored = imagehash.hex_to_hash(row['phash'])
            distance = phash - stored
            if distance < best_distance:
                best_distance = distance
                best_page_id = row['page_id']

        if best_page_id is not None and best_distance <= PHASH_THRESHOLD:
            self._record_hit(best_page_id)
            return best_page_id
        return None

    def _record_hit(self, page_id: str) -> None:
        """Bump hit count and last_hit timestamp."""
        self._conn.execute(
            """
            UPDATE page_hashes
            SET hit_count = hit_count + 1, last_hit = datetime('now')
            WHERE page_id = ?
            """,
            (page_id,),
        )
        self._conn.commit()

    # ------------------------------------------------------------------
    # Insert
    # ------------------------------------------------------------------

    def insert(
        self, page_id: str, service: str, flows: list[str], img: Image.Image,
    ) -> None:
        """Insert a new page hash entry with its flow associations."""
        sha_full, sha_blur, phash_hex = compute_all_hashes(img)
        self._conn.execute(
            """
            INSERT INTO page_hashes (page_id, service, sha256_full, sha256_blurred, phash)
            VALUES (?, ?, ?, ?, ?)
            """,
            (page_id, service, sha_full, sha_blur, phash_hex),
        )
        for flow in flows:
            self._conn.execute(
                """
                INSERT OR IGNORE INTO page_flows (page_id, flow)
                VALUES (?, ?)
                """,
                (page_id, flow),
            )
        self._conn.commit()

    # ------------------------------------------------------------------
    # Stats
    # ------------------------------------------------------------------

    def stats(self) -> dict:
        """Cache statistics."""
        row = self._conn.execute(
            'SELECT COUNT(*) as cnt, COALESCE(SUM(hit_count), 0) as hits FROM page_hashes',
        ).fetchone()
        return {
            'entries': row['cnt'],
            'total_hits': row['hits'],
        }

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def close(self) -> None:
        self._conn.close()
