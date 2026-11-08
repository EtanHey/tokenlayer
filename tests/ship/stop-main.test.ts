import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};
for (const signal of ['SIGTERM', 'SIGINT'] as const) test(`main ${signal} finishes admitted ACK before stopping the upload pass`, async () => {
  const root = process.env.TOKENLAYER_TEST_ROOT ?? join(homedir(), '.cache/tokenlayer-test-fixtures');
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, 'ship-stop-')), sources = join(dir, 'claude');
  mkdirSync(sources);
  const line = JSON.stringify({ type: 'user', sessionId: 'synthetic', message: { role: 'user', content: 'owned fixture' } }) + '\n';
  for (const name of ['a', 'b']) writeFileSync(join(sources, `${name}.jsonl`), line);
  const preload = join(dir, 'signal-receipt.ts'), state = join(dir, 'state.json');
  writeFileSync(preload, `process.on('${signal}', () => process.stdout.write('fixture-signal-received\\n'));`);
  const columns = [...readFileSync(resolve(import.meta.dir, '../../schema/004_session_events.sql'), 'utf8')
    .matchAll(/^    (\w+)\s+(\w+(?:\([^\n]*?\))?)/gm)].filter(m => m[1] !== 'INDEX')
    .map(m => ({ name: m[1], type: m[2] }));
  const admitted = deferred(), ack = deferred(), received = deferred();
  const inserts: string[] = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    const body = await req.text(), query = new URL(req.url).searchParams.get('query') ?? '';
    if (body.includes('system.tables')) return Response.json({ sorting_key: 'machine, path, generation, byte_offset, content_hash', engine: 'ReplacingMergeTree' });
    if (body.includes('system.columns')) return new Response(columns.map(c => JSON.stringify(c)).join('\n'));
    if (!query.startsWith('INSERT INTO tokenlayer.session_events ')) return new Response('unexpected fixture query', { status: 400 });
    inserts.push(JSON.parse(body.trim()).path);
    admitted.resolve();
    await ack.promise;
    return new Response('');
  } });
  const absent = join(dir, 'absent');
  const child = Bun.spawn([process.execPath, '--preload', preload, resolve(import.meta.dir, '../../src/ship/main.ts')], {
    env: { PATH: process.env.PATH, HOME: dir, TOKENLAYER_ENV_FILES: '/dev/null', TOKENLAYER_MACHINE: 'synthetic',
      CLICKHOUSE_URL: server.url.origin, TOKENLAYER_SHIP_STATE: state, TOKENLAYER_CLAUDE_DIR: sources,
      TOKENLAYER_CODEX_DIR: absent, TOKENLAYER_KIRO_DIR: absent, TOKENLAYER_KIRO_T3_STATE: absent,
      TOKENLAYER_ANTIGRAVITY_CLI_DIR: absent, TOKENLAYER_T3_ANTIGRAVITY_DIR: absent, TOKENLAYER_SHIP_RATE_MB: '0' },
    stdout: 'pipe', stderr: 'pipe',
  });
  const output = (async () => {
    let text = '';
    for await (const chunk of child.stdout) {
      text += Buffer.from(chunk).toString();
      if (text.includes('fixture-signal-received\n')) received.resolve();
    }
    return text;
  })();
  const stderr = new Response(child.stderr).text();
  const deadline = AbortSignal.timeout(5000);
  const bounded = <T>(promise: Promise<T>) => Promise.race([promise, new Promise<never>((_, reject) =>
    deadline.addEventListener('abort', () => reject(Error('fixture gate timed out')), { once: true }))]);
  try {
    await bounded(admitted.promise);
    child.kill(signal);
    await bounded(received.promise);
    expect(child.exitCode).toBeNull();
    if (existsSync(state)) expect(Object.values(JSON.parse(readFileSync(state, 'utf8')).files).every(cp => (cp as { offset: number }).offset === 0)).toBe(true);
    ack.resolve();
    expect(await bounded(child.exited)).toBe(0);
    expect(await stderr).toBe('');
    expect(await output).toContain('lines=1');
    expect(inserts).toHaveLength(1);
    const files = JSON.parse(readFileSync(state, 'utf8')).files;
    expect(files[inserts[0]].offset).toBe(Buffer.byteLength(line));
    expect(Object.values(files).filter(cp => (cp as { offset: number }).offset > 0)).toHaveLength(1);
  } finally {
    ack.resolve();
    if (child.exitCode === null) child.kill('SIGKILL');
    await child.exited;
    await Promise.all([output, stderr]);
    server.stop(true);
  }
}, 10000);
