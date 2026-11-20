import { afterEach, expect } from 'bun:test';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from '../support/clickhouse-gate';
import type { ClickHouse } from '../../src/lib/clickhouse';
import { prewarmLocalClickHouse, startLocalClickHouse, stopPrewarmedLocalClickHouse } from '../../src/lib/local-clickhouse';

// CI3: the suite pre-warms local ClickHouse servers (tests/preload.ts). Not an .it file on purpose:
// these test the harness, and the ratchet's integration count stays the count of product tests.
const root = join(import.meta.dir, '..', '..', '.local');
const serverDirs = () => new Set(readdirSync(root).filter(name => name.startsWith('ch-it-')));
const restore = prewarmLocalClickHouse(0);
prewarmLocalClickHouse(restore);
afterEach(() => { stopPrewarmedLocalClickHouse(); prewarmLocalClickHouse(restore); });

test('a pre-warmed server is a fresh server of its own, and no spare outlives the stop', async () => {
  stopPrewarmedLocalClickHouse();
  const before = serverDirs();
  prewarmLocalClickHouse(1);
  const first = await startLocalClickHouse(); // asked once: cold, no spare yet
  expect(stopPrewarmedLocalClickHouse('false|0|0')).toBe(0);
  const second = await startLocalClickHouse(); // asked twice: cold, and one spare starts beside it
  try {
    await second.client.exec('CREATE DATABASE tokenlayer');
    await second.client.exec('CREATE TABLE tokenlayer.t (x UInt8) ENGINE = MergeTree ORDER BY x');
    const third = await startLocalClickHouse(); // the spare
    try {
      expect(new Set([first, second, third].map(ch => ch.client.config.url)).size).toBe(3);
      expect(await third.client.exec("SELECT count() FROM system.databases WHERE name = 'tokenlayer'")).toBe('0\n');
      expect(await third.client.exec('SELECT 1')).toBe('1\n');
    } finally { await third.stop(); }
    expect(serverDirs().size).toBe(before.size + 3); // first, second and the refilled spare
    expect(stopPrewarmedLocalClickHouse()).toBe(1);
  } finally { await second.stop(); await first.stop(); }
  expect(serverDirs()).toEqual(before);
}, 60_000);

test('prepare runs on every server, pre-warmed or cold, before the caller gets it', async () => {
  stopPrewarmedLocalClickHouse();
  prewarmLocalClickHouse(1);
  const prepared: string[] = [];
  const prepare = async (client: ClickHouse) => {
    prepared.push(client.config.url);
    await client.exec('CREATE DATABASE tokenlayer');
  };
  const check = async (local: Awaited<ReturnType<typeof startLocalClickHouse>>) => {
    try {
      expect(prepared).toContain(local.client.config.url);
      expect(await local.client.exec("SELECT count() FROM system.databases WHERE name = 'tokenlayer'")).toBe('1\n');
    } finally { await local.stop(); }
  };
  // Two cold starts (the second ask also starts a spare), then the pre-warmed spare.
  await Promise.all((await Promise.all([1, 2].map(() => startLocalClickHouse({ prepare })))).map(check));
  await check(await startLocalClickHouse({ prepare }));
  const failing = async () => { throw Error('synthetic prepare failure'); };
  const before = serverDirs();
  await expect(startLocalClickHouse({ prepare: failing })).rejects.toThrow('synthetic prepare failure');
  expect(serverDirs()).toEqual(before);
}, 60_000);

test('a caller with its own port allocator gets a cold start and leaves no spare', async () => {
  stopPrewarmedLocalClickHouse();
  prewarmLocalClickHouse(2);
  let allocations = 0;
  const allocate = () => {
    allocations++;
    const a = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
    const b = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
    try { return { http: a.port, tcp: b.port }; } finally { a.stop(true); b.stop(true); }
  };
  const pair = await Promise.all([1, 2].map(() => startLocalClickHouse({}, allocate)));
  try {
    for (const local of pair) expect(await local.client.exec('SELECT 1')).toBe('1\n');
  } finally { await Promise.all(pair.map(local => local.stop())); }
  expect(allocations).toBe(2);
  expect(stopPrewarmedLocalClickHouse()).toBe(0);
}, 60_000);

test('options asked for once get no spare, and only the 3 latest option sets keep spares', async () => {
  stopPrewarmedLocalClickHouse();
  prewarmLocalClickHouse(1);
  // The bookkeeping runs synchronously in each call, so these asks land in this order: 1, then 2 to 5 twice each.
  const all = await Promise.all([1, 2, 2, 3, 3, 4, 4, 5, 5].map(keepFreeSpaceBytes => startLocalClickHouse({ keepFreeSpaceBytes })));
  await Promise.all(all.map(local => local.stop()));
  expect(stopPrewarmedLocalClickHouse('false|1|0')).toBe(0); // asked once
  expect(stopPrewarmedLocalClickHouse('false|2|0')).toBe(0); // evicted when the 4th set was asked twice
  expect(stopPrewarmedLocalClickHouse()).toBe(3);
}, 60_000);

test('a process that exits with spares still starting leaves no server or directory behind', async () => {
  stopPrewarmedLocalClickHouse();
  const before = serverDirs();
  const module = join(import.meta.dir, '..', '..', 'src', 'lib', 'local-clickhouse.ts');
  const child = Bun.spawn(['bun', '-e', `
    const { prewarmLocalClickHouse, startLocalClickHouse } = await import(${JSON.stringify(module)});
    prewarmLocalClickHouse(2);
    for (let i = 0; i < 2; i++) await (await startLocalClickHouse()).stop();
    console.log("taken and stopped");
    process.exit(0);`], { env: process.env, stdout: 'pipe', stderr: 'pipe' });
  expect(await child.exited).toBe(0);
  expect(await new Response(child.stdout).text()).toBe('taken and stopped\n');
  expect(serverDirs()).toEqual(before);
  const ps = Bun.spawnSync(['ps', '-axo', 'command']).stdout.toString();
  const left = [...ps.matchAll(/--path=(\S+)\/data\//g)].map(m => m[1]!)
    .filter(dir => dir.startsWith(root + '/') && !before.has(dir.slice(root.length + 1)));
  expect(left).toEqual([]);
}, 60_000);

for (const signal of ['SIGINT', 'SIGTERM'] as const) for (const state of ['ready', 'preparing'] as const) {
  test(`real pool ${state} spares disappear after runner ${signal}`, async () => {
    stopPrewarmedLocalClickHouse();
    const before = serverDirs();
    const module = join(import.meta.dir, '../../src/lib/local-clickhouse.ts');
    const child = Bun.spawn([process.execPath, '-e', `
      const spawn = Bun.spawn;
      let spawned = 0, prepared = 0;
      const spareURLs = new Set();
      Bun.spawn = (...args) => {
        const proc = spawn(...args);
        if (++spawned === 2 || spawned === 3) {
          spareURLs.add('http://127.0.0.1:' + args[0].find(a => a.startsWith('--http_port=')).slice(12));
          console.log('spare:' + proc.pid);
        }
        return proc;
      };
      const { prewarmLocalClickHouse, startLocalClickHouse } = await import(${JSON.stringify(module)});
      prewarmLocalClickHouse(2);
      const prepare = async client => {
        ++prepared;
        if (${JSON.stringify(state)} === 'preparing' && spareURLs.has(client.config.url)) await new Promise(() => {});
      };
      await (await startLocalClickHouse({ prepare })).stop();
      await (await startLocalClickHouse({ prepare })).stop();
      while (prepared < 4) await Bun.sleep(10);
      console.log('armed');
      setInterval(() => {}, 1000);
    `], { env: process.env, stdout: 'pipe', stderr: 'pipe' });
    let output = '';
    const reader = child.stdout.getReader();
    try {
      while (!output.includes('armed')) {
        const r = await reader.read();
        if (r.done) throw Error(output + await new Response(child.stderr).text());
        output += new TextDecoder().decode(r.value);
      }
      const pids = [...output.matchAll(/spare:(\d+)/g)].map(m => Number(m[1]));
      expect(pids).toHaveLength(2);
      child.kill(signal);
      expect(await child.exited).toBe(signal === 'SIGINT' ? 130 : 143);
      for (const pid of pids) {
        expect(() => process.kill(pid, 0)).toThrow();
      }
      expect(serverDirs()).toEqual(before);
    } finally { child.kill('SIGKILL'); await child.exited; }
  }, 60000);
}
