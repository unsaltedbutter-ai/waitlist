"""Global GUI lock for serializing mouse/keyboard/clipboard actions.

When multiple jobs run concurrently, each job's VLM inference, screenshot
capture, and OTP waits run in parallel. Only physical GUI actions (click,
type, paste, scroll) must be serialized because there is one mouse and
one keyboard. This module provides the single lock that all GUI-touching
code acquires.

Usage:
    from agent.gui_lock import gui_lock

    with gui_lock:
        focus_window_by_pid(session.pid)
        mouse.click(x, y)
"""

import threading

gui_lock = threading.Lock()
