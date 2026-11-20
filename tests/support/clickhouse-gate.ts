import { beforeAll as bunBeforeAll, test as bunTest } from 'bun:test';
import { clickhouseBinary } from '../../src/lib/local-clickhouse';

/** Printed by tests/preload.ts with the count and names of every test this gate skipped. */
export const CLICKHOUSE_SKIP_REASON = 'no `clickhouse` binary on PATH (or TOKENLAYER_SKIP_IT=1)';
export const clickhouseAbsent = clickhouseBinary() === null;

const shared = globalThis as { __tokenlayerClickHouseSkips?: string[] };
/** Names skipped by this gate, shared with the preload across test files. */
export const clickhouseSkips = (shared.__tokenlayerClickHouseSkips ??= []);

/**
 * `test` for files where every test starts a real local ClickHouse. Without the binary each
 * test is skipped and recorded, never passed; CI has the binary and its integration row
 * refuses any skip.
 */
export const test = ((name: string, ...rest: unknown[]) => {
  if (clickhouseAbsent) clickhouseSkips.push(name);
  return (bunTest.skipIf(clickhouseAbsent) as (...args: unknown[]) => void)(name, ...rest);
}) as typeof bunTest;

/** `beforeAll` that does not start ClickHouse when every test in the file is skipped. */
export const beforeAll = ((...args: Parameters<typeof bunBeforeAll>) => {
  if (!clickhouseAbsent) bunBeforeAll(...args);
}) as typeof bunBeforeAll;
