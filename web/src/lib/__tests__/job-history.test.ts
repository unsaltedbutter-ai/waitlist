import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockQueryResult } from "@/__test-utils__/fixtures";

vi.mock("@/lib/db", () => ({
  query: vi.fn(),
}));

import { query } from "@/lib/db";
import { recordStatusChange } from "@/lib/job-history";

const mockQuery = vi.mocked(query);

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue(mockQueryResult([]));
});

describe("recordStatusChange", () => {
  it("inserts a row into job_status_history with all fields", async () => {
    await recordStatusChange("job-123", "pending", "dispatched", "agent");

    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockQuery).toHaveBeenCalledWith(
      "INSERT INTO job_status_history (job_id, from_status, to_status, changed_by) VALUES ($1, $2, $3, $4)",
      ["job-123", "pending", "dispatched", "agent"]
    );
  });

  it("allows null from_status for initial job creation", async () => {
    await recordStatusChange("job-456", null, "pending", "cron");

    expect(mockQuery).toHaveBeenCalledWith(
      "INSERT INTO job_status_history (job_id, from_status, to_status, changed_by) VALUES ($1, $2, $3, $4)",
      ["job-456", null, "pending", "cron"]
    );
  });

  it("defaults changed_by to 'system'", async () => {
    await recordStatusChange("job-789", "active", "completed_paid");

    expect(mockQuery).toHaveBeenCalledWith(
      "INSERT INTO job_status_history (job_id, from_status, to_status, changed_by) VALUES ($1, $2, $3, $4)",
      ["job-789", "active", "completed_paid", "system"]
    );
  });

  it("uses a custom query function when provided", async () => {
    const txQuery = vi.fn().mockResolvedValue(mockQueryResult([]));

    await recordStatusChange("job-tx", "pending", "dispatched", "agent", txQuery);

    expect(txQuery).toHaveBeenCalledTimes(1);
    expect(txQuery).toHaveBeenCalledWith(
      "INSERT INTO job_status_history (job_id, from_status, to_status, changed_by) VALUES ($1, $2, $3, $4)",
      ["job-tx", "pending", "dispatched", "agent"]
    );
    // Default query should not have been called
    expect(mockQuery).not.toHaveBeenCalled();
  });
});
