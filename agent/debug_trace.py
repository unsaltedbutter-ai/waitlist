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


def _draw_bbox_overlay(
    screenshot_b64: str,
    vlm_response: dict,
    scale_factor: float,
) -> bytes | None:
    """Draw bounding box rectangles onto a copy of the screenshot.

    Returns PNG bytes, or None if no boxes found or drawing fails.
    """
    from PIL import Image, ImageDraw, ImageFont  # lazy import
    import io

    # Collect (label, [x1, y1, x2, y2]) pairs from both response schemas
    boxes: list[tuple[str, list]] = []

    # Cancel/resume schema: click_point
    cp = vlm_response.get('click_point')
    if cp and len(cp) == 2:
        label = vlm_response.get('target_description', 'target') or 'target'
        boxes.append((label[:30], cp))

    # Sign-in schema: named points
    for key in ('email_point', 'password_point', 'button_point', 'profile_point'):
        pt = vlm_response.get(key)
        if pt and len(pt) in (2, 4):
            boxes.append((key, pt))

    # Sign-in schema: code_points list
    for cp_entry in vlm_response.get('code_points') or []:
        if isinstance(cp_entry, dict) and cp_entry.get('point'):
            pt = cp_entry['point']
            if len(pt) in (2, 4):
                boxes.append((cp_entry.get('label', 'code')[:30], pt))

    if not boxes:
        return None

    try:
        png_bytes = base64.b64decode(screenshot_b64)
        img = Image.open(io.BytesIO(png_bytes)).convert('RGB')
        draw = ImageDraw.Draw(img)

        try:
            font = ImageFont.truetype('/System/Library/Fonts/Helvetica.ttc', 14)
        except Exception:
            font = ImageFont.load_default()

        for label, coords in boxes:
            if len(coords) == 2:
                # Point: draw crosshair
                cx = int(coords[0] * scale_factor)
                cy = int(coords[1] * scale_factor)
                r = 8
                draw.line([cx - r, cy, cx + r, cy], fill='red', width=3)
                draw.line([cx, cy - r, cx, cy + r], fill='red', width=3)
                draw.ellipse([cx - r, cy - r, cx + r, cy + r], outline='red', width=2)
                text_bbox = draw.textbbox((cx - r, cy - r - 16), label, font=font)
                draw.rectangle(text_bbox, fill='red')
                draw.text((cx - r, cy - r - 16), label, fill='white', font=font)
            else:
                # Bounding box: draw rectangle
                x1 = int(coords[0] * scale_factor)
                y1 = int(coords[1] * scale_factor)
                x2 = int(coords[2] * scale_factor)
                y2 = int(coords[3] * scale_factor)
                draw.rectangle([x1, y1, x2, y2], outline='red', width=3)
                text_bbox = draw.textbbox((x1, y1 - 16), label, font=font)
                draw.rectangle(text_bbox, fill='red')
                draw.text((x1, y1 - 16), label, fill='white', font=font)

        buf = io.BytesIO()
        img.save(buf, format='PNG')
        return buf.getvalue()
    except Exception as exc:
        log.debug('Failed to draw bbox overlay: %s', exc)
        return None


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
        metadata: dict | None = None,
    ) -> None:
        self.job_id = job_id
        self.enabled = enabled
        self._metadata = metadata or {}
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
        scale_factor: float = 0.0,
        diagnostics: dict | None = None,
        sent_image_b64: str = '',
        prompt: str = '',
    ) -> None:
        """Save a single step's screenshot and VLM response.

        Args:
            step: Zero-based step/iteration number.
            screenshot_b64: Base64-encoded PNG screenshot (chrome-cropped,
                pre-resize). Saved as step_NNN.png for full-resolution
                forensics.
            vlm_response: The VLM response dict (bounding boxes, actions, etc.).
                Never contains actual credential values.
            phase: Label like 'sign-in', 'cancel', 'resume'.
            scale_factor: When > 0, draw bounding box overlay and save as
                step_NNN_overlay.png alongside the original.
            diagnostics: Optional dict with coordinate pipeline data
                (window_bounds, display_scale, chrome_offset, etc.)
                for debugging click-position issues.
            sent_image_b64: Base64-encoded JPEG that was actually sent to the
                VLM (post-resize). Saved as step_NNN_sent.jpg.
            prompt: The system prompt sent to the VLM. Saved as
                step_NNN_prompt.txt.
        """
        if not self.enabled or not self._dir:
            return

        prefix = f'step_{step:03d}'

        # Save screenshot as PNG (full-res, chrome-cropped)
        try:
            png_path = self._dir / f'{prefix}.png'
            png_bytes = base64.b64decode(screenshot_b64)
            png_path.write_bytes(png_bytes)
        except Exception as exc:
            log.debug('Failed to save debug screenshot step %d: %s', step, exc)

        # Save the actual image sent to VLM (post-resize JPEG)
        if sent_image_b64:
            try:
                sent_path = self._dir / f'{prefix}_sent.jpg'
                sent_bytes = base64.b64decode(sent_image_b64)
                sent_path.write_bytes(sent_bytes)
            except Exception as exc:
                log.debug('Failed to save sent image step %d: %s', step, exc)

        # Save the prompt sent to VLM
        if prompt:
            try:
                prompt_path = self._dir / f'{prefix}_prompt.txt'
                prompt_path.write_text(prompt)
            except Exception as exc:
                log.debug('Failed to save prompt step %d: %s', step, exc)

        # Save VLM response as JSON
        try:
            meta = {
                'step': step,
                'phase': phase,
                'timestamp': time.time(),
            }
            if step == 0 and self._metadata:
                meta['job_metadata'] = self._metadata
            if vlm_response is not None:
                meta['vlm_response'] = vlm_response
            if diagnostics is not None:
                meta['diagnostics'] = diagnostics
            json_path = self._dir / f'{prefix}.json'
            json_path.write_text(json.dumps(meta, indent=2, default=str))
        except Exception as exc:
            log.debug('Failed to save debug metadata step %d: %s', step, exc)

        # Save bbox overlay (drawn on VLM-sent image when available)
        if scale_factor > 0.0 and vlm_response is not None:
            if sent_image_b64:
                # Draw on the actual image the VLM saw (boxes are in sent-image space)
                overlay_bytes = _draw_bbox_overlay(
                    sent_image_b64, vlm_response, 1.0,
                )
            else:
                # Fallback: draw on original with scale_factor
                overlay_bytes = _draw_bbox_overlay(
                    screenshot_b64, vlm_response, scale_factor,
                )
            if overlay_bytes:
                overlay_path = self._dir / f'{prefix}_overlay.png'
                overlay_path.write_bytes(overlay_bytes)

    def cleanup_success(self) -> None:
        """Delete the trace folder (job succeeded, no forensics needed).

        When AGENT_DEBUG_KEEP_ALL=1 is set, successful traces are preserved
        so operators can periodically audit why some jobs take too many steps.
        """
        if not self._dir or not self._dir.exists():
            return
        keep_all = os.environ.get('AGENT_DEBUG_KEEP_ALL', '0')
        if keep_all and keep_all != '0':
            log.info('Keeping debug trace for successful job %s (AGENT_DEBUG_KEEP_ALL)',
                     self.job_id)
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
