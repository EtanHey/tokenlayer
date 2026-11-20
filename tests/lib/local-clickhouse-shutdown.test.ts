import { expect, test } from 'bun:test';
import { join } from 'node:path';

// Exercise actual pool ownership and OS termination in a separate runner, with lightweight
// stand-ins for ClickHouse processes. No ClickHouse binary, ports or live store required.
const module = join(import.meta.dir, '../../src/lib/local-clickhouse.ts');
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  test(`pool kills ready and starting children on ${signal} and preserves termination`, async () => {
    const child = Bun.spawn([process.execPath, '-e', `
      delete process.env.TOKENLAYER_SKIP_IT;
      Bun.which = () => 'synthetic-clickhouse';
      let calls = 0;
      const fs = await import('node:fs');
      Bun.spawn = (args) => {
        const id = ++calls;
        if (id !== 3) fs.writeFileSync(args.find(a => a.startsWith('--logger.log=')).slice(13), 'Application: Ready for connections.');
        let finish;
        const proc = { exitCode: null, exited: new Promise(r => finish = r),
          kill() { console.log('killed:' + id); proc.exitCode = 137; finish(137); } };
        return proc;
      };
      globalThis.fetch = async () => ({ ok: true });
      const { prewarmLocalClickHouse, startLocalClickHouse } = await import(${JSON.stringify(module)});
      prewarmLocalClickHouse(2);
      await (await startLocalClickHouse()).stop();
      await (await startLocalClickHouse()).stop();
      console.log('armed');
      setInterval(() => {}, 1000);
    `], { env: process.env, stdout: 'pipe', stderr: 'pipe' });
    let output = '';
    const reader = child.stdout.getReader();
    try {
      while (!output.includes('armed')) {
        const result = await reader.read();
        if (result.done) throw Error(output + await new Response(child.stderr).text());
        output += new TextDecoder().decode(result.value);
      }
      child.kill(signal);
      const code = await child.exited;
      for (;;) { const r = await reader.read(); if (r.done) break; output += new TextDecoder().decode(r.value); }
      expect(output.match(/killed:/g)?.length).toBe(4);
      expect(code).toBe(signal === 'SIGINT' ? 130 : 143);
    } finally { child.kill('SIGKILL'); await child.exited; }
  }, 5000);
}

test('normal drain waits for every exit before deleting directories', async () => {
  const child = Bun.spawn([process.execPath, '-e', `
    delete process.env.TOKENLAYER_SKIP_IT;
    Bun.which = () => 'synthetic-clickhouse';
    const fs = await import('node:fs');
    const children = [];
    Bun.spawn = args => {
      const dir = args.find(a => a.startsWith('--path=')).slice(7, -6);
      fs.writeFileSync(dir + '/server.log', 'Application: Ready for connections.');
      let finish;
      const proc = { dir, exitCode: null, exited: new Promise(r => finish = r),
        kill() { if (children.indexOf(proc) === 0 || children.indexOf(proc) === 3) finish(137); },
        finish() { proc.exitCode = 137; finish(137); } };
      children.push(proc);
      return proc;
    };
    globalThis.fetch = async () => ({ ok: true });
    const { prewarmLocalClickHouse, startLocalClickHouse, drainPrewarmedLocalClickHouse } = await import(${JSON.stringify(module)});
    prewarmLocalClickHouse(2);
    await (await startLocalClickHouse()).stop();
    await (await startLocalClickHouse()).stop();
    const done = drainPrewarmedLocalClickHouse();
    await Promise.resolve();
    if (![children[1], children[2]].every(p => fs.existsSync(p.dir))) throw Error('removed before exit');
    children[1].finish(); children[2].finish();
    if (await done !== 2) throw Error('wrong count');
    if ([children[1], children[2]].some(p => fs.existsSync(p.dir))) throw Error('not removed');
  `], { env: process.env, stdout: 'pipe', stderr: 'pipe' });
  expect(await new Response(child.stderr).text()).toBe('');
  expect(await child.exited).toBe(0);
});

test('explicit exit confirms starting children are inert before removing their directories', async () => {
  const child = Bun.spawn([process.execPath, '-e', `
    delete process.env.TOKENLAYER_SKIP_IT;
    Bun.which = () => 'synthetic-clickhouse';
    const fs = await import('node:fs');
    const children = [];
    Bun.spawn = args => {
      const id = children.length + 1;
      const dir = args.find(a => a.startsWith('--path=')).slice(7, -6);
      if (id !== 3) fs.writeFileSync(dir + '/server.log', 'Application: Ready for connections.');
      let finish;
      const proc = { pid: 900000 + id, dir, exitCode: null, exited: new Promise(r => finish = r),
        kill() { if (id === 1 || id === 4) { proc.exitCode = 137; finish(137); } } };
      children.push(proc);
      return proc;
    };
    const checked = new Set();
    Bun.spawnSync = args => {
      if (args[0] !== 'ps') throw Error('unexpected command');
      const proc = children.find(p => p.pid === Number(args.at(-1)));
      if (!fs.existsSync(proc.dir)) throw Error('directory removed before child exit');
      if (!checked.has(proc)) { checked.add(proc); return { exitCode: 0, stdout: Buffer.from('S') }; }
      console.log('exited:' + proc.pid);
      return { exitCode: 0, stdout: Buffer.from('Z') };
    };
    globalThis.fetch = async () => ({ ok: true });
    const { prewarmLocalClickHouse, startLocalClickHouse } = await import(${JSON.stringify(module)});
    prewarmLocalClickHouse(2);
    await (await startLocalClickHouse()).stop();
    await (await startLocalClickHouse()).stop();
    process.exit(0);
  `], { env: process.env, stdout: 'pipe', stderr: 'pipe' });
  expect(await child.exited).toBe(0);
  expect(await new Response(child.stderr).text()).toBe('');
  expect((await new Response(child.stdout).text()).match(/exited:/g)).toHaveLength(2);
});

test('explicit exit removes real child processes and their owned directories', async () => {
  const child = Bun.spawn([process.execPath, '-e', `
    delete process.env.TOKENLAYER_SKIP_IT;
    Bun.which = () => 'synthetic-clickhouse';
    const fs = await import('node:fs');
    const spawn = Bun.spawn;
    let spawned = 0;
    Bun.spawn = args => {
      const id = ++spawned;
      const dir = args.find(a => a.startsWith('--path=')).slice(7, -6);
      if (id !== 3) fs.writeFileSync(dir + '/server.log', 'Application: Ready for connections.');
      const proc = spawn([process.execPath, '-e', 'setInterval(() => {}, 1000)'], { stdout: 'ignore', stderr: 'ignore' });
      if (id === 2 || id === 3) console.log(JSON.stringify({ pid: proc.pid, dir }));
      return proc;
    };
    globalThis.fetch = async () => ({ ok: true });
    const { prewarmLocalClickHouse, startLocalClickHouse } = await import(${JSON.stringify(module)});
    prewarmLocalClickHouse(2);
    await (await startLocalClickHouse()).stop();
    await (await startLocalClickHouse()).stop();
    process.exit(0);
  `], { env: process.env, stdout: 'pipe', stderr: 'pipe' });
  const owned: { pid: number; dir: string }[] = (await new Response(child.stdout).text()).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  expect(await child.exited).toBe(0);
  expect(await new Response(child.stderr).text()).toBe('');
  expect(owned).toHaveLength(2);
  const { existsSync } = await import('node:fs');
  for (const { pid, dir } of owned) {
    expect(() => process.kill(pid, 0)).toThrow();
    expect(existsSync(dir)).toBe(false);
  }
});
