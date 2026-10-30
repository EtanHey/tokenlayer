import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { replaceService, withPausedSidecars } from '../../scripts/deploy/launchd';
import { BackfillClient, checkSpace, inventoryBytes } from '../../scripts/deploy/backfill';

mkdirSync('.local', { recursive: true });
const root = () => mkdtempSync(join(process.cwd(), '.local/review-'));
const floor = 35 * 1024 ** 3;
const config = { url: '', user: 'synthetic', password: 'synthetic', database: 'tokenlayer' };
test('preflight reserves projected inventory, clamps compression credit, and refuses unknown disk data', async () => {
  let space: unknown = { free_space: String(floor + 199), compressed: '20', uncompressed: '100' };
  const server = Bun.serve({ port: 0, fetch: () => new Response(JSON.stringify(space) + '\n') });
  try {
    const ch = new BackfillClient({ ...config, url: server.url.origin });
    await expect(checkSpace(ch, 100)).rejects.toThrow('35 GiB');
    space = { free_space: String(floor + 200), compressed: '20', uncompressed: '100' };
    expect(await checkSpace(ch, 100)).toBe(2);
    space = { free_space: String(floor + 399), compressed: '200', uncompressed: '100' };
    await expect(checkSpace(ch, 100)).rejects.toThrow('35 GiB');
    space = {};
    await expect(checkSpace(ch, 100)).rejects.toThrow();
  } finally { server.stop(true); }
});
test('every backfill batch checks hub space before insertion', async () => {
  let free = floor + 10000, inserts = 0;
  const server = Bun.serve({ port: 0, async fetch(req) {
    const body = await req.text();
    if (body.includes('system.disks')) return new Response(JSON.stringify({ free_space: String(free), compressed: '0', uncompressed: '0' }) + '\n');
    inserts++; return new Response('');
  } });
  try {
    const ch = new BackfillClient({ ...config, url: server.url.origin });
    await ch.insert('session_events', [{ raw: 'a' }]);
    free = floor;
    await expect(ch.insert('session_events', [{ raw: 'b' }])).rejects.toThrow('35 GiB');
    expect(inserts).toBe(1);
  } finally { server.stop(true); }
});
test('inventory counts JSONL bytes and excludes compressed archives', () => {
  const dir = root();
  writeFileSync(join(dir, 'a.jsonl'), '12345'); writeFileSync(join(dir, 'a.jsonl.zst'), '123');
  expect(inventoryBytes([{ kind: 'codex', dir }])).toBe(5);
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
