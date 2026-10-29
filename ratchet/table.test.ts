import { test, expect } from 'bun:test';
import { evaluate } from './table.mjs';
const row = { id: 'count', direction: 'min', ceiling: 10 };
test('regression fails', () => expect(evaluate(row, 11, 12)).toBe(false));
test('ceiling breach fails', () => expect(evaluate(row, 9, 8)).toBe(false));
test('unchanged passes', () => expect(evaluate(row, 12, 12)).toBe(true));

test('max regression, missing values, and pass failures fail closed', () => {
  expect(evaluate({ direction: 'max', ceiling: 20 }, 12, 11)).toBe(false);
  expect(evaluate(row, null, 12)).toBe(false);
  expect(evaluate(row, 12, null)).toBe(false);
  expect(evaluate({ direction: 'pass' }, false, true)).toBe(false);
});

import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
test('CLI exits nonzero on regression and ceiling breach, zero when unchanged', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ratchet-test-'));
  const table = resolve('ratchet/table.mjs');
  const command = (args: string[]) => {
    const p = spawnSync(args[0]!, args.slice(1), { cwd: dir, encoding: 'utf8' });
    if (p.status !== 0) throw Error(p.stderr);
  };
  try {
    command(['git', 'init', '-q']);
    command(['git', 'config', 'user.email', 'synthetic@example.invalid']);
    command(['git', 'config', 'user.name', 'Synthetic']);
    mkdirSync(join(dir, 'ratchet'));
    writeFileSync(join(dir, 'ratchet/rows.json'), JSON.stringify({ schema: 1, rows: [{
      ...row, kind: 'unit', runner: 'ci', metric: 'count', command: 'cat value', timeout_s: 5,
    }] }));
    writeFileSync(join(dir, 'value'), '12');
    writeFileSync(join(dir, 'package.json'), '{"name":"ratchet-fixture","dependencies":{}}');
    command(['bun', 'install']);
    command(['git', 'add', '.']);
    command(['git', 'commit', '-qm', 'baseline']);
    for (const [value, status] of [['12', 0], ['11', 1], ['9', 1], ['missing', 1]] as const) {
      writeFileSync(join(dir, 'value'), value);
      const p = spawnSync('node', [table, 'ratchet/rows.json'], {
        cwd: dir, env: { ...process.env, RATCHET_BASE_REF: 'HEAD', GITHUB_STEP_SUMMARY: '' },
      });
      expect(p.status).toBe(status);
    }
    // Exercise the full CLI comparison path with a numeric timing policy.
    const policy = JSON.parse(readFileSync(join(dir, 'ratchet/rows.json'), 'utf8'));
    policy.rows[0].maxRegression = 0.25;
    policy.rows[0].ceiling = 5;
    writeFileSync(join(dir, 'ratchet/rows.json'), JSON.stringify(policy));
    writeFileSync(join(dir, 'value'), '20');
    command(['git', 'add', '.']);
    command(['git', 'commit', '-qm', 'relative baseline']);
    for (const [value, status] of [['14', 1], ['18', 0], ['4', 1], ['15', 0]] as const) {
      writeFileSync(join(dir, 'value'), value);
      const p = spawnSync('node', [table, 'ratchet/rows.json'], {
        cwd: dir, env: { ...process.env, RATCHET_BASE_REF: 'HEAD', GITHUB_STEP_SUMMARY: '' },
      });
      expect(p.status).toBe(status);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

const throughput = { direction: 'min', ceiling: 5, maxRegression: 0.25 };
test('relative throughput: more than 25% slower fails', () => expect(evaluate(throughput, 14, 20)).toBe(false));
test('relative throughput: 10% slower passes', () => expect(evaluate(throughput, 18, 20)).toBe(true));
test('relative throughput: sanity floor fails', () => expect(evaluate(throughput, 4, 5)).toBe(false));
test('relative throughput: exactly 25% slower passes', () => expect(evaluate(throughput, 15, 20)).toBe(true));
