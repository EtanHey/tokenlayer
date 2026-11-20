import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readUse, useBlocks, useSql } from '../../src/usage/use';

const now = Date.parse('2026-11-19T12:00:00Z');
// JSONEachRow as ClickHouse returns it: 64-bit counts quoted, an all-NULL sum as null. Values invented.
const rows = [
  { v: 'kiro', s1: '1', s7: '1', r1: '89', r7: '89', i1: '0', i7: '0', o1: '0', o7: '0', c1: 9.25, c7: 9.25 },
  { v: 'codex', s1: '4', s7: '1009', r1: '3', r7: '43933', i1: '0', i7: '132196718', o1: '0', o7: '21240223', c1: null, c7: null },
  { v: 'antigravity', s1: '7', s7: '415', r1: '130', r7: '1765', i1: '879254', i7: '8608230', o1: '63726', o7: '2874654', c1: null, c7: null },
];
const observed_at = new Date(now).toISOString(), source = 'clickhouse:session_events';

test('use blocks carry sessions, requests, tokens for Antigravity and Codex, credits for Kiro, per 24 h and 7 d', () => {
  expect(useBlocks(rows, observed_at)).toEqual({
    antigravity: { observed_at, source, '24h': { sessions: 7, requests: 130, input_tokens: 879254, output_tokens: 63726, credits: null },
      '7d': { sessions: 415, requests: 1765, input_tokens: 8608230, output_tokens: 2874654, credits: null } },
    kiro: { observed_at, source, '24h': { sessions: 1, requests: 89, input_tokens: null, output_tokens: null, credits: 9.25 },
      '7d': { sessions: 1, requests: 89, input_tokens: null, output_tokens: null, credits: 9.25 } },
    codex: { observed_at, source, '24h': { sessions: 4, requests: 3, input_tokens: 0, output_tokens: 0, credits: null },
      '7d': { sessions: 1009, requests: 43933, input_tokens: 132196718, output_tokens: 21240223, credits: null } },
  });
});

test('a vendor with no rows in the window counts zero, and Kiro with no known credits stays null', () => {
  const quiet = { sessions: 0, requests: 0, input_tokens: null, output_tokens: null, credits: null };
  const u = useBlocks([], observed_at);
  expect(u.kiro).toEqual({ observed_at, source, '24h': quiet, '7d': quiet });
  expect(u.antigravity!['7d']).toEqual({ sessions: 0, requests: 0, input_tokens: 0, output_tokens: 0, credits: null });
  expect(Object.keys(u)).toEqual(['antigravity', 'kiro', 'codex']);
});

test('recent events are time-bounded and Codex history lookup has explicit read, memory and time caps', () => {
  const sql = useSql(now);
  expect(sql).toContain(`fromUnixTimestamp64Milli(${now})-INTERVAL 1 DAY AS d`);
  expect(sql).toContain('ts>=d-INTERVAL 6 DAY AND ts<=d+INTERVAL 1 DAY');
  expect(sql).toContain("(machine,path) IN (SELECT p FROM recent WHERE v='codex')");
  expect(sql).toContain("max_rows_to_read=20000000,max_bytes_to_read=8e9,read_overflow_mode='throw'");
  expect(sql).toMatch(/max_memory_usage=2e9,max_execution_time=20$/);
});

test('without a store address readUse reports the gap and sends nothing', async () => {
  const off = { observed_at: null, source, last_error: 'store unavailable' };
  expect(await readUse(now, {})).toEqual({ antigravity: off, kiro: off, codex: off });
});

test('readUse posts the query with header credentials and maps the reply; a ClickHouse exception is a gap', async () => {
  const seen: { user: string | null; key: string | null; url: string; body: string }[] = [];
  let fail = false;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    seen.push({ user: req.headers.get('x-clickhouse-user'), key: req.headers.get('x-clickhouse-key'), url: req.url, body: await req.text() });
    return fail ? new Response('Code: 241. DB::Exception: synthetic', { headers: { 'X-ClickHouse-Exception-Code': '241' } })
      : new Response(rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  } });
  try {
    const env = { CLICKHOUSE_URL: `http://127.0.0.1:${server.port}`, CLICKHOUSE_USER: 'reader', CLICKHOUSE_PASSWORD: 'synthetic-key' };
    expect(await readUse(now, env)).toEqual(useBlocks(rows, observed_at));
    expect(seen[0]).toMatchObject({ user: 'reader', key: 'synthetic-key', body: useSql(now) });
    expect(new URL(seen[0]!.url).searchParams.get('default_format')).toBe('JSONEachRow');
    expect(seen[0]!.url).not.toContain('synthetic-key');
    fail = true;
    expect((await readUse(now, env)).kiro).toEqual({ observed_at: null, source, last_error: 'store unavailable' });
  } finally { server.stop(true); }
});


test('default reader loads standard dotenv files with clickhouse overrides without exposing credentials', async () => {
  const home = mkdtempSync(join(tmpdir(), 'usage-env-'));
  const seen: (string | null)[][] = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(req) {
    seen.push([req.headers.get('x-clickhouse-user'), req.headers.get('x-clickhouse-key')]);
    return new Response('');
  } });
  try {
    const dir = join(home, '.config/tokenlayer');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'ship.env'), `export CLICKHOUSE_URL=http://127.0.0.1:${server.port}
CLICKHOUSE_USER=old
CLICKHOUSE_PASSWORD=old
`, { mode: 0o600 });
    writeFileSync(join(dir, 'clickhouse.env'), `# standard dotenv quoting
export CLICKHOUSE_USER=reader
CLICKHOUSE_PASSWORD="synthetic # value=with punctuation"
`, { mode: 0o600 });
    const proc = Bun.spawn([process.execPath, '-e', `import { readUse } from ${JSON.stringify(resolve('src/usage/use.ts'))}; console.log(JSON.stringify(await readUse(${now})));`],
      { env: { ...process.env, HOME: home }, stdout: 'pipe', stderr: 'pipe' });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect(code).toBe(0);
    expect(err).toBe('');
    expect(JSON.parse(out)).toEqual(useBlocks([], observed_at));
    expect(seen).toEqual([['reader', 'synthetic # value=with punctuation']]);
    expect(out).not.toContain('synthetic # value');
  } finally { server.stop(true); rmSync(home, { recursive: true, force: true }); }
});
