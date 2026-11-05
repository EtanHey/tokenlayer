import { expect, test, spyOn } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { historyFixtureDirectories } from '../fixtures/history-temp';
import { join } from 'node:path';
import { ClickHouse } from '../../src/lib/clickhouse';
import { applySchema } from '../../src/lib/schema';
import { startLocalClickHouse } from '../../src/lib/local-clickhouse';
import { sha256Hex } from '../../src/lib/hash';
import { runImport } from '../../scripts/history/run';
import { StreamingHistoryClient, RESERVE } from '../../scripts/history/stream';
const dir = historyFixtureDirectories('history-n4n9-');
const row = (i: number) => ({ machine: 'm4', path: '/native/source', generation: 'g', byte_offset: i * 10,
    content_hash: sha256Hex(String(i)), line_bytes: 10, session_id: `owner-${String(i).padStart(80, '0')}`, session_alias: '', ts: '2026-02-07 00:00:00.000', raw: '{}\n' });
const fixture = () => {
    const root = dir(), roots = join(root, 'roots'), history = join(root, 'history');
    mkdirSync(roots); mkdirSync(history, { mode: 0o700 });
    const id = '00000000-0000-4000-8000-000000000099', path = join(roots, `rollout-${id}.jsonl`);
    const raw = Buffer.from(Array.from({ length: 32 }, (_, i) => JSON.stringify(i ? { type: 'event_msg', payload: { i } } : { type: 'session_meta', payload: { id } }) + '\n').join(''));
    writeFileSync(path, raw);
    const source = { path, kind: 'codex', sessionId: id, physicalSha256: sha256Hex(raw.toString('utf8')), decodedSha256: sha256Hex(raw.toString('utf8')), decodedBytes: raw.length, prefixBytes: raw.length, prefixSha256: sha256Hex(raw.toString('utf8')) };
    const manifest = join(root, 'manifest.json'); writeFileSync(manifest, JSON.stringify({ machine: 'm4', sources: [source] }));
    return { root, history, manifest, options: { machine: 'm4', roots: [{ kind: 'codex' as const, dir: roots }], directory: history, liveStates: [], pilotOnly: true } };
};
test('N4 real owner discovery runs once per owner chunk, stays fresh, and checks every hash chunk', async () => {
    const local = await startLocalClickHouse({ keepFreeSpaceBytes: RESERVE }), root = dir(), rows = Array.from({ length: 1000 }, (_, i) => row(i));
    const queries: string[] = [], exec = ClickHouse.prototype.exec;
    const capture = spyOn(ClickHouse.prototype, 'exec').mockImplementation(function(this: ClickHouse, sql: string) { queries.push(sql); return exec.call(this, sql); });
    try {
        await applySchema(local.client);
        await local.client.insert('session_events', [{ ...row(1001), machine: 'other', path: "/native/owner'\\", session_id: 'native' }]);
        const client = new StreamingHistoryClient(local.client.config, { ledger: join(root, 'ledger'), manifest: 'n4', run: 'n4', sessionId: 'native' });
        queries.length = 0; await client.insert('session_events', rows, 'batch1');
        const owners = queries.filter(q => q.includes('session_id IN'));
        expect(owners.length).toBe(2); // 1001 escaped owner literals split at 48 KiB; 2 hash chunks must not multiply scans.
        for (const q of owners) {
            expect(q).toContain('SELECT DISTINCT machine,path');
            expect(q).toContain('max_threads=2'); expect(q).toContain('max_memory_usage=536870912');
            expect(q).toContain('max_result_rows=4096'); expect(q).toContain("result_overflow_mode='throw'");
        }
        const checks = queries.filter(q => q.includes('AND content_hash IN'));
        expect(checks.length).toBe(2); for (const q of checks) expect(q).not.toContain('SELECT DISTINCT');
        queries.length = 0; await client.insert('session_events', rows, 'batch2');
        expect(queries.filter(q => q.includes('session_id IN')).length).toBe(2);
        // Concurrent copy appears between batches, including a hash in the last chunk.
        await local.client.insert('session_events', [{ ...rows.at(-1)!, machine: 'other', path: '/native/new-copy' }]);
        const ledger = readFileSync(join(root, 'ledger'));
        await expect(client.insert('session_events', rows, 'batch3')).rejects.toThrow('overlap');
        expect(readFileSync(join(root, 'ledger'))).toEqual(ledger);
        expect(await local.client.exec('SELECT count() FROM tokenlayer.session_events FINAL')).toBe('1002\n');
        console.log(JSON.stringify({ N4: { rows: rows.length, ownerChunks: owners.length, hashChecks: checks.length, maxQueryBytes: Math.max(...queries.map(q => Buffer.byteLength(q))) } }));
    } finally { capture.mockRestore(); await local.stop(); }
}, 60000);
test('N4 real importer matrices carry the same explicit resource bounds', async () => {
    const local = await startLocalClickHouse({ keepFreeSpaceBytes: RESERVE }), f = fixture(), queries: string[] = [];
    const exec = ClickHouse.prototype.exec;
    const capture = spyOn(ClickHouse.prototype, 'exec').mockImplementation(function(this: ClickHouse, sql: string) { queries.push(sql); return exec.call(this, sql); });
    try {
        await applySchema(local.client); await runImport(f.manifest, local.client, f.options);
        const matrices = queries.filter(q => q.includes('GROUP BY machine,harness,month'));
        expect(matrices.length).toBe(3);
        for (const q of matrices) { expect(q).toContain('max_threads=2'); expect(q).toContain('max_memory_usage=536870912'); expect(q).toContain('max_execution_time=30'); }
        expect(await local.client.exec('SELECT count() FROM tokenlayer.session_events FINAL')).toBe('32\n');
    } finally { capture.mockRestore(); await local.stop(); }
}, 60000);
test('N9 zero/unknown local space refuses before ledger append or HTTP; importer refuses before local writes', async () => {
    const local = await startLocalClickHouse({ keepFreeSpaceBytes: RESERVE });
    try {
        await applySchema(local.client);
        for (const sample of [{ bsize: 4096n, bavail: 0n }, { bsize: 0n, bavail: 1n }, { bsize: 4096n }, undefined]) {
            const f = fixture(), ledger = join(f.history, 'ledger');
            const localSpace = () => sample;
            const client = new StreamingHistoryClient(local.client.config, { ledger, manifest: 'n9', run: 'n9', sessionId: 'native', localSpace } as any);
            await expect(client.insert('session_events', [row(0)], 'blocked')).rejects.toThrow('local history');
            expect(existsSync(ledger)).toBe(false);
            await expect(runImport(f.manifest, local.client, { ...f.options, localSpace } as any)).rejects.toThrow('local history');
            expect(readdirSync(f.history)).toEqual([]);
        }
        expect(await local.client.exec('SELECT count() FROM tokenlayer.session_events FINAL')).toBe('0\n');
    } finally { await local.stop(); }
}, 60000);
test('N4 real owner result overflow fails closed without ledger; empty owner set skips hash checks', async () => {
    const local = await startLocalClickHouse({ keepFreeSpaceBytes: RESERVE }), root = dir();
    try {
        await applySchema(local.client);
        const client = new StreamingHistoryClient(local.client.config, { ledger: join(root, 'ledger'), manifest: 'bounds', run: 'bounds', sessionId: 'native' });
        const queries: string[] = [], query = client.queryJSON.bind(client);
        const capture = spyOn(client, 'queryJSON').mockImplementation((sql: string) => { queries.push(sql); return query(sql) as any; });
        await client.insert('session_events', [row(0)], 'empty-owners');
        expect(queries.filter(q => q.includes('AND content_hash IN')).length).toBe(0);
        capture.mockRestore();
        await local.client.insert('session_events', Array.from({ length: 4097 }, (_, i) => ({ ...row(i + 1), machine: 'other', path: `/native/path-${i}`, session_id: 'native' })));
        const before = readFileSync(join(root, 'ledger'));
        await expect(client.insert('session_events', [row(0)], 'overflow')).rejects.toThrow();
        expect(readFileSync(join(root, 'ledger'))).toEqual(before);
        expect(await local.client.exec("SELECT count() FROM tokenlayer.session_events FINAL WHERE machine='m4'")).toBe('1\n');
    } finally { await local.stop(); }
}, 60000);
test('N9 exact local floor includes pending bytes; append/rotation recheck without changing retained bytes', async () => {
    const { AuditLog, LOCAL_FLOOR, PENDING_CAP, localHeadroom } = await import('../../scripts/history/journal');
    const root = dir(), path = join(root, 'ledger');
    const enough = (extra: number) => () => ({ bsize: 1n, bavail: BigInt(LOCAL_FLOOR + extra) });
    expect(() => localHeadroom(root, 4096, enough(4096))).not.toThrow();
    expect(() => localHeadroom(root, 4096, enough(4095))).toThrow('local history low space');
    expect(() => localHeadroom(root, PENDING_CAP + 1, enough(PENDING_CAP + 1))).toThrow('pending allocation');
    expect(() => localHeadroom(root, 0, () => { throw Error('statfs failed'); })).toThrow('unknown local history');
    let available = BigInt(LOCAL_FLOOR + 65536);
    const log = new AuditLog(path, 4096, () => ({ bsize: 1n, bavail: available }));
    log.append({ state: 'retained' }); const before = readFileSync(path);
    available = 0n;
    expect(() => log.append({ state: 'blocked' })).toThrow('local history low space');
    expect(() => log.rotate([{ state: 'pending' }])).toThrow('local history low space');
    expect(readFileSync(path)).toEqual(before);
    expect(existsSync(path + '.next')).toBe(false); expect(existsSync(join(root, 'audit'))).toBe(false);
});
test('N9 local-space drop after initial receipt stops guarded checkpoint writes with zero ingestion', async () => {
    const local = await startLocalClickHouse({ keepFreeSpaceBytes: RESERVE }), f = fixture();
    const stateDir = join(f.history, sha256Hex(readFileSync(f.manifest, 'utf8'))), receipt = join(stateDir, 'receipts.ndjson');
    try {
        await applySchema(local.client);
        let before = Buffer.alloc(0);
        const localSpace = () => {
            if (existsSync(receipt)) { before = readFileSync(receipt); return { bsize: 1n, bavail: 0n }; }
            return { bsize: 1n, bavail: BigInt(30 * 1024 ** 3) };
        };
        await expect(runImport(f.manifest, local.client, { ...f.options, localSpace })).rejects.toThrow('local history low space');
        expect(readFileSync(receipt)).toEqual(before);
        expect(readFileSync(receipt, 'utf8')).toContain('"state":"before"');
        expect(readdirSync(stateDir)).toEqual(['receipts.ndjson']);
        expect(existsSync(join(f.history, 'writer.lock'))).toBe(false);
        expect(await local.client.exec('SELECT count() FROM tokenlayer.session_events FINAL')).toBe('0\n');
    } finally { await local.stop(); }
}, 60000);
