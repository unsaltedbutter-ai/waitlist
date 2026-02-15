import { randomBytes } from "crypto";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import type { QueryResult } from "pg";

export const TEST_JWT_SECRET = "test-jwt-secret-for-unit-tests-only";

/** Create a temp keyfile with 32 random bytes; returns the path. */
export function createTestKeyFile(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "ub-test-"));
  const keyPath = path.join(dir, "test.key");
  writeFileSync(keyPath, randomBytes(32));
  return keyPath;
}

/** Create a temp keyfile with the specified number of bytes. */
export function createTestKeyFileWithSize(size: number): string {
  const dir = mkdtempSync(path.join(tmpdir(), "ub-test-"));
  const keyPath = path.join(dir, "test.key");
  writeFileSync(keyPath, randomBytes(size));
  return keyPath;
}

/** Build a pg-shaped QueryResult from rows. */
export function mockQueryResult<T extends Record<string, unknown>>(rows: T[]): QueryResult<T> {
  return {
    rows,
    rowCount: rows.length,
    command: "SELECT",
    oid: 0,
    fields: [],
  } as QueryResult<T>;
}
