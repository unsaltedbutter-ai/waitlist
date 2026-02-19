"""VLM-guided playbook recording.

Provides an automated recording system where a VLM analyzes screenshots
and drives cancel/resume flows, producing playbook JSON files compatible
with the existing executor.
"""

from agent.recording.prompts import (
    build_cancel_prompt,
    build_resume_prompt,
    build_signin_prompt,
)
from agent.recording.recorder import PlaybookRecorder
from agent.recording.vlm_client import VLMClient

__all__ = [
    'VLMClient',
    'PlaybookRecorder',
    'build_signin_prompt',
    'build_cancel_prompt',
    'build_resume_prompt',
]
