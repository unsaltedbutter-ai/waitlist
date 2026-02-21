"""Convert flat recordings to page-based playbooks.

Takes a flat playbook JSON + manifest (_manifest.json) produced by the recorder
and generates:
  - One PagePlaybook JSON per page (in PAGES_DIR)
  - One FlowConfig JSON (in FLOWS_DIR)
  - Hash DB entries in PageCache (for runtime page identification)
  - Ref screenshots copied to REF_SCREENSHOTS_DIR
"""

from __future__ import annotations

import json
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from PIL import Image

from agent.config import FLOWS_DIR, PAGES_DIR, REF_SCREENSHOTS_DIR
from agent.page_cache import PageCache
from agent.page_playbook import FlowConfig, PagePlaybook
from agent.playbook import PlaybookStep


# Actions that are page boundary markers, not executable page actions
_BOUNDARY_ACTIONS = frozenset({'navigate'})


@dataclass
class ConvertResult:
    """Summary of a recording-to-page conversion."""

    pages_created: int
    flow_config_path: Path
    page_paths: list[Path]
    ref_paths: list[Path]
    hashes_inserted: int


def _default_page_id(service: str, flow: str, page_index: int) -> str:
    """Generate a default page_id from service, flow, and index."""
    return f'{service}_{flow}_page_{page_index:02d}'


def _is_boundary_step(step: dict) -> bool:
    """True if this step is a page boundary marker (not a page action)."""
    if step.get('action') in _BOUNDARY_ACTIONS:
        return True
    # Checkpoint wait steps are phase transitions, not page actions
    if step.get('action') == 'wait' and step.get('checkpoint'):
        return True
    return False


def convert_recording(
    service: str,
    flow: str,
    playbook_path: Path,
    manifest_path: Path,
    ref_dir: Path,
    cache: PageCache,
    page_namer: Callable[[int, dict, list[dict]], str] | None = None,
) -> ConvertResult:
    """Convert a flat recording to page-based format.

    Args:
        service: Service name (e.g. 'netflix').
        flow: Flow type ('cancel' or 'resume').
        playbook_path: Path to flat playbook JSON.
        manifest_path: Path to _manifest.json.
        ref_dir: Directory containing step_XX.png reference screenshots.
        cache: PageCache instance for hash insertion.
        page_namer: Optional callback(page_index, page_manifest_entry, page_steps)
            that returns a custom page_id. If None, auto-generates IDs.

    Returns:
        ConvertResult with summary stats and paths.
    """
    # Load inputs
    with open(playbook_path) as f:
        playbook_data = json.load(f)
    with open(manifest_path) as f:
        manifest = json.load(f)

    flat_steps = playbook_data['steps']
    pages = manifest['pages']
    start_url = manifest.get('start_url', '')

    # Find start_url from the first navigate step if not in manifest
    if not start_url:
        for step in flat_steps:
            if step.get('action') == 'navigate' and step.get('url'):
                start_url = step['url']
                break

    if not start_url:
        raise ValueError('No start_url found in manifest or flat playbook')

    # Ensure output directories exist
    PAGES_DIR.mkdir(parents=True, exist_ok=True)
    FLOWS_DIR.mkdir(parents=True, exist_ok=True)
    REF_SCREENSHOTS_DIR.mkdir(parents=True, exist_ok=True)

    page_paths: list[Path] = []
    ref_paths: list[Path] = []
    hashes_inserted = 0

    for page_entry in pages:
        page_index = page_entry['page_index']
        step_start, step_end = page_entry['step_range']
        screenshot_file = page_entry.get('screenshot', '')

        # Extract steps for this page, filtering out boundary markers
        page_steps = []
        for i in range(step_start, step_end + 1):
            if i < len(flat_steps):
                step = flat_steps[i]
                if not _is_boundary_step(step):
                    page_steps.append(step)

        # Determine page_id
        if page_namer:
            page_id = page_namer(page_index, page_entry, page_steps)
        else:
            label = page_entry.get('label', '')
            if label:
                page_id = f'{service}_{label}'
            else:
                page_id = _default_page_id(service, flow, page_index)

        # Determine if terminal (last page in the flow)
        is_terminal = (page_index == len(pages) - 1)

        # Build PagePlaybook
        actions = tuple(PlaybookStep.from_dict(s) for s in page_steps)
        page_pb = PagePlaybook(
            page_id=page_id,
            service=service,
            flows=(flow,),
            actions=actions,
            wait_after_sec=(1.5, 3.0),
            terminal=is_terminal,
            notes=f'Converted from {playbook_path.name}, page {page_index}',
        )

        # Write page playbook JSON
        page_path = PAGES_DIR / f'{page_id}.json'
        with open(page_path, 'w') as f:
            json.dump(page_pb.to_dict(), f, indent=2)
            f.write('\n')
        page_paths.append(page_path)

        # Load ref screenshot and insert into hash cache
        if screenshot_file:
            screenshot_path = ref_dir / screenshot_file
            if screenshot_path.exists():
                img = Image.open(screenshot_path)
                cache.insert(page_id, service, [flow], img)
                hashes_inserted += 1

                # Copy ref screenshot
                ref_dest = REF_SCREENSHOTS_DIR / f'{page_id}.png'
                shutil.copy2(screenshot_path, ref_dest)
                ref_paths.append(ref_dest)

    # Write flow config
    flow_config = FlowConfig(
        service=service,
        flow=flow,
        start_url=start_url,
        max_pages=max(15, len(pages) * 2),
        version=1,
    )
    flow_path = FLOWS_DIR / f'{service}_{flow}.json'
    with open(flow_path, 'w') as f:
        json.dump(flow_config.to_dict(), f, indent=2)
        f.write('\n')

    return ConvertResult(
        pages_created=len(pages),
        flow_config_path=flow_path,
        page_paths=page_paths,
        ref_paths=ref_paths,
        hashes_inserted=hashes_inserted,
    )
