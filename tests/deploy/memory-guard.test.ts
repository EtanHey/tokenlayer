import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { render } from '../../scripts/deploy/deploy';

const GiB = 1024 ** 3;
const xml = render(readFileSync('config/clickhouse.xml.template', 'utf8'), { HOME: '/Users/synthetic' });
const block = (tag: string, within = xml) => within.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))?.[1] ?? '';
const profiles = block('profiles');
const users = block('users');

test('the shared read user runs under the reader profile: 8 GiB per query, spills at 4 GiB, 8 GiB of temp disk', () => {
  expect(block('profile', block('tokenlayer', users))).toBe('reader');
  const reader = block('reader', profiles);
  expect(reader).toContain('<profile>default</profile>');
  expect(reader).toContain(`<max_memory_usage>${8 * GiB}</max_memory_usage>`);
  expect(reader).toContain(`<max_bytes_before_external_group_by>${4 * GiB}</max_bytes_before_external_group_by>`);
  expect(reader).toContain(`<max_bytes_before_external_sort>${4 * GiB}</max_bytes_before_external_sort>`);
  expect(reader).toContain(`<max_temporary_data_on_disk_size_for_query>${8 * GiB}</max_temporary_data_on_disk_size_for_query>`);
  // A caller may lower the cap, never raise it or set 0 (unlimited).
  expect(block('max_memory_usage', block('constraints', reader))).toBe(`<min>1</min><max>${8 * GiB}</max>`);
});

test('the writer user stays on the uncapped default profile with the same password source', () => {
  const writer = block('tokenlayer_writer', users);
  expect(block('profile', writer)).toBe('default');
  expect(block('default', profiles)).not.toContain('max_memory_usage');
  expect(writer).toContain('<password_sha256_hex from_env="CLICKHOUSE_PASSWORD_SHA256" hide_in_preprocessed="true"/>');
  expect(writer).toContain('<networks><ip>127.0.0.1</ip></networks>');
});

for (const agent of ['ship', 'drain']) test(`${agent} writes as tokenlayer_writer, overriding clickhouse.env`, () => {
  const plist = readFileSync(`launchd/com.tokenlayer.${agent}.plist.template`, 'utf8');
  expect(plist).toMatch(/<key>CLICKHOUSE_USER<\/key>\s*<string>tokenlayer_writer<\/string>/);
});
