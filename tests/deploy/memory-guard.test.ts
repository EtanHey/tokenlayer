import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { clickhouseConfig, configureClient, render } from '../../scripts/deploy/deploy';
import { parseEnv } from '../../src/lib/env';

const GiB = 1024 ** 3;
mkdirSync('.local', { recursive: true });
const home = mkdtempSync(join(process.cwd(), '.local/memguard-'));
configureClient('m1', 'http://127.0.0.1:8123', home);
const writerPassword = parseEnv(readFileSync(join(home, '.config/tokenlayer/clickhouse-writer.env'), 'utf8')).CLICKHOUSE_PASSWORD!;
const xml = clickhouseConfig(home);
const block = (tag: string, within = xml) => within.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))?.[1] ?? '';
const profiles = block('profiles');
const users = block('users');

test('the shared read user runs under the reader profile: 8 GiB per query, spills at 4 GiB, 8 GiB of temp disk, windows read in order', () => {
  expect(block('profile', block('tokenlayer', users))).toBe('reader');
  const reader = block('reader', profiles);
  expect(reader).toContain('<profile>default</profile>');
  expect(reader).toContain(`<max_memory_usage>${8 * GiB}</max_memory_usage>`);
  expect(reader).toContain(`<max_bytes_before_external_group_by>${4 * GiB}</max_bytes_before_external_group_by>`);
  expect(reader).toContain(`<max_bytes_before_external_sort>${4 * GiB}</max_bytes_before_external_sort>`);
  expect(reader).toContain(`<max_temporary_data_on_disk_size_for_query>${8 * GiB}</max_temporary_data_on_disk_size_for_query>`);
  // Windows that follow the table order (v_session_events_context's stream windows) read in order instead of
  // sorting the whole table: the 1-day token sum drops from 4.7 to 1.7 GiB (R5).
  expect(reader).toContain('<optimize_read_in_window_order>1</optimize_read_in_window_order>');
  // A caller may lower the cap, never raise it or set 0 (unlimited).
  expect(block('max_memory_usage', block('constraints', reader))).toBe(`<min>1</min><max>${8 * GiB}</max>`);
});

test('the reader runs no DDL, and cannot turn it back on (security pre-review S3)', () => {
  const reader = block('reader', profiles);
  expect(reader).toContain('<allow_ddl>0</allow_ddl>');
  expect(block('allow_ddl', block('constraints', reader))).toBe('<readonly/>');
});

test('the writer user stays on the uncapped default profile, with its own password hash hidden from the preprocessed copy', () => {
  const writer = block('tokenlayer_writer', users);
  expect(block('profile', writer)).toBe('default');
  expect(block('default', profiles)).not.toContain('max_memory_usage');
  // The reader's password no longer opens the uncapped login: the writer hash comes from clickhouse-writer.env.
  expect(writer).not.toContain('from_env');
  expect(writer).toContain(`<password_sha256_hex hide_in_preprocessed="true">${createHash('sha256').update(writerPassword).digest('hex')}</password_sha256_hex>`);
  expect(block('tokenlayer', users)).toContain('<password_sha256_hex from_env="CLICKHOUSE_PASSWORD_SHA256" hide_in_preprocessed="true"/>');
  expect(writer).toContain('<networks><ip>127.0.0.1</ip></networks>');
});
test('the config cannot render without a writer hash', () => {
  expect(() => render(readFileSync('config/clickhouse.xml.template', 'utf8'), { HOME: '/Users/synthetic' })).toThrow('WRITERHASH');
});

for (const agent of ['ship', 'drain']) test(`${agent} writes as tokenlayer_writer, with the writer env loaded last`, () => {
  const plist = readFileSync(`launchd/com.tokenlayer.${agent}.plist.template`, 'utf8');
  expect(plist).toMatch(/<key>CLICKHOUSE_USER<\/key>\s*<string>tokenlayer_writer<\/string>/);
  expect(plist).toMatch(/__HOME__\/\.config\/tokenlayer\/clickhouse\.env:__HOME__\/\.config\/tokenlayer\/clickhouse-writer\.env<\/string>/);
});
