import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';

test.skipIf(process.env.TOKENLAYER_TEMP_GUARD_CHILD === '1')('full suite leaves isolated TMPDIR empty', () => {
  const parent = resolve('docs.local/temp-cleanup');
  mkdirSync(parent, { recursive: true });
  const isolated = mkdtempSync(join(parent, 'guard-'));
  try {
    const child = Bun.spawnSync([process.execPath, 'test'], {
      env: { ...process.env, TOKENLAYER_TEMP_GUARD_CHILD: '1', TMPDIR: isolated, TMP: isolated, TEMP: isolated },
      stdout: 'pipe', stderr: 'pipe', timeout: 120000,
    });
    expect(child.exitCode).toBe(0);
    expect(readdirSync(isolated)).toEqual([]);
  } finally { rmSync(isolated, { recursive: true, force: true }); }
}, 120000);
