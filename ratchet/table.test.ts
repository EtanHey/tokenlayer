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

import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync } from 'node:fs';
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
        cwd: dir, env: { ...process.env, RATCHET_BASE_REF: 'HEAD', RATCHET_MEASURE_REF: 'HEAD', GITHUB_STEP_SUMMARY: '' },
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
        cwd: dir, env: { ...process.env, RATCHET_BASE_REF: 'HEAD', RATCHET_MEASURE_REF: 'HEAD', GITHUB_STEP_SUMMARY: '' },
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

// The PR deletes a real row and replaces its own judge with exit(0).
test('base judge rejects the reviewer row-deletion plus judge-edit probe', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ratchet-probe-'));
  try {
    cpSync('ratchet', join(dir, 'ratchet'), { recursive: true });
    const base = JSON.parse(readFileSync(join(dir, 'ratchet/rows.json'), 'utf8'));
    const candidate = { ...base, rows: base.rows.filter((r: any) => r.id !== 'admit-null-window') };
    writeFileSync(join(dir, 'ratchet/rows.json'), JSON.stringify(candidate));
    writeFileSync(join(dir, 'ratchet/table.mjs'), 'process.exit(0);');
    writeFileSync(join(dir, 'ratchet/rows.json'), JSON.stringify(base));
    for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', 'commit', '-qm', 'base']]) expect(spawnSync('git', args, { cwd: dir }).status).toBe(0);
    writeFileSync(join(dir, 'ratchet/rows.json'), JSON.stringify(candidate));
    const judge = spawnSync('node', [resolve('ratchet/table.mjs'), 'ratchet/rows.json'], { cwd: dir, encoding: 'utf8', env: { ...process.env, RATCHET_BASE_REF: 'HEAD', RATCHET_MEASURE_REF: 'HEAD', GITHUB_EVENT_PATH: '' } });
    expect(judge.status).toBe(1);
    expect(judge.stderr).toContain('row removed or loosened: admit-null-window');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

import { checkRows, raisedFloor } from './guard.mjs';
test('row policy requires label AND exact per-row disclosure; raising never lowers', () => {
  const old = { ...row, command: 'bun test', kind: 'real', runner: 'ci', timeout_s: 5 };
  for (const patch of [{ ceiling: 9 }, { command: 'true' }, { kind: 'unit' }, { runner: 'm1' }]) {
    const next = { ...old, ...patch };
    const body = `ratchet-change: count ${Object.entries(patch).map(([k,v]) => `${k}=${JSON.stringify(v)}`).join(' ')}`;
    for (const pr of [{ body }, { labels: [{ name: 'ratchet-change' }] }]) expect(() => checkRows([old], [next], { pull_request: pr })).toThrow();
    expect(() => checkRows([old], [next], { pull_request: { body, labels: [{ name: 'ratchet-change' }] } })).not.toThrow();
  }
  expect(raisedFloor(15, 25)).toBe(20);
  expect(raisedFloor(20, 15)).toBe(20);
  expect(() => raisedFloor(15, NaN)).toThrow();
});

test('max growth cannot silently loosen existing policy', () => {
  const old = { id: 'payload', direction: 'max', ceiling: 1000 };
  for (const patch of [{ allowance: 64 }, { growth: 0.25 }]) {
    expect(() => checkRows([old], [{ ...old, ...patch }])).toThrow('row removed or loosened');
    expect(() => checkRows([{ ...old, ...patch }], [old])).toThrow('row removed or loosened');
  }
});
