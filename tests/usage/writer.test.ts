import { expect, test } from 'bun:test';
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { snapshot, staleSnapshot } from '../../src/usage/snapshot';

const previous = () => snapshot({ files: [{ id: 'synthetic', provider: 'claude', account_type: 'oauth' }] }, Date.parse('2026-10-28T09:00:00Z'));

test('real writer rejects corrupted private prior state during SSH outage', async () => {
  const home = await mkdtemp(join(tmpdir(), 'tokenlayer-writer-'));
  try {
    const dir = join(home, '.config/tokenlayer');
    await mkdir(dir, { recursive: true });
    const target = join(dir, 'usage.json');
    const seed = previous();
    seed.accounts[0]!.label = 'opaque-synthetic-sentinel';
    await writeFile(target, JSON.stringify({ ...seed, debug: 'opaque-synthetic-sentinel', accounts: seed.accounts.map(a => ({ ...a, detail: 'opaque-synthetic-sentinel' })) }));
    await chmod(target, 0o600);
    const preload = join(home, 'offline.ts');
    await writeFile(preload, "Bun.spawn = (() => ({ stdout: new Blob(['']).stream(), exited: Promise.resolve(1), kill() {} })) as typeof Bun.spawn;\n");
    const proc = Bun.spawn([process.execPath, '--preload', preload, resolve('src/usage/main.ts')], { env: { ...process.env, HOME: home }, stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect(code).toBe(0);
    expect(stdout + stderr).toBe('');
    expect(JSON.parse(await readFile(target, 'utf8'))).toEqual({ generated_at: null, source: 'cliproxy-hub', stale: true, accounts: [], last_error: 'hub unavailable' });
    expect((await stat(target)).mode & 0o777).toBe(0o644);
    expect(await readdir(dir)).toEqual(['usage.json']);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('stale projection drops unknown fields at every depth', () => {
  const seed = previous();
  const input = { ...seed, debug: 'opaque', accounts: seed.accounts.map(a => ({ ...a, detail: 'opaque', five_hour: { ...a.five_hour, debug: 'opaque' } })) };
  expect(staleSnapshot(input)).toEqual({ ...seed, stale: true, last_error: 'hub unavailable' });
});

test('stale projection rejects invalid published field types', () => {
  const seed = previous();
  const account = seed.accounts[0]!;
  for (const patch of [{ label: 'opaque' }, { active: 1 }, { disabled: null }, { priority: Infinity }, { status: 'opaque' }, { five_hour: { used_pct: 101, resets_at: null } }, { weekly: { used_pct: null, resets_at: 'tomorrow' } }]) {
    expect(() => staleSnapshot({ ...seed, accounts: [{ ...account, ...patch }] })).toThrow();
  }
  for (const patch of [{ generated_at: 'tomorrow' }, { source: 'other' }, { stale: 'false' }, { last_error: 'opaque' }]) {
    expect(() => staleSnapshot({ ...seed, ...patch })).toThrow();
  }
});
