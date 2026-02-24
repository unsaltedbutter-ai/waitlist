import { describe, it, expect } from "vitest";
import faqData from "@/data/faq.json";

describe("faq.json", () => {
  it("is a non-empty array", () => {
    expect(Array.isArray(faqData)).toBe(true);
    expect(faqData.length).toBeGreaterThan(0);
  });

  it("every entry has id, question, and answer as non-empty strings", () => {
    for (const item of faqData) {
      expect(typeof item.id).toBe("string");
      expect(item.id.length).toBeGreaterThan(0);
      expect(typeof item.question).toBe("string");
      expect(item.question.length).toBeGreaterThan(0);
      expect(typeof item.answer).toBe("string");
      expect(item.answer.length).toBeGreaterThan(0);
    }
  });

  it("all ids are unique", () => {
    const ids = faqData.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("no entry contains em dashes", () => {
    for (const item of faqData) {
      expect(item.question).not.toContain("\u2014");
      expect(item.answer).not.toContain("\u2014");
    }
  });
});
