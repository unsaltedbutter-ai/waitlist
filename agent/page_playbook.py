"""Page-based playbook data structures.

A PagePlaybook represents all actions for a single page/screen state.
A FlowConfig defines the entry point and safety limits for a multi-page flow.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from agent.config import FLOWS_DIR, PAGES_DIR
from agent.playbook import PlaybookStep


# ---------------------------------------------------------------------------
# PagePlaybook
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class PagePlaybook:
    """Actions for a single page state. Pages are identified by hash, not position."""

    page_id: str
    service: str
    flows: tuple[str, ...]
    actions: tuple[PlaybookStep, ...]
    wait_after_sec: tuple[float, float]
    terminal: bool
    notes: str

    @staticmethod
    def from_file(path: Path) -> PagePlaybook:
        """Load a page playbook from a JSON file."""
        with open(path) as f:
            data = json.load(f)
        return PagePlaybook._from_dict(data)

    @staticmethod
    def load(page_id: str) -> PagePlaybook:
        """Load a page playbook by ID from the configured pages directory."""
        path = PAGES_DIR / f'{page_id}.json'
        if not path.exists():
            raise FileNotFoundError(f'Page playbook not found: {path}')
        return PagePlaybook.from_file(path)

    @staticmethod
    def _from_dict(data: dict) -> PagePlaybook:
        wait = data.get('wait_after_sec', [1.0, 2.0])
        if isinstance(wait, list):
            wait = tuple(wait)
        flows = data.get('flows', [])
        if isinstance(flows, list):
            flows = tuple(flows)
        return PagePlaybook(
            page_id=data['page_id'],
            service=data['service'],
            flows=flows,
            actions=tuple(PlaybookStep.from_dict(a) for a in data.get('actions', [])),
            wait_after_sec=wait,
            terminal=data.get('terminal', False),
            notes=data.get('notes', ''),
        )

    def to_dict(self) -> dict:
        """Serialize to a JSON-compatible dict."""
        d: dict = {
            'page_id': self.page_id,
            'service': self.service,
            'flows': list(self.flows),
            'actions': [a.to_dict() for a in self.actions],
        }
        if self.wait_after_sec != (1.0, 2.0):
            d['wait_after_sec'] = list(self.wait_after_sec)
        if self.terminal:
            d['terminal'] = True
        if self.notes:
            d['notes'] = self.notes
        return d


# ---------------------------------------------------------------------------
# FlowConfig
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class FlowConfig:
    """Entry point and safety limits for a multi-page flow."""

    service: str
    flow: str
    start_url: str
    max_pages: int
    version: int

    @staticmethod
    def from_file(path: Path) -> FlowConfig:
        """Load a flow config from a JSON file."""
        with open(path) as f:
            data = json.load(f)
        return FlowConfig(
            service=data['service'],
            flow=data['flow'],
            start_url=data['start_url'],
            max_pages=data.get('max_pages', 15),
            version=data.get('version', 1),
        )

    @staticmethod
    def load(service: str, flow: str) -> FlowConfig:
        """Load a flow config by service and flow name."""
        path = FLOWS_DIR / f'{service}_{flow}.json'
        if not path.exists():
            raise FileNotFoundError(f'Flow config not found: {path}')
        return FlowConfig.from_file(path)

    def to_dict(self) -> dict:
        return {
            'service': self.service,
            'flow': self.flow,
            'start_url': self.start_url,
            'max_pages': self.max_pages,
            'version': self.version,
        }
