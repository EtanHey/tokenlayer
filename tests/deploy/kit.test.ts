import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, statSync, chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { configureClient, render, backfillArgs, clickhouseConfig } from '../../scripts/deploy/deploy';
import { parseEnv } from '../../src/lib/env';

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
test('the writer gets its own password, generated once on the M1, private, never the reader\'s', () => {
  const home = mkdtempSync(join(process.cwd(), '.local/deploy-'));
  configureClient('m1', 'http://127.0.0.1:8123', home);
  const dir = join(home, '.config/tokenlayer');
  const first = readFileSync(join(dir, 'clickhouse-writer.env'), 'utf8');
  expect(first).toMatch(/^CLICKHOUSE_USER=tokenlayer_writer\nCLICKHOUSE_PASSWORD=[a-f0-9]{64}\n$/);
  expect(statSync(join(dir, 'clickhouse-writer.env')).mode & 0o777).toBe(0o600);
  const reader = parseEnv(readFileSync(join(dir, 'clickhouse.env'), 'utf8')).CLICKHOUSE_PASSWORD;
  expect(parseEnv(first).CLICKHOUSE_PASSWORD).not.toBe(reader);
  configureClient('m1', 'http://127.0.0.1:8123', home);
  configureClient('m4', 'https://hub.ts.net:8123', home);
  expect(readFileSync(join(dir, 'clickhouse-writer.env'), 'utf8')).toBe(first);
});
test('M4 refuses to configure until the writer password is copied from the M1', () => {
  const m1 = mkdtempSync(join(process.cwd(), '.local/deploy-'));
  configureClient('m1', 'http://127.0.0.1:8123', m1);
  const m4 = mkdtempSync(join(process.cwd(), '.local/deploy-'));
  mkdirSync(join(m4, '.config/tokenlayer'), { recursive: true, mode: 0o700 });
  writeFileSync(join(m4, '.config/tokenlayer/clickhouse.env'), readFileSync(join(m1, '.config/tokenlayer/clickhouse.env')), { mode: 0o600 });
  expect(() => configureClient('m4', 'https://hub.ts.net:8123', m4)).toThrow('clickhouse-writer.env');
});
test('a writer file holding the reader password is refused', () => {
  const home = mkdtempSync(join(process.cwd(), '.local/deploy-'));
  configureClient('m1', 'http://127.0.0.1:8123', home);
  const dir = join(home, '.config/tokenlayer');
  const reader = parseEnv(readFileSync(join(dir, 'clickhouse.env'), 'utf8')).CLICKHOUSE_PASSWORD;
  writeFileSync(join(dir, 'clickhouse-writer.env'), `CLICKHOUSE_USER=tokenlayer_writer\nCLICKHOUSE_PASSWORD=${reader}\n`, { mode: 0o600 });
  expect(() => configureClient('m1', 'http://127.0.0.1:8123', home)).toThrow('writer');
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
test('ClickHouse config renders the 15 GiB daemon reserve', () => {
  const home = mkdtempSync(join(process.cwd(), '.local/deploy-'));
  configureClient('m1', 'http://127.0.0.1:8123', home);
  const xml = clickhouseConfig(home);
  expect(xml).toContain(`<keep_free_space_bytes>${15 * 1024 ** 3}</keep_free_space_bytes>`);
});
test('backfill uses a UTC cutoff and bounded rate; invalid inputs fail', () => {
  expect(backfillArgs(90, 2, new Date('2026-10-30T12:00:00Z'))).toEqual(['--backfill', '--since', '2026-08-01', '--rate-mb', '2']);
  for (const [days, rate] of [[0, 2], [90, 0], [NaN, 2], [90, Infinity]]) expect(() => backfillArgs(days, rate)).toThrow();
});

test('reruns tighten existing config directory and env permissions', () => {
  const home = mkdtempSync(join(process.cwd(), '.local/deploy-'));
  configureClient('m1', 'http://127.0.0.1:8123', home);
  const dir = join(home, '.config/tokenlayer');
  chmodSync(dir, 0o755);
  for (const name of ['ship.env', 'clickhouse.env', 'clickhouse-writer.env']) chmodSync(join(dir, name), 0o644);
  configureClient('m1', 'http://127.0.0.1:8123', home);
  expect(statSync(dir).mode & 0o777).toBe(0o700);
  for (const name of ['ship.env', 'clickhouse.env', 'clickhouse-writer.env']) expect(statSync(join(dir, name)).mode & 0o777).toBe(0o600);
});
