import { expect, test, spyOn } from 'bun:test';
import { mkdirSync, writeFileSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { historyFixtureDirectories } from '../fixtures/history-temp';
import { startLocalClickHouse } from '../../src/lib/local-clickhouse';
import { applySchema } from '../../src/lib/schema';
import { ClickHouse, RAW_BYTES, encodeRow } from '../../src/lib/clickhouse';
import { createHash } from 'node:crypto';
const sha256Hex = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
import { shipOnce } from '../../src/ship/ship';
import { boundedRowsBytes, rowBytes } from '../../src/lib/row-size';
import { StreamingHistoryClient, RESERVE } from '../../scripts/history/stream';
import { LOCAL_FLOOR } from '../../scripts/history/journal';
const temp = historyFixtureDirectories('large-cli-'), MiB = 1024 ** 2;

test('full CLI: explicit 11/13 MiB history records at LF813 preserve raw/hash/offsets and replay', async () => {
    const local = await startLocalClickHouse({ keepFreeSpaceBytes: RESERVE });
    try {
        await applySchema(local.client);
        for (const compressed of [false, true]) {
            const home = temp(), root = join(home, 'roots'); mkdirSync(root);
            const id = `00000000-0000-4000-8000-0000000000${compressed ? '13' : '11'}`;
            const header = JSON.stringify({ type: 'session_meta', payload: { id } }) + '\n';
            const prefix = Buffer.from(header + '{}\n'.repeat(811));
            // One tool arguments blob and a native response_item/message with 13 content parts.
            const payload = compressed ? { type: 'message', role: 'user', content: Array.from({ length: 13 }, (_, i) => [1, 4, 7, 10].includes(i) ? { type: 'input_image', image_url: 'A'.repeat(13 * MiB / 4) } : { type: 'input_text', text: 'fixture' }) } :
                { type: 'function_call', arguments: '"'.repeat(11 * MiB / 2) };
            const big = Buffer.from(JSON.stringify({ timestamp: '2026-04-09T14:55:02.000Z', ordinal: 813, type: 'response_item', payload }) + '\n');
            const raw = Buffer.concat([prefix, big, Buffer.from('{}\n')]);
            const path = join(root, `rollout-${id}.jsonl`), physical = compressed ? Buffer.from(Bun.zstdCompressSync(raw)) : raw;
            const source = { path: path + (compressed ? '.zst' : ''), kind: 'codex', sessionId: id, physicalSha256: sha256Hex(physical), decodedSha256: sha256Hex(raw), decodedBytes: raw.length,
                prefixBytes: Buffer.byteLength(header + '{}\n'.repeat(31)), prefixSha256: sha256Hex(header + '{}\n'.repeat(31)) };
            writeFileSync(source.path, physical);
            const manifest = join(home, 'manifest.json'); writeFileSync(manifest, JSON.stringify({ machine: 'm4', sources: [source] }));
            const cli = async (optIn: boolean) => {
                const child = Bun.spawn([process.execPath, join(import.meta.dir, '../../scripts/history/run.ts'), '--manifest', manifest,
                    ...(optIn ? ['--max-record-bytes', String(16 * MiB)] : [])], { env: { PATH: process.env.PATH, HOME: home,
                    TOKENLAYER_ENV_FILES: join(home, 'missing.env'), TOKENLAYER_MACHINE: 'm4', TOKENLAYER_CODEX_DIR: root,
                    CLICKHOUSE_URL: local.client.config.url, CLICKHOUSE_USER: 'default', CLICKHOUSE_PASSWORD: '', CLICKHOUSE_DB: 'tokenlayer' }, stdout: 'pipe', stderr: 'pipe' });
                const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
                return { out, err, code };
            };
            const refused = await cli(false); expect(refused.code).not.toBe(0); expect(refused.err).toContain('record exceeds 1 MiB');
            const sql = `FROM tokenlayer.session_events FINAL WHERE path='${path}'`;
            expect(await local.client.exec(`SELECT count() ${sql}`)).toBe('0\n');
            const accepted = await cli(true); expect(accepted.err).toBe(''); expect(accepted.code).toBe(0);
            expect(accepted.out).toContain('history receipt directory=');
            const rows = await local.client.queryJSON<{ n: string; hash: string; bytes: string; offset: string }>(`SELECT toString(count()) AS n,hex(SHA256(raw)) AS hash,toString(line_bytes) AS bytes,toString(byte_offset) AS offset ${sql} AND byte_offset=${prefix.length} GROUP BY raw,line_bytes,byte_offset`);
            expect(rows).toEqual([{ n: '1', hash: sha256Hex(big).toUpperCase(), bytes: String(big.length), offset: String(prefix.length) }]);
            expect(await local.client.exec(`SELECT count() ${sql}`)).toBe('814\n');
            expect(await local.client.exec(`SELECT byte_offset ${sql} ORDER BY byte_offset`)).toBe([0, ...Array.from({ length: 811 }, (_, i) => Buffer.byteLength(header) + 3 * i), prefix.length, prefix.length + big.length].join('\n') + '\n');
            const st = statSync(source.path), generation = compressed ? source.decodedSha256.slice(0, 16) : sha256Hex(`${st.dev}:${st.ino}:${st.birthtimeMs}`).slice(0, 16);
            expect(await local.client.exec(`SELECT DISTINCT generation ${sql}`)).toBe(generation + '\n');
            const tuples = await local.client.exec(`SELECT generation,byte_offset,content_hash,hex(SHA256(raw)) ${sql} ORDER BY byte_offset`);
            const replay = await cli(true); expect(replay.err).toBe(''); expect(replay.code).toBe(0);
            expect(await local.client.exec(`SELECT generation,byte_offset,content_hash,hex(SHA256(raw)) ${sql} ORDER BY byte_offset`)).toBe(tuples);
            const dir = join(home, '.config/tokenlayer/history-import', sha256Hex(readFileSync(manifest)));
            const records = readFileSync(join(dir, 'ledger.ndjson'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
            expect(records.filter(r => r.state === 'intent').length).toBe(records.filter(r => r.state === 'acked').length);
            const receipt = readFileSync(join(dir, 'receipts.ndjson'), 'utf8'); expect(receipt).toContain('queue-complete');
        }
        expect(await local.client.exec('SELECT count() FROM tokenlayer.session_events FINAL')).toBe('1628\n');
        expect(await local.client.exec('SELECT count() FROM tokenlayer.proxy_usage')).toBe('0\n');
    } finally { await local.stop(); }
}, 60000);

test('serialization exact sizes, unchanged 128 MiB cap, 4096 rows, local pending and low hub space refuse before insert', async () => {
    const local = await startLocalClickHouse({ keepFreeSpaceBytes: RESERVE });
    try {
        await applySchema(local.client);
        const dir = temp(), raw = Buffer.concat([Buffer.from([0, 1, 9, 10, 13, 34, 92, 255]), Buffer.from('é🙂')]);
        const special = { raw: raw.toString(), [RAW_BYTES]: raw, text: '\ud800\u0000\b\f\\"é🙂' };
        expect(rowBytes(special)).toBe(Buffer.byteLength(JSON.stringify(special)));
        expect(rowBytes(special, true)).toBe(encodeRow(special).length);
        expect(boundedRowsBytes([special], 128 * MiB, true)).toBe(encodeRow(special).length + 1);
        const exact = encodeRow(special).length + 1;
        expect(boundedRowsBytes([special], exact, true)).toBe(exact);
        expect(() => boundedRowsBytes([special], exact - 1, true)).toThrow('payload cap');
        const row = { machine: 'm4', path: '/synthetic', generation: 'fixture', byte_offset: 0, content_hash: sha256Hex(raw), line_bytes: raw.length, session_id: 'fixture', session_alias: '', raw: raw.toString(), [RAW_BYTES]: raw };
        const make = (name: string, extra = {}) => new StreamingHistoryClient(local.client.config, { ledger: join(dir, name), manifest: 'fixture', run: name, sessionId: 'fixture', ...extra });
        const serial = make('serial');
        await expect(serial.insert('session_events', Array(4097).fill(row), 'token')).rejects.toThrow('serialization bound');
        // A single bounded field repeated by reference: reject without allocating a >128 MiB JSON string.
        await expect(make('huge').insert('session_events', Array(9).fill({ ...row, raw: 'x'.repeat(16 * MiB) }), 'token')).rejects.toThrow('serialization bound');
        const payload = make('payload');
        const control = Buffer.alloc(16 * MiB, 0);
        await expect(payload.insert('session_events', Array(2).fill({ ...row, raw: 'short', [RAW_BYTES]: control }), 'token')).rejects.toThrow('payload cap');
        const low = make('low'); const query = low.queryJSON.bind(low);
        spyOn(low, 'queryJSON').mockImplementation(async (sql: string) => sql.includes('system.disks') ? [{ free_space: '0', unreserved_space: '0', keep_free_space: String(RESERVE) }] as any : query(sql));
        await expect(low.insert('session_events', [row], 'token')).rejects.toThrow('history low space');
        const localLow = make('local', { localSpace: () => ({ bsize: 1n, bavail: BigInt(LOCAL_FLOOR) }) });
        await expect(localLow.insert('session_events', [row], 'token')).rejects.toThrow('local history low space');
        expect(await local.client.exec('SELECT count() FROM tokenlayer.session_events FINAL')).toBe('0\n');
        for (const name of ['serial', 'huge', 'payload', 'low', 'local']) expect(existsSync(join(dir, name))).toBe(false);
        const covered = make('covered'); spyOn(covered, 'coverage').mockResolvedValue(1);
        await covered.insert('session_events', [row], 'covered-token');
        expect(covered.used).toBe(384 * MiB + 5 * (encodeRow(row).length + 1));
        expect(readFileSync(join(dir, 'covered'), 'utf8')).not.toContain('"raw"');
        // Real daemon path keeps baseline acceptance and the original token formula without importer options.
        const root = join(dir, 'roots'); mkdirSync(root);
        const rawLine = Buffer.from(JSON.stringify({ blob: 'x'.repeat(2 * MiB) }) + '\n');
        for (const compressed of [false, true]) {
            const path = join(root, `fixture-${compressed}.jsonl`);
            const physical = path + (compressed ? '.zst' : '');
            writeFileSync(physical, compressed ? Bun.zstdCompressSync(rawLine) : rawLine);
            const st = statSync(physical), generation = compressed ? sha256Hex(rawLine).slice(0, 16) : sha256Hex(`${st.dev}:${st.ino}:${st.birthtimeMs}`).slice(0, 16);
            const client = new ClickHouse(local.client.config), insert = client.insert.bind(client);
            client.insert = async (table, rows, token) => {
                expect(token).toBe(sha256Hex(`m4\0${path}\0${generation}\0${0}\0${rawLine.length}\0${sha256Hex(JSON.stringify(rows))}`));
                await insert(table, rows, token);
            };
            await shipOnce({ machine: 'm4', roots: [{ kind: 'codex', dir: root }], files: [physical], clickhouse: client, statePath: join(dir, `daemon-${compressed}`), rateBytesPerSec: 0 });
            expect(await local.client.exec(`SELECT hex(SHA256(raw)) FROM tokenlayer.session_events FINAL WHERE path='${path}'`)).toBe(sha256Hex(rawLine).toUpperCase() + '\n');
        }
        expect(await local.client.exec('SELECT count() FROM tokenlayer.session_events FINAL')).toBe('2\n');
    } finally { await local.stop(); }
}, 60000);
