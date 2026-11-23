import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';

test('fixture suites leave no temporary directories', () => {
  const parent = resolve('docs.local/temp-cleanup');
  mkdirSync(parent, { recursive: true });
  const isolated = mkdtempSync(join(parent, 'guard-'));
  try {
    const child = Bun.spawnSync([process.execPath, 'test', 'tests/metadata/member-pin.test.ts',
      'tests/metadata/projection.test.ts', 'tests/metadata/output.test.ts',
      'tests/history-file-chunks/acquire.test.ts'], {
      env: { ...process.env, TMPDIR: isolated, TMP: isolated, TEMP: isolated },
      stdout: 'pipe', stderr: 'pipe', timeout: 120000,
    });
    expect(child.exitCode).toBe(0);
    expect(readdirSync(isolated).filter(name => /^(member-pin|metadata-test|metadata-output|history-chunks)-/.test(name))).toEqual([]);
  } finally { rmSync(isolated, { recursive: true, force: true }); }
}, 120000);
