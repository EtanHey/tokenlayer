import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

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
        killed: false,
        kill() {
          proc.killed = true;
          if (id === 1 || id === 4) { proc.exitCode = 137; finish(137); }
          if (id === 2) throw Error('synthetic kill failure after delivery');
        } };
      children.push(proc);
      return proc;
    };
    const checked = new Set();
    Bun.spawnSync = () => { throw Error('cleanup must not shell out to ps'); };
    process.kill = (pid, signal) => {
      if (signal !== 0) throw Error('unexpected signal probe');
      const proc = children.find(p => p.pid === pid);
      if (![children[1], children[2]].every(p => p.killed)) throw Error('not all children signalled');
      if (!fs.existsSync(proc.dir)) throw Error('directory removed before child exit');
      if (!checked.has(proc)) { checked.add(proc); return true; }
      console.log('exited:' + pid);
      throw Object.assign(Error('gone'), { code: 'ESRCH' });
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

for (const failure of ['deadline', 'permission'] as const) {
  test(`unconfirmed ${failure} preserves directories after signalling every spare`, async () => {
    const child = Bun.spawn([process.execPath, '-e', `
      delete process.env.TOKENLAYER_SKIP_IT;
      Bun.which = () => 'synthetic-clickhouse';
      const fs = await import('node:fs');
      const children = [];
      Bun.spawn = args => {
        const dir = args.find(a => a.startsWith('--path=')).slice(7, -6);
        fs.writeFileSync(dir + '/server.log', 'Application: Ready for connections.');
        let finish;
        const id = children.length + 1;
        const proc = { pid: 900000 + id, dir, killed: false, exitCode: null,
          exited: new Promise(r => finish = r),
          kill() {
            proc.killed = true;
            if (id === 1 || id === 4) { proc.exitCode = 137; finish(137); }
          } };
        children.push(proc);
        return proc;
      };
      globalThis.fetch = async () => ({ ok: true });
      const { prewarmLocalClickHouse, startLocalClickHouse, stopPrewarmedLocalClickHouse } = await import(${JSON.stringify(module)});
      prewarmLocalClickHouse(2);
      await (await startLocalClickHouse()).stop();
      await (await startLocalClickHouse()).stop();
      let now = Date.now();
      Date.now = () => now += 1000;
      process.kill = () => {
        if (${JSON.stringify(failure)} === 'permission') throw Object.assign(Error('denied'), { code: 'EPERM' });
        return true;
      };
      let rejected = false;
      try { stopPrewarmedLocalClickHouse(); }
      catch (error) {
        rejected = error.message === (${JSON.stringify(failure)} === 'permission' ? 'denied' : 'pre-warm child exit could not be confirmed');
      }
      if (!rejected) throw Error('unconfirmed child accepted');
      if (![children[1], children[2]].every(p => p.killed && fs.existsSync(p.dir))) throw Error('cleanup guarantee lost');
      children[1].exitCode = children[2].exitCode = 137;
      stopPrewarmedLocalClickHouse();
      process.exit(0);
    `], { env: process.env, stdout: 'pipe', stderr: 'pipe' });
    expect(await new Response(child.stderr).text()).toBe('');
    expect(await child.exited).toBe(0);
  });
}

for (const shutdown of ['exit', 'stop'] as const) {
test(`${shutdown} removes real child processes and their owned directories`, async () => {
  const child = Bun.spawn([process.execPath, '-e', `
    delete process.env.TOKENLAYER_SKIP_IT;
    Bun.which = () => 'synthetic-clickhouse';
    const fs = await import('node:fs');
    const spawn = Bun.spawn;
    let spawned = 0;
    const spares = [];
    Bun.spawn = args => {
      const id = ++spawned;
      const dir = args.find(a => a.startsWith('--path=')).slice(7, -6);
      if (id !== 3) fs.writeFileSync(dir + '/server.log', 'Application: Ready for connections.');
      const proc = spawn([process.execPath, '-e', 'setInterval(() => {}, 1000)'], { stdout: 'ignore', stderr: 'ignore' });
      if (id === 2 || id === 3) { spares.push(proc); console.log(JSON.stringify({ pid: proc.pid, dir })); }
      return proc;
    };
    globalThis.fetch = async () => ({ ok: true });
    const { prewarmLocalClickHouse, startLocalClickHouse, stopPrewarmedLocalClickHouse } = await import(${JSON.stringify(module)});
    prewarmLocalClickHouse(2);
    await (await startLocalClickHouse()).stop();
    await (await startLocalClickHouse()).stop();
    if (${JSON.stringify(shutdown)} === 'stop') {
      if (stopPrewarmedLocalClickHouse() !== 2) throw Error('wrong spare count');
      // WNOWAIT must leave Bun able to reap and settle both promises normally.
      await Promise.all(spares.map(proc => proc.exited));
    }
    process.exit(0);
  `], { env: process.env, stdout: 'pipe', stderr: 'pipe' });
  const owned: { pid: number; dir: string }[] = (await new Response(child.stdout).text()).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  expect(await child.exited).toBe(0);
  expect(await new Response(child.stderr).text()).toBe('');
  expect(owned).toHaveLength(2);
  for (const { pid, dir } of owned) {
    // Linux can retain an orphan zombie until its subreaper runs. It cannot execute
    // or recreate files; distinguish that from a live child rather than requiring ESRCH.
    let inert = false;
    const deadline = Date.now() + 2000;
    do {
      try {
        process.kill(pid, 0);
        if (process.platform === 'linux') {
          const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
          inert = stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z');
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH' ||
            (error as NodeJS.ErrnoException).code === 'ENOENT') inert = true;
        else throw error;
      }
      if (!inert) await Bun.sleep(1);
    } while (!inert && Date.now() < deadline);
    expect(inert).toBe(true);
    expect(existsSync(dir)).toBe(false);
  }
});

}
