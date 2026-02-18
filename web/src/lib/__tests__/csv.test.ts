import { describe, it, expect } from "vitest";
import { escapeCsvField, toCsvRow, toCsv } from "../csv";

describe("escapeCsvField", () => {
  it("returns plain string unchanged", () => {
    expect(escapeCsvField("hello")).toBe("hello");
  });

  it("returns empty string unchanged", () => {
    expect(escapeCsvField("")).toBe("");
  });

  it("wraps field containing comma in quotes", () => {
    expect(escapeCsvField("a,b")).toBe('"a,b"');
  });

  it("wraps field containing double quote and doubles internal quotes", () => {
    expect(escapeCsvField('say "hi"')).toBe('"say ""hi"""');
  });

  it("wraps field containing newline", () => {
    expect(escapeCsvField("line1\nline2")).toBe('"line1\nline2"');
  });

  it("wraps field containing carriage return", () => {
    expect(escapeCsvField("a\rb")).toBe('"a\rb"');
  });

  it("handles field with comma, quote, and newline together", () => {
    expect(escapeCsvField('a,"b"\nc')).toBe('"a,""b""\nc"');
  });

  it("does not wrap field with only spaces", () => {
    expect(escapeCsvField("  ")).toBe("  ");
  });

  it("handles numeric-looking strings", () => {
    expect(escapeCsvField("3000")).toBe("3000");
  });
});

describe("toCsvRow", () => {
  it("joins fields with commas and terminates with CRLF", () => {
    expect(toCsvRow(["a", "b", "c"])).toBe("a,b,c\r\n");
  });

  it("escapes fields that need it", () => {
    expect(toCsvRow(["ok", "has,comma", "fine"])).toBe('ok,"has,comma",fine\r\n');
  });

  it("handles single field", () => {
    expect(toCsvRow(["only"])).toBe("only\r\n");
  });

  it("handles empty fields array", () => {
    expect(toCsvRow([])).toBe("\r\n");
  });
});

describe("toCsv", () => {
  it("builds header row followed by data rows", () => {
    const csv = toCsv(["name", "value"], [["foo", "1"], ["bar", "2"]]);
    expect(csv).toBe("name,value\r\nfoo,1\r\nbar,2\r\n");
  });

  it("returns only headers when rows is empty", () => {
    const csv = toCsv(["a", "b"], []);
    expect(csv).toBe("a,b\r\n");
  });

  it("escapes values in both headers and rows", () => {
    const csv = toCsv(["col,1"], [["val,x"]]);
    expect(csv).toBe('"col,1"\r\n"val,x"\r\n');
  });
});
