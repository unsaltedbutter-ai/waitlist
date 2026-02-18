/**
 * Minimal CSV helpers. No external dependencies.
 */

/** Escape a single field per RFC 4180: wrap in quotes if it contains comma, quote, or newline. */
export function escapeCsvField(value: string): string {
  if (
    value.includes(",") ||
    value.includes('"') ||
    value.includes("\n") ||
    value.includes("\r")
  ) {
    return '"' + value.replace(/"/g, '""') + '"';
  }
  return value;
}

/** Join escaped fields into one CSV row (terminated with \r\n per RFC 4180). */
export function toCsvRow(fields: string[]): string {
  return fields.map(escapeCsvField).join(",") + "\r\n";
}

/** Build a complete CSV string from headers and rows. */
export function toCsv(headers: string[], rows: string[][]): string {
  return toCsvRow(headers) + rows.map(toCsvRow).join("");
}
