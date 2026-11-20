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
