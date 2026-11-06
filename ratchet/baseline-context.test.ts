import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

// Exercise table's real archive path inside an outer repo that ignores .local.
test('baseline owns its measured Git index and ignore policy, including symlink denial', () => {
  const dir = mkdtempSync(join(tmpdir(), 'baseline-context-'));
  const git = (...args: string[]) => {
    const p = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    if (p.status !== 0) throw Error(p.stderr);
    return p.stdout.trim();
  };
  try {
    git('init', '-q', '--template=');
    mkdirSync(join(dir, 'ratchet'));
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, '.gitignore'), '.local/\n/out\nsrc/forced\n');
    writeFileSync(join(dir, 'src/tracked'), 'original\r\n');
    writeFileSync(join(dir, 'src/forced'), 'tracked despite ignore\n');
    symlinkSync('tracked', join(dir, 'src/link'));
    writeFileSync(join(dir, 'package.json'), '{"name":"baseline-context","dependencies":{}}');
    expect(spawnSync('bun', ['install'], { cwd: dir }).status).toBe(0);
    // Actual Git operations, not canned row measurements. The same assertions
    // execute in the candidate and in table's freshly archived baseline.
    writeFileSync(join(dir, 'probe.mjs'), `
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
const git = (...args) => spawnSync('git', args, { encoding: 'utf8' });
assert.equal(realpathSync(git('rev-parse', '--show-toplevel').stdout.trim()), realpathSync(process.cwd()));
assert.equal(git('rev-parse', 'HEAD').stdout.trim(), process.env.EXPECTED_MEASURE_REF);
assert.equal(git('ls-files', '--error-unmatch', 'src/tracked', 'src/forced', 'src/link').status, 0);
assert.equal(git('status', '--porcelain', '--untracked-files=no').stdout, '');
assert.equal(readFileSync('src/tracked').toString('hex'), '6f726967696e616c0d0a');
assert.equal(git('check-ignore', '--quiet', resolve('src/denied')).status, 1);
assert.equal(git('check-ignore', '--quiet', resolve(realpathSync('alias'), 'denied')).status, 1);
assert.equal(git('check-ignore', '--quiet', resolve('out')).status, 0);
assert.equal(readFileSync('.gitignore', 'utf8'), '.local/\\n/out\\nsrc/forced\\n');
console.log('1');
`);
    symlinkSync('src', join(dir, 'alias'));
    writeFileSync(join(dir, 'ratchet/rows.json'), JSON.stringify({ schema: 1, rows: [{
      id: 'context', metric: 'Git assertions', command: 'node probe.mjs', direction: 'min',
      ceiling: 1, kind: 'unit', runner: 'ci', timeout_s: 10,
    }] }));
    git('add', '.');
    git('add', '-f', 'src/forced');
    git('-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', 'commit', '-qm', 'measured');
    const measured = git('rev-parse', 'HEAD');
    // A second commit means measure-ref must not accidentally become policy HEAD.
    writeFileSync(join(dir, 'policy-only'), 'not in measured archive');
    git('add', 'policy-only');
    git('-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', 'commit', '-qm', 'policy');
    const before = readFileSync(join(dir, 'src/tracked'));
    const p = spawnSync('node', [resolve('ratchet/table.mjs'), 'ratchet/rows.json'], {
      cwd: dir, encoding: 'utf8', env: { ...process.env, RATCHET_BASE_REF: 'HEAD',
        RATCHET_MEASURE_REF: measured, EXPECTED_MEASURE_REF: measured, GITHUB_EVENT_PATH: '',
        GITHUB_STEP_SUMMARY: '', GITHUB_OUTPUT: '' },
    });
    // Candidate uses its own HEAD; this deliberate mismatch fails closed too.
    expect(p.status).toBe(1);
    expect(p.stdout).toContain('| context | Git assertions | 1 | MISSING |');
    git('update-ref', 'HEAD', measured);
    git('read-tree', measured);
    // Remove only the fixture's own policy-only untracked file.
    rmSync(join(dir, 'policy-only'));
    const same = spawnSync('node', [resolve('ratchet/table.mjs'), 'ratchet/rows.json'], {
      cwd: dir, encoding: 'utf8', env: { ...process.env, RATCHET_BASE_REF: 'HEAD',
        RATCHET_MEASURE_REF: measured, EXPECTED_MEASURE_REF: measured, GITHUB_EVENT_PATH: '',
        GITHUB_STEP_SUMMARY: '', GITHUB_OUTPUT: '' },
    });
    expect(same.status).toBe(0);
    expect(same.stdout).toContain('| context | Git assertions | 1 | 1 | 1 | +0 | PASS |');
    expect(readFileSync(join(dir, 'src/tracked'))).toEqual(before);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 30_000);
