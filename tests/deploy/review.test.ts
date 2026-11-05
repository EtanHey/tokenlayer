import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, readFileSync, statSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { replaceService, withPausedSidecars } from '../../scripts/deploy/launchd';
import { BackfillClient, checkSpace, inventoryBytes } from '../../scripts/deploy/backfill';

mkdirSync('.local', { recursive: true });
const root = () => mkdtempSync(join(process.cwd(), '.local/review-'));
const floor = 35 * 1024 ** 3;
const config = { url: '', user: 'synthetic', password: 'synthetic', database: 'tokenlayer' };
test('preflight reserves projected inventory, clamps compression credit, and refuses unknown disk data', async () => {
  let space: unknown = { free_space: '199', keep_free_space: String(floor), compressed: '20', uncompressed: '100' };
  const server = Bun.serve({ port: 0, fetch: () => new Response(JSON.stringify(space) + '\n') });
  try {
    const ch = new BackfillClient({ ...config, url: server.url.origin });
    await expect(checkSpace(ch, 100)).rejects.toThrow('35 GiB');
    space = { free_space: '200', keep_free_space: String(floor), compressed: '20', uncompressed: '100' };
    expect(await checkSpace(ch, 100)).toBe(2);
    space = { free_space: '399', keep_free_space: String(floor), compressed: '200', uncompressed: '100' };
    expect(await checkSpace(ch, 100)).toBe(2);
    space = { free_space: '70380249088', keep_free_space: String(floor), compressed: '0', uncompressed: '0' };
    expect(await checkSpace(ch, Math.floor(32.76 * 1024 ** 3 / 2))).toBe(2);
    space = { free_space: String(floor + 199), keep_free_space: '0', compressed: '0', uncompressed: '0' };
    await expect(checkSpace(ch, 100)).rejects.toThrow('35 GiB');
    space = {};
    await expect(checkSpace(ch, 100)).rejects.toThrow();
  } finally { server.stop(true); }
});
test('every backfill batch checks hub space before insertion', async () => {
  let free = 10000, inserts = 0;
  const server = Bun.serve({ port: 0, async fetch(req) {
    const body = await req.text();
    if (body.includes('system.disks')) return new Response(JSON.stringify({ free_space: String(free), keep_free_space: String(floor), compressed: '0', uncompressed: '0' }) + '\n');
    inserts++; return new Response('');
  } });
  try {
    const ch = new BackfillClient({ ...config, url: server.url.origin });
    await ch.insert('session_events', [{ raw: 'a' }]);
    free = 0;
    await expect(ch.insert('session_events', [{ raw: 'b' }])).rejects.toThrow('35 GiB');
    expect(inserts).toBe(1);
  } finally { server.stop(true); }
});
test('inventory counts decoded Codex archives, excludes Claude archives and plain-file twins', () => {
  const dir = root();
  writeFileSync(join(dir, 'a.jsonl'), '12345'); writeFileSync(join(dir, 'a.jsonl.zst'), '123');
  const decoded = Buffer.from('hello\n'.repeat(100));
  writeFileSync(join(dir, 'b.jsonl.zst'), Bun.zstdCompressSync(decoded));
  expect(inventoryBytes([{ kind: 'codex', dir }], 0)).toBe(5 + decoded.length);
  writeFileSync(join(dir, 'b.jsonl.zst'), Buffer.concat([Bun.zstdCompressSync(decoded), Bun.zstdCompressSync(decoded)]));
  expect(inventoryBytes([{ kind: 'codex', dir }], 0)).toBe(5 + 2 * decoded.length);
  expect(inventoryBytes([{ kind: 'claude', dir }], 0)).toBe(5);
  const packed = spawnSync('zstd', ['-q', '-c', '--no-content-size'], { input: decoded }).stdout;
  writeFileSync(join(dir, 'b.jsonl.zst'), packed);
  expect(inventoryBytes([{ kind: 'codex', dir }], 0)).toBe(5 + packed.length * 6);
});
test('inventory applies the inclusive shipper mtime cutoff to plain and compressed files', () => {
  const dir = root(), sinceMs = Date.parse('2026-10-01T00:00:00Z');
  for (const name of ['old.jsonl', 'edge.jsonl', 'new.jsonl', 'old.jsonl.zst', 'edge.jsonl.zst', 'new.jsonl.zst']) {
    const path = join(dir, name), time = sinceMs + (name.startsWith('old') ? -1000 : name.startsWith('edge') ? 0 : 1000);
    writeFileSync(path, name.endsWith('.zst') ? Bun.zstdCompressSync(Buffer.from('12345')) : '12345');
    utimesSync(path, time / 1000, time / 1000);
  }
  // Plain twins win; also exercise archives without a plain twin.
  const archive = join(dir, 'archive.jsonl.zst');
  writeFileSync(archive, Bun.zstdCompressSync(Buffer.from('1234567')));
  utimesSync(archive, sinceMs / 1000, sinceMs / 1000);
  const staleArchive = join(dir, 'stale.jsonl.zst');
  writeFileSync(staleArchive, Bun.zstdCompressSync(Buffer.from('123456789')));
  utimesSync(staleArchive, (sinceMs - 1000) / 1000, (sinceMs - 1000) / 1000);
  expect(inventoryBytes([{ kind: 'codex', dir }], sinceMs)).toBe(17);
  expect(inventoryBytes([{ kind: 'claude', dir }], sinceMs)).toBe(10);
});
test('representative hub compression fits the measured M4 inventory but refuses a real shortfall', async () => {
  const gib = 1024 ** 3, bytes = 108_000_000_000;
  let space = { free_space: String(62 * gib), keep_free_space: String(floor),
    compressed: String(Math.round(2.43 * gib)), uncompressed: String(Math.round(5.76 * gib)) };
  const server = Bun.serve({ port: 0, fetch: () => new Response(JSON.stringify(space) + '\n') });
  try {
    const ch = new BackfillClient({ ...config, url: server.url.origin });
    const factor = await checkSpace(ch, bytes);
    expect(factor).toBeCloseTo(2.43 / 5.76 * 1.25, 8);
    expect(Math.ceil(bytes * factor)).toBeGreaterThan(56_000_000_000);
    expect(Math.ceil(bytes * factor)).toBeLessThan(58_000_000_000);
    space.free_space = String(50 * gib);
    await expect(checkSpace(ch, bytes)).rejects.toThrow('35 GiB');
    space = { ...space, free_space: String(62 * gib), compressed: String(Math.floor(gib / 10)), uncompressed: String(gib) };
    expect(await checkSpace(ch, bytes)).toBe(0.30 * 1.25);
    space.uncompressed = String(gib - 1);
    await expect(checkSpace(ch, bytes)).rejects.toThrow('35 GiB');
    expect(await checkSpace(ch, 100)).toBe(2);
  } finally { server.stop(true); }
});
test('launchd waits for teardown, retries error 5, and never kickstarts a fresh bootstrap', async () => {
  const calls: string[][] = []; let prints = 0, boots = 0;
  const ctl = (args: string[]) => {
    calls.push(args);
    if (args[0] === 'print') return { status: ++prints < 3 ? 0 : 1, stderr: '' };
    if (args[0] === 'bootstrap') return { status: ++boots === 1 ? 5 : 0, stderr: 'Bootstrap failed: 5: Input/output error' };
    return { status: 0, stderr: '' };
  };
  await replaceService('test', 'test.plist', ctl, async () => {});
  expect(calls.map(c => c[0])).toEqual(['print', 'bootout', 'print', 'print', 'bootstrap', 'bootstrap']);
});
test('launchd teardown and bootstrap failures are bounded and clear', async () => {
  let calls = 0;
  await expect(replaceService('test', 'test.plist', args => { calls++; return { status: args[0] === 'bootstrap' ? 5 : 1, stderr: 'Bootstrap failed: 5' }; }, async () => {})).rejects.toThrow('bootstrap test failed after 5 attempts');
  expect(calls).toBe(6);
  await expect(replaceService('test', 'test.plist', () => ({ status: 0, stderr: '' }), async () => {})).rejects.toThrow('teardown test timed out');
});
test('hub reruns restore stopped ship and drain agents even when hub setup fails', async () => {
  const home = root(), calls: string[][] = [], loaded = new Set(['com.tokenlayer.ship', 'com.tokenlayer.drain']);
  mkdirSync(join(home, 'Library/LaunchAgents'), { recursive: true });
  for (const label of loaded) writeFileSync(join(home, `Library/LaunchAgents/${label}.plist`), 'fixture');
  const ctl = (args: string[]) => {
    calls.push(args);
    const label = args.at(-1)!.split('/').pop()!.replace('.plist', '');
    if (args[0] === 'print') return { status: loaded.has(label) ? 0 : 1, stderr: '' };
    if (args[0] === 'bootout') loaded.delete(label);
    if (args[0] === 'bootstrap') loaded.add(label);
    return { status: 0, stderr: '' };
  };
  await expect(withPausedSidecars(async () => { expect(loaded.size).toBe(0); throw Error('hub failed'); }, home, ctl, async () => {})).rejects.toThrow('hub failed');
  expect([...loaded].sort()).toEqual(['com.tokenlayer.drain', 'com.tokenlayer.ship']);
  expect(calls.filter(c => c[0] === 'bootstrap')).toHaveLength(2);
});
test('credential transfer publishes only a successful nonempty private file and preserves existing credentials', () => {
  const home = root(), bin = join(home, 'bin'); mkdirSync(bin);
  writeFileSync(join(bin, 'ssh'), '#!/bin/bash\nprintf "%s" "$TRANSFER_TEXT"\nexit "$TRANSFER_STATUS"\n', { mode: 0o700 });
  const run = (text: string, status: string) => spawnSync('bash', ['scripts/deploy/copy-password.sh', 'stub-host'], { env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, TRANSFER_TEXT: text, TRANSFER_STATUS: status }, stdio: 'pipe' });
  const path = join(home, '.config/tokenlayer/clickhouse.env');
  expect(run('partial', '1').status).not.toBe(0); expect(existsSync(path)).toBe(false);
  expect(run('', '0').status).not.toBe(0); expect(existsSync(path)).toBe(false);
  expect(run('synthetic', '0').status).toBe(0); expect(readFileSync(path, 'utf8')).toBe('synthetic');
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(run('replacement', '0').status).not.toBe(0); expect(readFileSync(path, 'utf8')).toBe('synthetic');
});
test('every required hub binary is checked before config, logs or launchd changes', () => {
  const required = ['openssl', 'plutil', 'launchctl', 'tailscale'];
  for (const missing of required) {
    const home = root(), bin = join(home, 'bin'); mkdirSync(bin);
    for (const binary of required.filter(b => b !== missing)) writeFileSync(join(bin, binary), '#!/bin/bash\nexit 99\n', { mode: 0o700 });
    const result = spawnSync(process.execPath, ['scripts/deploy/deploy.ts', 'hub', 'unused'], { env: { ...process.env, HOME: home, PATH: bin }, encoding: 'utf8' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`${missing} missing from PATH; no changes made`);
    expect(existsSync(join(home, '.config'))).toBe(false);
    expect(existsSync(join(home, 'Library/Logs/tokenlayer'))).toBe(false);
    expect(existsSync(join(home, 'Library/LaunchAgents'))).toBe(false);
  }
});

test('backfill CLI rejects missing or non-finite arguments before initialization', () => {
  const cases: [string[], string][] = [[[], '--since'], [['--since'], '--since'], [['--since', 'NaN'], '--since'],
    [['--since', '2026-01-01'], '--rate-mb'], [['--since', '2026-01-01', '--rate-mb'], '--rate-mb'],
    ...['NaN', 'Infinity', '0', '-1'].map(v => [['--since', '2026-01-01', '--rate-mb', v], '--rate-mb'] satisfies [string[], string])];
  for (const [args, flag] of cases) {
    const result = spawnSync(process.execPath, ['scripts/deploy/backfill.ts', ...args], {
      env: { PATH: process.env.PATH, TOKENLAYER_ENV_FILES: '/dev/null' }, encoding: 'utf8' });
    expect(result.status).not.toBe(0); expect(result.stderr).toContain(flag);
  }
});
