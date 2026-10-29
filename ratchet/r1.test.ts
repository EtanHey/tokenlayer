import { expect, test } from 'bun:test';
import { budget, evaluate, parseRows } from './table.mjs';
import { readFileSync } from 'node:fs';
const rows = parseRows(JSON.parse(readFileSync('ratchet/rows.json', 'utf8')));
for (const [id, main, regression, limit] of [
  ['payload-usage-bytes', 1000, 1100, 1064],
  ['bundle-usage-bytes', 400000, 403072, 402048],
  ['sessions-between-read_rows', 10000, 30000, 10200],
  ['sessions-between-memory_usage', 10000, 10600, 10500],
  ['session-active-parts', 2, 3, 2],
  ['ship-insert-batches', 4, 5, 4],
  ['ship-insert-batch-1-rows', 13976, 13975, 13976],
  ['session-disk-bytes-10k', 10000, 10300, 10200],
] as const) test(`${id}: synthetic regression fails and exact budget passes`, () => {
  const row = rows.find(r => r.id === id);
  expect(row).toBeDefined();
  expect(budget(row, main)).toBe(limit);
  expect(evaluate(row, regression, main)).toBe(false);
  expect(evaluate(row, limit, main)).toBe(true);
  expect(evaluate(row, null, main)).toBe(false);
});
test('small bundles allow only 1%; missing baseline and malformed policies fail closed', () => {
  const row = rows.find(r => r.id === 'bundle-usage-bytes');
  expect(budget(row, 1000)).toBe(1010);
  expect(evaluate(row, 1000, undefined)).toBe(false);
  for (const growth of [-1, NaN, Infinity]) expect(() => parseRows({ schema: 1, rows: [{ ...row, growth }] })).toThrow();
});

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
test('CLI enforces synthetic payload, bundle, read_rows, disk, parts and insert-batch regressions', () => {
  mkdirSync('.local', { recursive: true });
  const dir = mkdtempSync(resolve('.local/r1-probe-'));
  const cases = ['payload-usage-bytes', 'bundle-usage-bytes', 'sessions-between-read_rows', 'session-disk-bytes-10k', 'session-active-parts', 'ship-insert-batch-1-rows'].map(id => rows.find(r => r.id === id));
  const values = [1000, 400000, 10000, 10000, 2, 13976];
  const run = (cmd: string[]) => spawnSync(cmd[0]!, cmd.slice(1), { cwd: dir, encoding: 'utf8', env: { ...process.env, RATCHET_BASE_REF: 'HEAD', RATCHET_MEASURE_REF: 'HEAD', GITHUB_STEP_SUMMARY: '', GITHUB_EVENT_PATH: '' } });
  try {
    mkdirSync(join(dir, 'ratchet'));
    writeFileSync(join(dir, 'ratchet/rows.json'), JSON.stringify({ schema: 1, rows: cases.map((r, i) => ({ ...r, command: `node -e 'console.log(JSON.parse(require("fs").readFileSync("values.json"))[${i}])'` })) }));
    writeFileSync(join(dir, 'values.json'), JSON.stringify(values));
    writeFileSync(join(dir, 'package.json'), '{"name":"r1-synthetic","dependencies":{}}');
    for (const cmd of [['bun', 'install'], ['git', 'init', '-q'], ['git', 'add', '.'], ['git', '-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', 'commit', '-qm', 'base']]) expect(run(cmd).status).toBe(0);
    const judge = ['node', resolve('ratchet/table.mjs'), 'ratchet/rows.json'];
    expect(run(judge).status).toBe(0);
    for (const [i, value] of [1100, 403072, 30000, 10300, 3, 13975].entries()) {
      const changed = [...values]; changed[i] = value;
      writeFileSync(join(dir, 'values.json'), JSON.stringify(changed));
      const result = run(judge);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(cases[i].id);
      expect(result.stderr).toContain(i === 5 ? 'below floor' : 'over budget');
      if (i === 0) expect(result.stderr).toContain('+36 bytes over budget');
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 20000);

import { line } from './r1';
import { createHash } from 'node:crypto';
test('50k-line synthetic fixture is deterministic and fixed', () => {
  const hash = createHash('sha256');
  for (let i = 0; i < 50000; i++) hash.update(line(i) + '\n');
  expect(hash.digest('hex')).toBe('ed030351f809ba3f2c432f68c7ff915c018dc9da14223d50755c9c97123b7810');
});

test('deterministic query policy is tight; CI timing is report-only and M1 twins retain gates', () => {
  for (const name of ['sessions-between', 'burn-by-role', 'cache-misses']) {
    for (const metric of ['read_rows', 'read_bytes', 'result_rows', 'result_bytes', 'memory_usage']) {
      const row = rows.find(r => r.id === `${name}-${metric}`);
      expect(row?.runner).toBe('ci');
      expect(row?.reportOnly).not.toBe(true);
      expect(row?.growth).toBe(metric === 'memory_usage' ? 0.05 : 0.02);
      expect(evaluate(row, 30000, 10000)).toBe(false);
    }
  }
  for (const id of ['sessions-between-p95-ms', 'burn-by-role-p95-ms', 'cache-misses-p95-ms', 'ship-replay-lag-ms']) {
    const ci = rows.find(r => r.id === id), m1 = rows.find(r => r.id === `${id}-m1`);
    expect(ci?.reportOnly).toBe(true);
    expect(m1?.runner).toBe('m1');
    expect(m1?.reportOnly).not.toBe(true);
    expect(evaluate(m1, 20, 10)).toBe(false);
  }
  expect(rows.find(r => r.id === 'ship-ingest-rows-s')?.reportOnly).toBe(true);
});

import { clickhouseBinary, startLocalClickHouse } from '../tests/support/local-clickhouse';
import { queryMetrics } from './r1';
(clickhouseBinary() ? test : test.skip)('full-scan rewrite fails the declared sessions-between read_rows gate', async () => {
  const local = await startLocalClickHouse({ queryLog: true });
  try {
    const ch = local.client;
    await ch.exec('CREATE DATABASE IF NOT EXISTS tokenlayer');
    await ch.exec('CREATE TABLE tokenlayer.scan_rewrite (id UInt64) ENGINE=MergeTree ORDER BY id');
    await ch.exec('INSERT INTO tokenlayer.scan_rewrite SELECT number FROM numbers(50000)');
    await ch.exec('OPTIMIZE TABLE tokenlayer.scan_rewrite FINAL');
    const main = await queryMetrics(ch, 'SELECT sum(id) FROM tokenlayer.scan_rewrite WHERE id >= 1024 AND id < 2048');
    const rewritten = await queryMetrics(ch, 'SELECT sum(id) FROM tokenlayer.scan_rewrite');
    const row = rows.find(r => r.id === 'sessions-between-read_rows');
    expect(row).toBeDefined();
    expect(evaluate(row, main.read_rows, main.read_rows)).toBe(true);
    expect(rewritten.read_rows).toBeGreaterThan(main.read_rows * 3);
    expect(evaluate(row, rewritten.read_rows, main.read_rows)).toBe(false);
  } finally { await local.stop(); }
}, 45000);
