import { describe, it, expect } from "vitest";
import {
  getJobStatusConfig,
  getJobStatusLabel,
  getJobStatusBadgeClass,
} from "@/lib/job-status";
import type { StatusConfig } from "@/lib/job-status";

describe("getJobStatusConfig", () => {
  const knownStatuses: Array<{
    status: string;
    expectedLabel: string;
    expectedUserLabel?: string;
    pulse?: boolean;
  }> = [
    { status: "pending", expectedLabel: "Pending", expectedUserLabel: "Queued" },
    { status: "dispatched", expectedLabel: "Dispatched", expectedUserLabel: "Starting" },
    { status: "outreach_sent", expectedLabel: "Outreach sent", expectedUserLabel: "Check DMs" },
    { status: "snoozed", expectedLabel: "Snoozed" },
    { status: "active", expectedLabel: "Active", expectedUserLabel: "In progress", pulse: true },
    {
      status: "awaiting_otp",
      expectedLabel: "Awaiting OTP",
      expectedUserLabel: "Check DMs (OTP needed)",
      pulse: true,
    },
    { status: "completed_paid", expectedLabel: "Paid" },
    { status: "completed_eventual", expectedLabel: "Paid (late)" },
    { status: "completed_reneged", expectedLabel: "Unpaid" },
    { status: "failed", expectedLabel: "Failed" },
    { status: "user_skip", expectedLabel: "Skipped" },
    { status: "user_abandon", expectedLabel: "Abandoned" },
    { status: "implied_skip", expectedLabel: "Implied skip" },
  ];

  it.each(knownStatuses)(
    "returns correct config for $status",
    ({ status, expectedLabel, expectedUserLabel, pulse }) => {
      const config = getJobStatusConfig(status);
      expect(config.label).toBe(expectedLabel);

      if (expectedUserLabel !== undefined) {
        expect(config.userLabel).toBe(expectedUserLabel);
      }

      if (pulse) {
        expect(config.pulse).toBe(true);
      } else {
        // pulse should be undefined or falsy for non-pulse statuses
        expect(config.pulse).toBeFalsy();
      }

      // Every config must have a non-empty badgeClass
      expect(config.badgeClass).toBeTruthy();
    },
  );

  it("active status has pulse enabled", () => {
    expect(getJobStatusConfig("active").pulse).toBe(true);
  });

  it("awaiting_otp status has pulse enabled", () => {
    expect(getJobStatusConfig("awaiting_otp").pulse).toBe(true);
  });

  it("pending status does NOT have pulse", () => {
    expect(getJobStatusConfig("pending").pulse).toBeFalsy();
  });

  it("returns default config with raw status as label for unknown status", () => {
    const config = getJobStatusConfig("totally_unknown_status");
    expect(config.label).toBe("totally_unknown_status");
    expect(config.badgeClass).toBeTruthy();
    expect(config.pulse).toBeFalsy();
  });

  it("returns default config for empty string status", () => {
    const config = getJobStatusConfig("");
    expect(config.label).toBe("");
    expect(config.badgeClass).toBeTruthy();
  });
});

describe("getJobStatusLabel", () => {
  it("returns the label for a known status", () => {
    expect(getJobStatusLabel("active")).toBe("Active");
    expect(getJobStatusLabel("failed")).toBe("Failed");
  });

  it("returns the raw status string for an unknown status", () => {
    expect(getJobStatusLabel("mystery")).toBe("mystery");
  });
});

describe("getJobStatusBadgeClass", () => {
  it("returns a non-empty badge class for known statuses", () => {
    expect(getJobStatusBadgeClass("active")).toContain("bg-blue-900");
    expect(getJobStatusBadgeClass("failed")).toContain("bg-red-900");
  });

  it("returns default badge class for unknown statuses", () => {
    expect(getJobStatusBadgeClass("nope")).toContain("bg-neutral-800");
  });
});
