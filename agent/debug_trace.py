"""Debug trace: save screenshots and VLM responses for failed job forensics.

On each VLM step, saves the screenshot (PNG) and VLM response (JSON) to
~/.unsaltedbutter/debug/{job_id}/. On success the folder is deleted. On
failure it persists for operator review. Old folders are pruned on startup.
"""

from __future__ import annotations

import base64
import json
import logging
import os
import shutil
import time
from pathlib import Path

log = logging.getLogger(__name__)

DEFAULT_DEBUG_DIR = os.path.expanduser('~/.unsaltedbutter/debug')
DEFAULT_MAX_AGE_DAYS = 14


class DebugTrace:
    """Per-job debug trace writer.

    Args:
        job_id: Job identifier (used as folder name).
        base_dir: Parent directory for all debug folders.
        enabled: When False, all operations are no-ops.
    """

    def __init__(
        self,
        job_id: str,
        base_dir: str | None = None,
        enabled: bool = True,
    ) -> None:
        self.job_id = job_id
        self.enabled = enabled
        resolved_dir = base_dir or DEFAULT_DEBUG_DIR
        self._dir = Path(resolved_dir) / job_id if job_id else None

        if self.enabled and self._dir:
            self._dir.mkdir(parents=True, exist_ok=True)

    @property
    def trace_dir(self) -> Path | None:
        return self._dir

    def save_step(
        self,
        step: int,
        screenshot_b64: str,
        vlm_response: dict | None,
        phase: str = '',
    ) -> None:
        """Save a single step's screenshot and VLM response.

        Args:
            step: Zero-based step/iteration number.
            screenshot_b64: Base64-encoded PNG screenshot.
            vlm_response: The VLM response dict (bounding boxes, actions, etc.).
                Never contains actual credential values.
            phase: Label like 'sign-in', 'cancel', 'resume'.
        """
        if not self.enabled or not self._dir:
            return

        prefix = f'step_{step:03d}'

        # Save screenshot as PNG
        try:
            png_path = self._dir / f'{prefix}.png'
            png_bytes = base64.b64decode(screenshot_b64)
            png_path.write_bytes(png_bytes)
        except Exception as exc:
            log.debug('Failed to save debug screenshot step %d: %s', step, exc)

        # Save VLM response as JSON
        try:
            meta = {
                'step': step,
                'phase': phase,
                'timestamp': time.time(),
            }
            if vlm_response is not None:
                meta['vlm_response'] = vlm_response
            json_path = self._dir / f'{prefix}.json'
            json_path.write_text(json.dumps(meta, indent=2, default=str))
        except Exception as exc:
            log.debug('Failed to save debug metadata step %d: %s', step, exc)

    def cleanup_success(self) -> None:
        """Delete the trace folder (job succeeded, no forensics needed)."""
        if not self._dir or not self._dir.exists():
            return
        try:
            shutil.rmtree(self._dir)
            log.debug('Deleted debug trace for successful job %s', self.job_id)
        except Exception as exc:
            log.warning('Failed to delete debug trace %s: %s', self._dir, exc)

    @staticmethod
    def prune_old(
        base_dir: str | None = None,
        max_age_days: int = DEFAULT_MAX_AGE_DAYS,
    ) -> int:
        """Delete debug folders older than max_age_days.

        Returns the number of folders deleted.
        """
        base = Path(base_dir or DEFAULT_DEBUG_DIR)
        if not base.exists():
            return 0

        cutoff = time.time() - (max_age_days * 86400)
        deleted = 0

        for entry in base.iterdir():
            if not entry.is_dir():
                continue
            try:
                mtime = entry.stat().st_mtime
                if mtime < cutoff:
                    shutil.rmtree(entry)
                    log.info('Pruned old debug trace: %s', entry.name)
                    deleted += 1
            except Exception as exc:
                log.warning('Failed to prune %s: %s', entry, exc)

        return deleted
