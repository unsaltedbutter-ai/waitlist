#!/usr/bin/env python3
"""Diagnostic: try multiple scroll approaches to find what works on this macOS."""

import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))

import Quartz
import pyautogui

print("Click on a scrollable window (e.g. Chrome with a long page) within 3 seconds...")
time.sleep(3)

pos = pyautogui.position()
print(f"Mouse at: {pos}")
print()

# Test 1: pyautogui.scroll
print("Test 1: pyautogui.scroll(-5)")
pyautogui.scroll(-5)
time.sleep(1)

print("Test 2: pyautogui.scroll(5)")
pyautogui.scroll(5)
time.sleep(1)

# Test 3: Quartz pixel units, kCGHIDEventTap
print("Test 3: Quartz kCGScrollEventUnitPixel, kCGHIDEventTap, -200px")
event = Quartz.CGEventCreateScrollWheelEvent(None, Quartz.kCGScrollEventUnitPixel, 1, -200)
if event is None:
    print("  EVENT IS NONE (creation failed)")
else:
    Quartz.CGEventPost(Quartz.kCGHIDEventTap, event)
time.sleep(1)

# Test 4: Quartz line units, kCGHIDEventTap
print("Test 4: Quartz kCGScrollEventUnitLine, kCGHIDEventTap, -10 lines")
event = Quartz.CGEventCreateScrollWheelEvent(None, Quartz.kCGScrollEventUnitLine, 1, -10)
if event is None:
    print("  EVENT IS NONE (creation failed)")
else:
    Quartz.CGEventPost(Quartz.kCGHIDEventTap, event)
time.sleep(1)

# Test 5: Quartz pixel units, kCGSessionEventTap
print("Test 5: Quartz kCGScrollEventUnitPixel, kCGSessionEventTap, -200px")
event = Quartz.CGEventCreateScrollWheelEvent(None, Quartz.kCGScrollEventUnitPixel, 1, -200)
if event is None:
    print("  EVENT IS NONE (creation failed)")
else:
    Quartz.CGEventPost(Quartz.kCGSessionEventTap, event)
time.sleep(1)

# Test 6: Quartz line units, kCGSessionEventTap
print("Test 6: Quartz kCGScrollEventUnitLine, kCGSessionEventTap, -10 lines")
event = Quartz.CGEventCreateScrollWheelEvent(None, Quartz.kCGScrollEventUnitLine, 1, -10)
if event is None:
    print("  EVENT IS NONE (creation failed)")
else:
    Quartz.CGEventPost(Quartz.kCGSessionEventTap, event)
time.sleep(1)

# Test 7: Quartz with explicit location
print("Test 7: Quartz pixel + setLocation to mouse position, kCGHIDEventTap, -200px")
event = Quartz.CGEventCreateScrollWheelEvent(None, Quartz.kCGScrollEventUnitPixel, 1, -200)
if event is None:
    print("  EVENT IS NONE (creation failed)")
else:
    Quartz.CGEventSetLocation(event, pos)
    Quartz.CGEventPost(Quartz.kCGHIDEventTap, event)
time.sleep(1)

print()
print("Done. Which test numbers scrolled the page?")
