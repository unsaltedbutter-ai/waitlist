"""Global GUI lock for the Mac Studio display.

Independent from the Mac Mini agent's gui_lock. The Mac Studio has its
own display, mouse, and keyboard, so this lock serializes only TTS Agent
GUI actions (Chrome text extraction).

Usage:
    from tts_agent.gui_lock import gui_lock

    with gui_lock:
        focus_window_by_pid(session.pid)
        keyboard.hotkey('command', 'a')
"""

import threading

gui_lock = threading.Lock()
