import { describe, it, expect } from "vitest";
import { getJobStatusConfig } from "@/lib/job-status";

// JobStatusIndicator is a React component that delegates to getJobStatusConfig.
// Without jsdom/@testing-library, we test the logic layer that drives rendering:
//   - label displayed = config.userLabel ?? config.label
//   - pulse animation shown when config.pulse is truthy

describe("JobStatusIndicator display logic", () => {
  it("each known status maps to a non-empty display label", () => {
    const statuses = [
      "pending",
      "dispatched",
      "outreach_sent",
      "snoozed",
      "active",
      "awaiting_otp",
      "completed_paid",
      "completed_eventual",
      "completed_reneged",
      "failed",
      "user_skip",
      "user_abandon",
      "implied_skip",
    ];

    for (const status of statuses) {
      const config = getJobStatusConfig(status);
      const displayLabel = config.userLabel ?? config.label;
      expect(displayLabel).toBeTruthy();
      expect(typeof displayLabel).toBe("string");
    }
  });

  it("user-facing label prefers userLabel over label", () => {
    const config = getJobStatusConfig("active");
    // Component does: config.userLabel ?? config.label
    const displayLabel = config.userLabel ?? config.label;
    expect(displayLabel).toBe("In progress");
    // But the internal label is "Active"
    expect(config.label).toBe("Active");
  });

  it("statuses without userLabel fall back to label", () => {
    const config = getJobStatusConfig("snoozed");
    expect(config.userLabel).toBeUndefined();
    const displayLabel = config.userLabel ?? config.label;
    expect(displayLabel).toBe("Snoozed");
  });

  it("active and awaiting_otp have pulse animation", () => {
    expect(getJobStatusConfig("active").pulse).toBe(true);
    expect(getJobStatusConfig("awaiting_otp").pulse).toBe(true);
  });

  it("non-active statuses do not have pulse animation", () => {
    const noPulse = [
      "pending",
      "dispatched",
      "outreach_sent",
      "snoozed",
      "completed_paid",
      "completed_eventual",
      "completed_reneged",
      "failed",
      "user_skip",
      "user_abandon",
      "implied_skip",
    ];

    for (const status of noPulse) {
      expect(getJobStatusConfig(status).pulse).toBeFalsy();
    }
  });

  it("unknown status falls back gracefully with raw status as label", () => {
    const config = getJobStatusConfig("some_future_status");
    const displayLabel = config.userLabel ?? config.label;
    expect(displayLabel).toBe("some_future_status");
    expect(config.badgeClass).toBeTruthy();
    expect(config.pulse).toBeFalsy();
  });
});
