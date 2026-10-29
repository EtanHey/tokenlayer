import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const secret = 'sk-syntheticEgressSentinel123456789';
const root = join(import.meta.dir, '../..');
async function run(main: string, env: Record<string, string> = {}, preload?: string, args: string[] = []) {
  const proc = Bun.spawn([process.execPath, ...(preload ? ['--preload', preload] : []), `src/${main}/main.ts`, ...args], {
    cwd: root, env: { PATH: process.env.PATH, HOME: tmpdir(), TOKENLAYER_ENV: '/dev/null', TOKENLAYER_ENV_FILES: '/dev/null', ...env }, stdout: 'pipe', stderr: 'pipe',
  });
  return { out: await new Response(proc.stdout).text(), err: await new Response(proc.stderr).text(), code: await proc.exited };
}
function safe(result: { err: string }) {
  expect(result.err).toContain('[redacted]');
  expect(result.err).not.toContain(secret);
}

test('source output uses the egress choke point', () => {
  const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]);
  for (const file of files(join(root, 'src'))) {
    if (file === join(root, 'src/lib/egress.ts')) continue;
    expect(readFileSync(file, 'utf8')).not.toMatch(/\bconsole\s*\.|\bprocess\s*\.\s*(?:stdout|stderr)\s*\.\s*write\s*\(/);
  }
});

test('steer API error redacts on stderr', async () => {
  const server = Bun.serve({ port: 0, fetch: () => new Response(secret, { status: 500 }) });
  try { safe(await run('steer', { CLIPROXY_MGMT_KEY: 'synthetic', TOKENLAYER_HUB_URL: server.url.href }, undefined, ['--once'])); }
  finally { server.stop(true); }
});

test('drain startup path failure is redacted', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'egress-'));
  try {
    const path = join(dir, secret);
    writeFileSync(path, 'file');
    const result = await run('drain', { CLIPROXY_MGMT_KEY: 'synthetic', TOKENLAYER_STATE_DIR: path });
    safe(result);
    expect(result.code).not.toBe(0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

for (const main of ['ship', 'usage', 'admit']) test(`${main} uncaught throw is redacted on stderr`, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'egress-'));
  try {
    const preload = join(dir, 'inject.ts');
    // Run after imports but before entry-point initialization, without touching real services.
    writeFileSync(preload, `process.env.TOKENLAYER_ENV_FILES = '/dev/null'; process.env.TOKENLAYER_MACHINE = 'synthetic';\nObject.defineProperty(process, 'argv', { get() { throw new Error('${secret}'); } });\n`);
    if (main === 'admit') writeFileSync(preload, `JSON.stringify = () => { throw new Error('${secret}'); };`);
    const home = join(dir, secret);
    if (main === 'usage') writeFileSync(home, 'file');
    const result = await run(main, main === 'usage' ? { HOME: home } : {}, main === 'usage' ? undefined : preload);
    safe(result);
    expect(result.code).not.toBe(0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('steer snapshot redacts stdout without changing the input', async () => {
  const body = JSON.parse(readFileSync(join(root, 'tests/fixtures/steer/credentials-live-redacted.json'), 'utf8'));
  body.files[0].quota = { signals: { note: secret } };
  const server = Bun.serve({ port: 0, fetch: () => Response.json(body) });
  try {
    const result = await run('steer', { CLIPROXY_MGMT_KEY: 'synthetic', TOKENLAYER_HUB_URL: server.url.href }, undefined, ['--once', '--dry-run', '--snapshots']);
    expect(result.out).toContain('[redacted]');
    expect(result.out).not.toContain(secret);
    expect(body.files[0].quota.signals.note).toBe(secret);
  } finally { server.stop(true); }
});

for (const trigger of [`setTimeout(() => { throw new Error('${secret}'); }, 0)`, `Promise.reject(new Error('${secret}'))`]) test('fatal handlers redact and exit nonzero', async () => {
  const proc = Bun.spawn([process.execPath, '-e', `import { installErrorHandlers } from './src/lib/egress'; installErrorHandlers(); ${trigger}`], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  safe({ err: await new Response(proc.stderr).text() });
  expect(await proc.exited).toBe(1);
});

for (const main of ['drain', 'steer', 'ship', 'usage']) test(`${main} strips opaque configured values without nearby sensitive words`, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'egress-exact-'));
  const values = ['quiet orchard /+?=', 'amber meadow /+?=', 'silver hillside /+?=', 'violet river /+?=', 'copper valley /+?=', 'gentle forest /+?=', 'bright harbor /+?=', 'winter garden /+?='];
  const names = ['CLIPROXY_MGMT_KEY', 'CLIPROXY_ACCESS_KEY', 'CLICKHOUSE_PASSWORD', 'CUSTOM_SECRET', 'CUSTOM_TOKEN', 'CUSTOM_KEY', 'CUSTOM_AUTH', 'CUSTOM_PASSWORD'];
  const variants = values.flatMap(v => [v, encodeURIComponent(v), Buffer.from(v).toString('base64')]);
  try {
    const config = join(dir, 'synthetic.env');
    writeFileSync(config, names.map((n, i) => `${n}="${values[i]}"`).join('\n'));
    const preload = join(dir, 'inject.ts');
    // Delay until startup env loaders have run; block all network access.
    writeFileSync(preload, `globalThis.fetch = () => new Promise(() => {}); ${main === 'usage' ? 'Bun.spawn = () => ({ stdout: new Response(\"\").body, exited: new Promise(() => {}), kill() {} });' : ''}\nsetTimeout(() => { throw new Error(${JSON.stringify('ordinary failure ' + 'distance '.repeat(30) + variants.join(' | '))}); }, 100);`);
    const result = await run(main, { TOKENLAYER_ENV: config, TOKENLAYER_ENV_FILES: config, TOKENLAYER_MACHINE: 'synthetic', TOKENLAYER_STATE_DIR: join(dir, 'state'), TOKENLAYER_SHIP_STATE: join(dir, 'ship.json'), ...(main === 'usage' ? Object.fromEntries(names.map((n, i) => [n, values[i]])) : {}) }, preload, main === 'steer' ? ['--once'] : []);
    expect(result.code).not.toBe(0);
    expect(result.err).toContain('[redacted]');
    for (const v of variants) expect(result.err).not.toContain(v);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('exact stripping precedes patterns, handles overlap and preserves case', async () => {
  const proc = Bun.spawn([process.execPath, '-e', `
    import { registerSecrets, sanitizeOutput, writeOut } from './src/lib/egress';
    registerSecrets({ A_KEY: 'quiet meadow', B_AUTH: 'quiet meadow extended', EMPTY_SECRET: '' });
    const input = 'quiet meadow extended | QUIET MEADOW | public count 123';
    if (sanitizeOutput(input) !== '[redacted] | QUIET MEADOW | public count 123') process.exit(3);
    writeOut(input);
  `], { cwd: root, env: { PATH: process.env.PATH }, stdout: 'pipe', stderr: 'pipe' });
  expect(await new Response(proc.stdout).text()).toBe('[redacted] | QUIET MEADOW | public count 123\n');
  expect(await proc.exited).toBe(0);
});
