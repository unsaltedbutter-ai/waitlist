import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockQueryResult } from "@/__test-utils__/fixtures";

vi.mock("@/lib/db", () => ({
  query: vi.fn(),
}));

import { query } from "@/lib/db";
import { GET } from "../route";

beforeEach(() => {
  vi.mocked(query).mockReset();
});

describe("GET /api/signup-questions", () => {
  it("returns all questions ordered by display_order", async () => {
    vi.mocked(query).mockResolvedValueOnce(
      mockQueryResult([
        { id: "full_name", label: "Full Name", field_type: "text", options: null, placeholder: "Your full name" },
        { id: "zip_code", label: "Zip Code", field_type: "text", options: null, placeholder: "00000" },
        { id: "birthdate", label: "Birthdate (MM/DD/YYYY)", field_type: "text", options: null, placeholder: "MM/DD/YYYY" },
        { id: "gender", label: "Gender", field_type: "select", options: ["Male", "Female", "Non-binary", "Prefer Not To Say"], placeholder: null },
      ])
    );

    const res = await GET();
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.questions).toHaveLength(4);
    expect(data.questions[0]).toEqual({
      id: "full_name",
      label: "Full Name",
      field_type: "text",
      options: null,
      placeholder: "Your full name",
    });
    expect(data.questions[3]).toEqual({
      id: "gender",
      label: "Gender",
      field_type: "select",
      options: ["Male", "Female", "Non-binary", "Prefer Not To Say"],
      placeholder: null,
    });
  });

  it("returns empty array when no questions exist", async () => {
    vi.mocked(query).mockResolvedValueOnce(mockQueryResult([]));

    const res = await GET();
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.questions).toEqual([]);
  });
});
