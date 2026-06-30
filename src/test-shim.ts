// Thin shim mapping the std-style assert helpers onto vitest, so test bodies
// ported from Deno stay readable. (Dev-only; never bundled into dist.)

import { expect } from "vitest";

export { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

export function assert(value: unknown, msg?: string): asserts value {
  expect(value, msg).toBeTruthy();
}

export function assertEquals<T>(actual: T, expected: T, msg?: string): void {
  expect(actual, msg).toEqual(expected);
}

export async function assertRejects(
  fn: () => Promise<unknown>,
  errOrMsg?: unknown,
  msg?: string,
): Promise<void> {
  const needle = typeof msg === "string" ? msg : typeof errOrMsg === "string" ? errOrMsg : undefined;
  await expect(fn()).rejects.toThrow(needle as string | undefined);
}
