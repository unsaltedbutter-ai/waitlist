import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockQueryResult } from "@/__test-utils__/fixtures";

vi.mock("@/lib/db", () => ({
  query: vi.fn(),
}));
vi.mock("@/lib/crypto", () => ({
  decrypt: vi.fn((buf: Buffer) => buf.toString().replace("enc:", "")),
  hashEmail: vi.fn((email: string) => "hash_" + email.trim().toLowerCase()),
}));

import { query } from "@/lib/db";
import { checkEmailBlocklist } from "@/lib/reneged";

beforeEach(() => {
  vi.mocked(query).mockReset();
});

describe("checkEmailBlocklist", () => {
  it("returns blocked when email has outstanding debt", async () => {
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ email_enc: Buffer.from("enc:bad@example.com") }])
    );
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ total_debt_sats: 3000 }])
    );

    const result = await checkEmailBlocklist("user-1", "netflix");
    expect(result.blocked).toBe(true);
    expect(result.debt_sats).toBe(3000);
  });

  it("returns not blocked when email has no reneged record", async () => {
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ email_enc: Buffer.from("enc:clean@example.com") }])
    );
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const result = await checkEmailBlocklist("user-1", "netflix");
    expect(result.blocked).toBe(false);
    expect(result.debt_sats).toBe(0);
  });

  it("returns not blocked when no credentials exist", async () => {
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const result = await checkEmailBlocklist("user-1", "netflix");
    expect(result.blocked).toBe(false);
    expect(result.debt_sats).toBe(0);

    // Should not have queried reneged_emails at all
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("returns not blocked when debt is zero", async () => {
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ email_enc: Buffer.from("enc:paid@example.com") }])
    );
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([{ total_debt_sats: 0 }])
    );

    const result = await checkEmailBlocklist("user-1", "netflix");
    expect(result.blocked).toBe(false);
    expect(result.debt_sats).toBe(0);
  });
});
