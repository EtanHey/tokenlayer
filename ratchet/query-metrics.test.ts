import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseRows, evaluate } from './table.mjs';
import { checkRows } from './guard.mjs';
import { startLocalClickHouse, clickhouseBinary } from '../tests/support/local-clickhouse';
import { queryMetrics } from './r1';
import { pairedSamples } from './paired.mjs';

const policy = { id: 'latency', metric: 'latency', kind: 'unit', runner: 'ci', direction: 'max',
  ceiling: 100, growth: 0.25, command: 'cat value', timeout_s: 10, reportOnly: true };
test('reportOnly must be a boolean', () => {
  for (const reportOnly of ['true', 1, null]) expect(() => parseRows({ schema: 1, rows: [{ ...policy, reportOnly }] })).toThrow();
});
test('report-only changes require existing per-row disclosure gate', () => {
  const { reportOnly: _, ...implicitGate } = policy;
  for (const base of [implicitGate, { ...policy, reportOnly: false }]) {
    const body = 'ratchet-change: latency reportOnly=true';
    for (const pull_request of [{ body }, { labels: [{ name: 'ratchet-change' }] }, {}]) {
      expect(() => checkRows([base], [policy], { pull_request })).toThrow('row removed or loosened');
    }
  }
  const base = { ...policy, reportOnly: false };
  expect(() => checkRows([base], [policy], { pull_request: { labels: [{ name: 'ratchet-change' }], body: 'ratchet-change: latency reportOnly=true' } })).not.toThrow();
});
test('CI report-only row measures and displays regression, gated row still fails', () => {
  mkdirSync('.local', { recursive: true });
  const dir = mkdtempSync(resolve('.local/report-probe-'));
  const run = (args: string[]) => spawnSync(args[0]!, args.slice(1), { cwd: dir, encoding: 'utf8', env: {
    ...process.env, RATCHET_BASE_REF: 'HEAD', RATCHET_MEASURE_REF: 'HEAD', GITHUB_EVENT_PATH: '', GITHUB_STEP_SUMMARY: '', GITHUB_OUTPUT: '',
  } });
  try {
    mkdirSync(join(dir, 'ratchet'));
    writeFileSync(join(dir, 'ratchet/rows.json'), JSON.stringify({ schema: 1, rows: [policy] }));
    writeFileSync(join(dir, 'value'), '10');
    writeFileSync(join(dir, 'package.json'), '{"name":"report-probe","dependencies":{}}');
    for (const cmd of [['bun', 'install'], ['git', 'init', '-q'], ['git', 'add', '.'], ['git', '-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', 'commit', '-qm', 'baseline']]) expect(run(cmd).status).toBe(0);
    writeFileSync(join(dir, 'value'), '90');
    const table = ['node', resolve('ratchet/table.mjs'), 'ratchet/rows.json'];
    const report = run(table);
    expect(report.status).toBe(0);
    expect(report.stdout).toContain('| 10 | 90 | 12.5 | +80 | REPORT ONLY |');
    writeFileSync(join(dir, 'value'), 'missing');
    expect(run(table).status).toBe(1); // collection failures still fail closed
    writeFileSync(join(dir, 'ratchet/rows.json'), JSON.stringify({ schema: 1, rows: [{ ...policy, reportOnly: false }] }));
    writeFileSync(join(dir, 'value'), '10');
    for (const cmd of [['git', 'add', '.'], ['git', '-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', 'commit', '-qm', 'gated']]) expect(run(cmd).status).toBe(0);
    writeFileSync(join(dir, 'value'), '90');
    const failure = run(table);
    expect(failure.status).toBe(1);
    expect(failure.stderr).toContain('over budget');
    writeFileSync(join(dir, 'ratchet/rows.json'), JSON.stringify({ schema: 1, rows: [policy] }));
    const demotion = run(table);
    expect(demotion.status).toBe(1);
    expect(demotion.stderr).toContain('row removed or loosened: latency');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('ingest sampler alternates five base/PR pairs and compares medians', () => {
  const calls: string[] = [];
  const measurements = { base: [10, 12, 999, 11, 9], candidate: [9, 11, 8, 10, 1000] };
  const result = pairedSamples(side => { calls.push(side); return measurements[side].shift(); });
  expect(calls).toEqual(Array.from({ length: 5 }, () => ['base', 'candidate']).flat());
  expect(result.baseline).toBe(11);
  expect(result.value).toBe(10);
  expect(() => pairedSamples(() => null)).toThrow('missing paired ingest measurement');
});
(clickhouseBinary() ? test : test.skip)('real full scan fails tight read_rows gate; repeat stats stay within budgets', async () => {
  const local = await startLocalClickHouse({ queryLog: true });
  try {
    const ch = local.client;
    await ch.exec('CREATE DATABASE IF NOT EXISTS tokenlayer');
    await ch.exec('CREATE TABLE tokenlayer.scan_probe (id UInt64) ENGINE=MergeTree ORDER BY id');
    await ch.exec('INSERT INTO tokenlayer.scan_probe SELECT number FROM numbers(50000)');
    await ch.exec('OPTIMIZE TABLE tokenlayer.scan_probe FINAL');
    const selected = 'SELECT sum(id) FROM tokenlayer.scan_probe WHERE id >= 1024 AND id < 2048';
    const before = await queryMetrics(ch, selected);
    const repeat = await queryMetrics(ch, selected);
    for (const key of ['read_rows', 'read_bytes', 'result_rows', 'result_bytes']) expect(repeat[key]).toBe(before[key]);
    expect(evaluate({ direction: 'max', growth: 0.05, ceiling: 1e12 }, repeat.memory_usage, before.memory_usage)).toBe(true);
    const scan = await queryMetrics(ch, 'SELECT sum(id) FROM tokenlayer.scan_probe');
    expect(scan.read_rows).toBeGreaterThan(before.read_rows * 3);
    expect(evaluate({ direction: 'max', growth: 0.02, ceiling: 1e12 }, scan.read_rows, before.read_rows)).toBe(false);
    console.error(JSON.stringify({ full_scan_probe: { before, repeat, scan } }));
    for (const key of ['read_rows', 'read_bytes', 'result_rows', 'result_bytes', 'memory_usage']) expect(Number.isFinite(before[key])).toBe(true);
  } finally { await local.stop(); }
}, 45000);
