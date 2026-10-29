import { expect, test } from 'bun:test';
import { budget, evaluate, parseRows } from './table.mjs';
import { readFileSync } from 'node:fs';
const rows = parseRows(JSON.parse(readFileSync('ratchet/rows.json', 'utf8')));
for (const [id, main, regression, limit] of [
  ['payload-usage-bytes', 1000, 1100, 1064],
  ['bundle-usage-bytes', 400000, 403072, 402048],
  ['ship-ingest-rows-s', 10000, 7400, 7500],
  ['sessions-between-p95-ms', 10, 20, 12.5],
  ['session-disk-bytes-10k', 10000, 10300, 10200],
  ['ship-replay-lag-ms', 100, 200, 125],
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
test('CLI enforces synthetic payload, bundle, query, disk, ingest and lag regressions', () => {
  mkdirSync('.local', { recursive: true });
  const dir = mkdtempSync(resolve('.local/r1-probe-'));
  const cases = ['payload-usage-bytes', 'bundle-usage-bytes', 'sessions-between-p95-ms', 'session-disk-bytes-10k', 'ship-ingest-rows-s', 'ship-replay-lag-ms'].map(id => rows.find(r => r.id === id));
  const values = [1000, 400000, 10, 10000, 10000, 100];
  const run = (cmd: string[]) => spawnSync(cmd[0]!, cmd.slice(1), { cwd: dir, encoding: 'utf8', env: { ...process.env, RATCHET_BASE_REF: 'HEAD', RATCHET_MEASURE_REF: 'HEAD', GITHUB_STEP_SUMMARY: '', GITHUB_EVENT_PATH: '' } });
  try {
    mkdirSync(join(dir, 'ratchet'));
    writeFileSync(join(dir, 'ratchet/rows.json'), JSON.stringify({ schema: 1, rows: cases.map((r, i) => ({ ...r, command: `node -e 'console.log(JSON.parse(require("fs").readFileSync("values.json"))[${i}])'` })) }));
    writeFileSync(join(dir, 'values.json'), JSON.stringify(values));
    writeFileSync(join(dir, 'package.json'), '{"name":"r1-synthetic","dependencies":{}}');
    for (const cmd of [['bun', 'install'], ['git', 'init', '-q'], ['git', 'add', '.'], ['git', '-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', 'commit', '-qm', 'base']]) expect(run(cmd).status).toBe(0);
    const judge = ['node', resolve('ratchet/table.mjs'), 'ratchet/rows.json'];
    expect(run(judge).status).toBe(0);
    for (const [i, value] of [1100, 403072, 20, 10300, 7400, 200].entries()) {
      const changed = [...values]; changed[i] = value;
      writeFileSync(join(dir, 'values.json'), JSON.stringify(changed));
      const result = run(judge);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(cases[i].id);
      expect(result.stderr).toContain(i === 4 ? 'below floor' : 'over budget');
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
