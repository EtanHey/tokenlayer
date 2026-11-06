import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { historyFixtureDirectories } from '../fixtures/history-temp';
import { startLocalClickHouse } from '../../src/lib/local-clickhouse';
import { applySchema } from '../../src/lib/schema';
import { createHash } from 'node:crypto';
import { RESERVE } from '../../scripts/history/stream';
import type { Source } from '../../scripts/history/source';

const temp = historyFixtureDirectories('history-batching-'), MiB = 1024 ** 2;
const sha256Hex = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
async function cli(home: string, args: string[], env: Record<string, string> = {}) {
    const started = performance.now();
    const child = Bun.spawn([process.execPath, join(import.meta.dir, '../../scripts/history/run.ts'), ...args], {
        env: { PATH: process.env.PATH, HOME: home, TOKENLAYER_ENV_FILES: join(home, 'missing.env'), ...env }, stdout: 'pipe', stderr: 'pipe',
    });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { out, err, code, elapsedMs: performance.now() - started };
}

test('CLI batch flag rejects malformed, missing, duplicate and ambiguous forms before configuration/state', async () => {
    const cases = [[], ['0'], ['-1'], ['4194305'], ['1.5'], ['NaN'], ['Infinity'], ['1e6'], ['0x100'], ['+1'], [' 1'], [''],
        ['--pilot-only'], ['1', '--batch-bytes', '2']];
    for (const values of cases) {
        const home = temp(), result = await cli(home, ['--manifest', join(home, 'absent.json'), '--batch-bytes', ...values]);
        expect(result.code).not.toBe(0);
        expect(result.err).toContain('--batch-bytes');
        expect(result.err).not.toContain('TOKENLAYER_MACHINE required');
        expect(existsSync(join(home, '.config'))).toBe(false);
    }
    for (const args of [['--batch-bytes=4194304'], ['--batch-bytes='], ['--batch-bytes', '1', '--batch-bytes=2'], ['--batch-bytes', '1', '2'],
        ['--batch-bytes-extra', '1'], ['--batch-bytes', '1', '--batch-bytes', '1']]) {
        const home = temp(), result = await cli(home, ['--manifest', join(home, 'absent.json'), ...args]);
        expect(result.code).not.toBe(0); expect(result.err).toContain('--batch-bytes');
        expect(existsSync(join(home, '.config'))).toBe(false);
    }
    for (const value of ['1', '262144', '4194304']) {
        const result = await cli(temp(), ['--manifest', '/absent-synthetic.json', '--batch-bytes', value]);
        expect(result.err).toContain('TOKENLAYER_MACHINE required');
    }
    expect((await cli(temp(), ['--help'])).out).toContain('--batch-bytes');
});

test('actual CLI batching: default/1MiB/4MiB imports and fresh-state cross-window replay preserve native rows', async () => {
    const local = await startLocalClickHouse({ keepFreeSpaceBytes: RESERVE });
    let requests = 0, inserts = 0;
    // Observe actual HTTP requests; forward every response from the real isolated binary unchanged.
    const observer = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
        requests++;
        const url = new URL(req.url); if (url.searchParams.get('query')?.startsWith('INSERT')) inserts++;
        const headers = new Headers(req.headers); headers.set('accept-encoding', 'identity');
        return fetch(local.client.config.url + url.pathname + url.search, { method: req.method, headers, body: await req.arrayBuffer() });
    } });
    try {
        await applySchema(local.client);
        const fixture = temp(), root = join(fixture, 'roots'); mkdirSync(root);
        const expected: Record<string, unknown>[] = [], sources: Source[] = [];
        for (const compressed of [false, true]) {
            const id = `00000000-0000-4000-8000-0000000000${compressed ? '42' : '41'}`;
            const lines = Array.from({ length: 128 }, (_, i) => JSON.stringify(i === 0 ? { type: 'session_meta', payload: { id } } :
                { type: 'event_msg', payload: { text: 'é🙂\\\t'.repeat(1500), n: i % 3 } }) + '\n');
            const raw = Buffer.from(lines.join('')), prefix = Buffer.from(lines.slice(0, 32).join(''));
            const path = join(root, `rollout-${id}.jsonl`), physical = compressed ? Buffer.from(Bun.zstdCompressSync(raw)) : raw;
            const source: Source = { path: path + (compressed ? '.zst' : ''), kind: 'codex', sessionId: id, physicalSha256: sha256Hex(physical),
                decodedSha256: sha256Hex(raw), decodedBytes: raw.length, prefixBytes: prefix.length, prefixSha256: sha256Hex(prefix) };
            writeFileSync(source.path, physical); sources.push(source);
            const st = statSync(source.path), generation = compressed ? source.decodedSha256.slice(0, 16) : sha256Hex(`${st.dev}:${st.ino}:${st.birthtimeMs}`).slice(0, 16);
            let offset = 0;
            for (const line of lines) {
                expected.push({ machine: 'batch-fixture', path, generation, byte_offset: String(offset), content_hash: sha256Hex(line),
                    raw_sha: sha256Hex(line).toUpperCase(), line_bytes: Buffer.byteLength(line), session_id: offset === 0 ? id : '' });
                offset += Buffer.byteLength(line);
            }
        }
        const manifest = join(fixture, 'manifest.json'); writeFileSync(manifest, JSON.stringify({ machine: 'batch-fixture', sources }));
        const snapshot = () => local.client.queryJSON('SELECT machine,path,generation,toString(byte_offset) AS byte_offset,content_hash,hex(SHA256(raw)) AS raw_sha,line_bytes,session_id FROM tokenlayer.session_events FINAL ORDER BY path,toUInt64(byte_offset)');
        const run = async (label: string, batch?: number) => {
            const home = temp(); requests = 0; inserts = 0;
            const result = await cli(home, ['--manifest', manifest, ...(batch === undefined ? [] : ['--batch-bytes', String(batch)])], {
                TOKENLAYER_MACHINE: 'batch-fixture', TOKENLAYER_CODEX_DIR: root, CLICKHOUSE_URL: `http://127.0.0.1:${observer.port}`,
                CLICKHOUSE_USER: 'default', CLICKHOUSE_PASSWORD: '', CLICKHOUSE_DB: 'tokenlayer',
            });
            const dir = join(home, '.config/tokenlayer/history-import', sha256Hex(readFileSync(manifest)));
            const receipts = existsSync(join(dir, 'receipts.ndjson')) ? readFileSync(join(dir, 'receipts.ndjson'), 'utf8') : '';
            const evidence = process.env.TOKENLAYER_BATCHING_EVIDENCE;
            if (evidence) {
                // Preserve diagnostics before any assertion or fixture teardown, including failed arms.
                for (const [suffix, bytes] of Object.entries({stdout: result.out, stderr: result.err, exit: String(result.code), 'receipts.ndjson': receipts}))
                    writeFileSync(join(evidence, `${label}.${suffix}`), bytes, {mode: 0o600, flag: 'wx'});
                if (existsSync(join(dir, 'ledger.ndjson')))
                    writeFileSync(join(evidence, `${label}.ledger.ndjson`), readFileSync(join(dir, 'ledger.ndjson')), {mode: 0o600, flag: 'wx'});
            }
            if (result.err || result.code !== 0)
                throw Error(`batching CLI arm failed: ${JSON.stringify({label, code: result.code, stderr: result.err, importerReceipts: receipts || 'NOT_CREATED'})}`);
            expect(result.err).toBe(''); expect(result.code).toBe(0);
            const records = readFileSync(join(dir, 'ledger.ndjson'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
            const intents = records.filter(r => r.state === 'intent'), acked = records.filter(r => r.state === 'acked');
            expect(intents.length).toBeGreaterThan(0); expect(records.length).toBe(2 * intents.length);
            expect(acked).toEqual(intents.map(r => ({ ...r, state: 'acked' })));
            for (const r of intents) {
                const k = r.keys[0];
                expect(r.token).toBe(sha256Hex(`${k.machine}\0${k.path}\0${k.generation}\0${r.start}\0${r.end}\0${r.rowsHash}`));
            }
            expect(receipts).toContain('queue-complete');
            const actual = await snapshot(); expect(actual).toEqual(expected);
            if (evidence) {
                writeFileSync(join(evidence, `${label}.expected.json`), JSON.stringify(expected), {mode: 0o600, flag: 'wx'});
                writeFileSync(join(evidence, `${label}.actual.json`), JSON.stringify(actual), {mode: 0o600, flag: 'wx'});
            }
            const measurement = { label, batchBytes: batch ?? 262144, requests, inserts, batches: intents.length, elapsedMs: result.elapsedMs,
                rows: expected.length, decodedBytes: sources.reduce((n, s) => n + s.decodedBytes, 0), ledgerSha256: sha256Hex(readFileSync(join(dir, 'ledger.ndjson'))) };
            console.log(JSON.stringify(measurement));
            return { ...measurement, tokens: intents.map(r => r.token) };
        };
        const baseline = await run('default-import');
        const replayLarge = await run('4MiB-replay', 4 * MiB); expect(replayLarge.inserts).toBe(0);
        await local.client.exec('TRUNCATE TABLE tokenlayer.session_events');
        const middle = await run('1MiB-import', MiB);
        await local.client.exec('TRUNCATE TABLE tokenlayer.session_events');
        const large = await run('4MiB-import', 4 * MiB);
        const replaySmall = await run('256KiB-replay', 256 * 1024); expect(replaySmall.inserts).toBe(0);
        expect(replaySmall.tokens).toEqual(baseline.tokens); expect(replayLarge.tokens).toEqual(large.tokens);
        expect(middle.batches).toBeLessThan(baseline.batches); expect(large.batches).toBeLessThan(middle.batches);
        expect(await local.client.exec('SELECT count() FROM tokenlayer.proxy_usage')).toBe('0\n');
    } finally { await observer.stop(true); await local.stop(); }
}, 60000);
