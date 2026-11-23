import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';

// Chrome's Linux singleton socket adds ~40 bytes below TMPDIR (sun_path is 108 bytes).
// Keep CI scratch short; developer scratch remains inside the repository.
function auditParent(ci = !!process.env.CI, platform: string = process.platform, repo = process.cwd()) {
  return ci && platform === 'linux' ? '/tmp' : resolve(repo, 'docs.local/temp-cleanup');
}

test('Linux CI audit scratch leaves room for Chrome singleton sockets', () => {
  const parent = auditParent(true, 'linux', '/home/runner/work/tokenlayer/tokenlayer');
  const socket = join(parent, 'guard-XXXXXX', '.com.google.Chrome.XXXXXX', 'SingletonSocket');
  expect(Buffer.byteLength(socket)).toBeLessThan(108);
  expect(auditParent(false, 'linux', '/repo')).toBe('/repo/docs.local/temp-cleanup');
});

test.skipIf(process.env.TOKENLAYER_TEMP_GUARD_CHILD === '1')('full suite leaves isolated TMPDIR empty', () => {
  const parent = auditParent();
  mkdirSync(parent, { recursive: true });
  const isolated = mkdtempSync(join(parent, 'guard-'));
  try {
    // ClickHouse fixtures live in repo .local, outside this TMPDIR audit.
    // Skip-IT measured ~36s locally; allow 180s for slower CI hosts.
    const child = Bun.spawnSync([process.execPath, 'test'], {
      env: { ...process.env, TOKENLAYER_TEMP_GUARD_CHILD: '1', TOKENLAYER_SKIP_IT: '1', TMPDIR: isolated, TMP: isolated, TEMP: isolated },
      stdout: 'pipe', stderr: 'pipe', timeout: 180000,
    });
    const stderr = child.stderr.toString();
    const lines = stderr.split('\n');
    const firstFailure = lines.findIndex(line => line.includes('(fail)'));
    const failures = lines.filter(line => line.includes('(fail)'));
    const context = firstFailure < 0 ? lines.slice(-40)
      : lines.slice(Math.max(0, firstFailure - 40), firstFailure + 41);
    const diagnostics = [...failures, ...context, ...lines.slice(-8)].join('\n');
    expect(child.exitCode, diagnostics).toBe(0);
    const passed = Number(/(?:^|\n)\s*(\d+) pass\b/.exec(stderr)?.[1] ?? 0);
    expect(passed, diagnostics).toBeGreaterThanOrEqual(1000);
    expect(readdirSync(isolated), diagnostics).toEqual([]);
  } finally { rmSync(isolated, { recursive: true, force: true }); }
}, 190000);
