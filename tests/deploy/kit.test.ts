import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { configureClient, render, backfillArgs } from '../../scripts/deploy/deploy';

mkdirSync('.local', { recursive: true });
test('hub password is generated once, private, and reused by both clients', () => {
  const home = mkdtempSync(join(process.cwd(), '.local/deploy-'));
  configureClient('m1', 'http://127.0.0.1:8123', home);
  const path = join(home, '.config/tokenlayer/clickhouse.env');
  const first = readFileSync(path, 'utf8');
  expect(first).toMatch(/^CLICKHOUSE_PASSWORD=[a-f0-9]{64}\n/);
  expect(statSync(path).mode & 0o777).toBe(0o600);
  configureClient('m1', 'http://127.0.0.1:8123', home);
  expect(readFileSync(path, 'utf8')).toBe(first);
  configureClient('m4', 'https://hub.example.ts.net:8123', home);
  expect(readFileSync(path, 'utf8')).toBe(first);
  expect(readFileSync(join(home, '.config/tokenlayer/ship.env'), 'utf8')).toContain('TOKENLAYER_MACHINE=m4\nCLICKHOUSE_URL=https://hub.example.ts.net:8123');
});
test('M4 refuses missing credentials and non-tailnet endpoints', () => {
  const home = mkdtempSync(join(process.cwd(), '.local/deploy-'));
  expect(() => configureClient('m4', 'http://hub.example.com:8123', home)).toThrow();
  expect(() => configureClient('m4', 'https://hub.example.ts.net:8123', home)).toThrow();
});
test('XML rendering escapes paths and rejects unresolved placeholders', () => {
  expect(render('<x>__HOME__</x>', { HOME: '/a&b/<c>' })).toBe('<x>/a&amp;b/&lt;c&gt;</x>');
  expect(() => render('__UNKNOWN__', {})).toThrow();
});
test('backfill uses a UTC cutoff and bounded rate; invalid inputs fail', () => {
  expect(backfillArgs(90, 2, new Date('2026-10-30T12:00:00Z'))).toEqual(['--backfill', '--since', '2026-08-01', '--rate-mb', '2']);
  for (const [days, rate] of [[0, 2], [90, 0], [NaN, 2], [90, Infinity]]) expect(() => backfillArgs(days, rate)).toThrow();
});
