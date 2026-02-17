"""
macOS window management via pyobjc.

Listing windows, getting bounds, focusing apps, and
human-like window resizing (drag, not programmatic snap).
"""

import time

import Quartz
from AppKit import NSRunningApplication, NSWorkspace

from . import mouse


def list_windows(app_name: str | None = None) -> list[dict]:
    """
    List visible windows via CGWindowListCopyWindowInfo.

    Returns list of dicts: {id, app, title, x, y, width, height}
    Optionally filtered by app_name (case-insensitive substring match).
    """
    options = Quartz.kCGWindowListOptionOnScreenOnly | Quartz.kCGWindowListExcludeDesktopElements
    window_list = Quartz.CGWindowListCopyWindowInfo(options, Quartz.kCGNullWindowID)

    results = []
    for win in window_list:
        owner = win.get(Quartz.kCGWindowOwnerName, '')
        title = win.get(Quartz.kCGWindowName, '')
        layer = win.get(Quartz.kCGWindowLayer, 0)
        bounds = win.get(Quartz.kCGWindowBounds, {})

        # Skip non-standard windows (menubar, dock, system UI)
        if layer != 0:
            continue

        # Skip windows with no title (usually invisible helper windows)
        if not title:
            continue

        if app_name and app_name.lower() not in owner.lower():
            continue

        results.append({
            'id': win.get(Quartz.kCGWindowNumber, 0),
            'app': owner,
            'title': title,
            'x': int(bounds.get('X', 0)),
            'y': int(bounds.get('Y', 0)),
            'width': int(bounds.get('Width', 0)),
            'height': int(bounds.get('Height', 0)),
        })

    return results


def get_window_bounds(
    app_name: str,
    title_contains: str | None = None,
) -> dict | None:
    """
    Get bounds of a specific window.
    Returns first match: {id, app, title, x, y, width, height} or None.
    """
    windows = list_windows(app_name)
    for win in windows:
        if title_contains is None:
            return win
        if title_contains.lower() in win['title'].lower():
            return win
    return None


def focus_window(app_name: str) -> bool:
    """
    Bring an app to the foreground.
    Returns True if the app was found and activated.
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


def resize_window_by_drag(
    app_name: str,
    width: int,
    height: int,
    title_contains: str | None = None,
) -> bool:
    """
    Resize a window by dragging its bottom-right corner.
    Human-like: Bezier drag, not programmatic snap.
    Returns True if the window was found and drag was attempted.
    """
    bounds = get_window_bounds(app_name, title_contains)
    if bounds is None:
        return False

    # Focus the window first
    focus_window(app_name)
    time.sleep(0.2)

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

    mouse.drag(grab_x, grab_y, target_br_x, target_br_y)
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
