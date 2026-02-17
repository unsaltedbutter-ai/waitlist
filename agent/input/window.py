"""
macOS window management via pyobjc.

Listing windows, getting bounds, focusing apps, and
human-like window resizing (drag, not programmatic snap).
"""

from __future__ import annotations

import time

import Quartz
from AppKit import NSRunningApplication, NSWorkspace

from . import mouse


def list_windows(app_name: str | None = None, pid: int | None = None) -> list[dict]:
    """
    List visible windows via CGWindowListCopyWindowInfo.

    Returns list of dicts: {id, app, title, pid, x, y, width, height}
    Optionally filtered by app_name (case-insensitive substring match)
    and/or pid (exact match). When both are given, both must match.
    """
    options = Quartz.kCGWindowListOptionOnScreenOnly | Quartz.kCGWindowListExcludeDesktopElements
    window_list = Quartz.CGWindowListCopyWindowInfo(options, Quartz.kCGNullWindowID)

    results = []
    for win in window_list:
        owner = win.get(Quartz.kCGWindowOwnerName, '')
        title = win.get(Quartz.kCGWindowName, '')
        layer = win.get(Quartz.kCGWindowLayer, 0)
        bounds = win.get(Quartz.kCGWindowBounds, {})
        owner_pid = win.get(Quartz.kCGWindowOwnerPID, 0)

        # Skip non-standard windows (menubar, dock, system UI)
        if layer != 0:
            continue

        # Skip windows with no title (usually invisible helper windows)
        if not title:
            continue

        if app_name and app_name.lower() not in owner.lower():
            continue

        if pid is not None and owner_pid != pid:
            continue

        results.append({
            'id': win.get(Quartz.kCGWindowNumber, 0),
            'app': owner,
            'title': title,
            'pid': owner_pid,
            'x': int(bounds.get('X', 0)),
            'y': int(bounds.get('Y', 0)),
            'width': int(bounds.get('Width', 0)),
            'height': int(bounds.get('Height', 0)),
        })

    return results


def get_window_bounds(
    app_name: str,
    title_contains: str | None = None,
    pid: int | None = None,
) -> dict | None:
    """
    Get bounds of a specific window.
    Returns first match: {id, app, title, pid, x, y, width, height} or None.
    When pid is given, only windows owned by that process are considered.
    """
    windows = list_windows(app_name, pid=pid)
    for win in windows:
        if title_contains is None:
            return win
        if title_contains.lower() in win['title'].lower():
            return win
    return None


def focus_window(app_name: str) -> bool:
    """
    Bring an app to the foreground by name.
    Returns True if the app was found and activated.

    WARNING: If multiple instances of the app are running, this may
    activate the wrong one. Prefer focus_window_by_pid() when you
    have a specific PID.
    """
    workspace = NSWorkspace.sharedWorkspace()
    apps = workspace.runningApplications()

    for app in apps:
        name = app.localizedName()
        if name and app_name.lower() in name.lower():
            # NSApplicationActivateIgnoringOtherApps = 1 << 1
            app.activateWithOptions_(1 << 1)
            # Give macOS a moment to bring the window forward
            time.sleep(0.3)
            return True

    return False


def focus_window_by_pid(pid: int) -> bool:
    """
    Bring a specific process to the foreground by PID.
    Safe when multiple instances of the same app are running.
    Returns True if the process was found and activated.
    """
    app = NSRunningApplication.runningApplicationWithProcessIdentifier_(pid)
    if app is None:
        return False
    app.activateWithOptions_(1 << 1)
    time.sleep(0.3)
    return True


def resize_window_by_drag(
    app_name: str,
    width: int,
    height: int,
    title_contains: str | None = None,
    fast: bool = False,
) -> bool:
    """
    Resize a window by dragging its bottom-right corner.
    Human-like: Bezier drag, not programmatic snap.
    Returns True if the window was found and drag was attempted.

    fast: minimal timing (for session setup, not page interaction)
    """
    bounds = get_window_bounds(app_name, title_contains)
    if bounds is None:
        return False

    # Focus the window first
    focus_window(app_name)
    time.sleep(0.05 if fast else 0.2)

    # Current bottom-right corner (in screen points)
    current_br_x = bounds['x'] + bounds['width']
    current_br_y = bounds['y'] + bounds['height']

    # Target bottom-right corner
    target_br_x = bounds['x'] + width
    target_br_y = bounds['y'] + height

    # Drag from current corner to target corner
    # Offset slightly inward from the exact corner to grab the resize handle
    grab_x = current_br_x - 3
    grab_y = current_br_y - 3

    mouse.drag(grab_x, grab_y, target_br_x, target_br_y, fast=fast)
    return True


def get_retina_scale() -> float:
    """
    Detect the display scale factor (1.0 for non-Retina, 2.0 for Retina).
    Uses the main display's backing scale factor.
    """
    main_id = Quartz.CGMainDisplayID()
    mode = Quartz.CGDisplayCopyDisplayMode(main_id)
    if mode is None:
        return 1.0

    pixel_width = Quartz.CGDisplayModeGetPixelWidth(mode)
    point_width = Quartz.CGDisplayModeGetWidth(mode)

    if point_width == 0:
        return 1.0

    return pixel_width / point_width
