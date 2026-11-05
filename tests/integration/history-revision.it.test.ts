import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, readdirSync, statSync, realpathSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { applySchema } from '../../src/lib/schema';
import { startLocalClickHouse } from '../../src/lib/local-clickhouse';
import { RESERVE } from '../../scripts/history/stream';
import { runImport } from '../../scripts/history/run';
import type { Source } from '../../scripts/history/source';
const hash = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
function fixture() {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'history-r1-'))), roots = join(dir, 'roots'), history = join(dir, 'history');
    mkdirSync(roots); mkdirSync(history, { mode: 0o700 });
    const source = (n: number, count: number, pad = 0, blanks = false) => {
        const id = `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, path = join(roots, `rollout-${id}.jsonl`);
        const lines = Array.from({ length: count }, (_, i) => JSON.stringify(i === 0 ? { type: 'session_meta', payload: { id } } : { type: 'event_msg', payload: { i, t: 'x'.repeat(pad) } }) + '\n');
        const raw = Buffer.from(lines.join('') + (blanks ? '\n'.repeat(200) : '')), prefix = lines.slice(0, 32).join('');
        writeFileSync(path, raw);
        return { path, kind: 'codex', sessionId: id, physicalSha256: hash(raw), decodedSha256: hash(raw), decodedBytes: raw.length, prefixBytes: Buffer.byteLength(prefix), prefixSha256: hash(prefix) } as Source;
    };
    const manifest = join(dir, 'manifest.json');
    return { dir, roots, history, source, manifest, options: { machine: 'm4', roots: [{ kind: 'codex' as const, dir: roots }], directory: history, liveStates: [] } };
}
test('R1 short-record default batches and 4000 distinct overlap hashes stay below native query cap', async () => {
    const local = await startLocalClickHouse({ keepFreeSpaceBytes: RESERVE }), f = fixture();
    try {
        await applySchema(local.client);
        expect((await local.client.exec("SELECT value FROM system.settings WHERE name='max_query_size'")).trim()).toBe('262144');
        for (const [n, pad] of [[1200, 120], [2000, 60], [4000, 0], [8000, 0]] as const) {
            const s = f.source(n, n, pad);
            writeFileSync(f.manifest, JSON.stringify({ machine: 'm4', sources: [s] }));
            await runImport(f.manifest, local.client, f.options);
        }
        // One 4000-row batch also exceeds the old overlap hash-list cap by itself.
        const s = f.source(4096, 4000);
        writeFileSync(f.manifest, JSON.stringify({ machine: 'm4', sources: [s] }));
        await runImport(f.manifest, local.client, { ...f.options, batchBytes: 512 * 1024 });
        const compressed = f.source(8001, 8000);
        writeFileSync(compressed.path + '.zst', Bun.zstdCompressSync(readFileSync(compressed.path)));
        unlinkSync(compressed.path); compressed.path += '.zst';
        compressed.physicalSha256 = hash(readFileSync(compressed.path));
        writeFileSync(f.manifest, JSON.stringify({ machine: 'm4', sources: [compressed] }));
        await runImport(f.manifest, local.client, f.options);
        expect(await local.client.exec('SELECT count() FROM tokenlayer.session_events FINAL')).toBe('27200\n');
    } finally { await local.stop(); }
}, 120000);
test('R1 cumulative multi-source audit exceeds injected cap while active state and receipts rotate', async () => {
    const local = await startLocalClickHouse({ keepFreeSpaceBytes: RESERVE }), f = fixture();
    try {
        await applySchema(local.client);
        const sources = Array.from({ length: 8 }, (_, i) => f.source(100 + i, 300, 80));
        writeFileSync(f.manifest, JSON.stringify({ machine: 'm4', sources }));
        const cap = 96 * 1024;
        const options = { ...f.options, batchBytes: 8192, stateBytesCap: cap, receiptBytesCap: 2048 };
        const dir = await runImport(f.manifest, local.client, options);
        const audit = join(dir, 'audit'), files = readdirSync(audit);
        const auditBytes = files.reduce((n, p) => n + statSync(join(audit, p)).size, 0);
        expect(auditBytes).toBeGreaterThan(cap);
        console.log(JSON.stringify({ revisionR1Audit: { sources: sources.length, rows: 2400, cap, auditBytes, segments: files.length, ledgerBytes: statSync(join(dir, 'ledger.ndjson')).size, receiptBytes: statSync(join(dir, 'receipts.ndjson')).size } }));
        expect(statSync(join(dir, 'ledger.ndjson')).size).toBeLessThan(cap);
        expect(statSync(join(dir, 'receipts.ndjson')).size).toBeLessThanOrEqual(2048);
        const before = new Map(files.map(p => [p, hash(readFileSync(join(audit, p)))]));
        await runImport(f.manifest, local.client, options);
        for (const [p, digest] of before) expect(hash(readFileSync(join(audit, p)))).toBe(digest);
        expect(await local.client.exec('SELECT count() FROM tokenlayer.session_events FINAL')).toBe('2400\n');
        const receipts = [...readdirSync(audit).filter(p => p.startsWith('receipts.')).map(p => readFileSync(join(audit, p), 'utf8')), readFileSync(join(dir, 'receipts.ndjson'), 'utf8')].join('');
        expect(receipts.match(/"state":"queue-complete"/g)?.length).toBe(2);
    } finally { await local.stop(); }
}, 120000);
test('R1 empty-only trailing batches checkpoint complete without inserting events', async () => {
    const local = await startLocalClickHouse({ keepFreeSpaceBytes: RESERVE }), f = fixture();
    try {
        await applySchema(local.client);
        const s = f.source(500, 40, 0, true);
        writeFileSync(f.manifest, JSON.stringify({ machine: 'm4', sources: [s] }));
        await runImport(f.manifest, local.client, { ...f.options, batchBytes: 1 });
        expect(await local.client.exec('SELECT count() FROM tokenlayer.session_events FINAL')).toBe('40\n');
    } finally { await local.stop(); }
}, 60000);

test('R1 rotation SIGKILL on either side of rename retains pending real-insert reconciliation and immutable audit', async () => {
    const { StreamingHistoryClient } = await import('../../scripts/history/stream');
    const { shipOnce } = await import('../../src/ship/ship');
    const local = await startLocalClickHouse({ keepFreeSpaceBytes: RESERVE }), f = fixture();
    try {
        await applySchema(local.client);
        const s = f.source(600, 32), ledger = join(f.history, 'ledger.ndjson');
        const opts = { ledger, manifest: 'rotation', run: 'first', sessionId: s.sessionId };
        const client = new StreamingHistoryClient(local.client.config, opts);
        const record = client.record.bind(client);
        client.record = (r, state) => { if (state === 'acked') throw Error('lost ack'); record(r, state); };
        await expect(shipOnce({ machine: 'm4', roots: f.options.roots, files: [s.path], statePath: join(f.history, 'state'), clickhouse: client, rateBytesPerSec: 0 })).rejects.toThrow();
        const pending = JSON.parse(readFileSync(ledger, 'utf8').trim().split('\n').at(-1)!);
        expect(pending.state).toBe('ambiguous');
        expect(await local.client.exec('SELECT count() FROM tokenlayer.session_events FINAL')).toBe('32\n');
        for (const phase of ['before', 'after']) {
            const terminal = { ...pending, state: 'acked', token: 'old', keys: [], pad: 'p'.repeat(64000) };
            const original = JSON.stringify(terminal) + '\n' + JSON.stringify(pending) + '\n';
            writeFileSync(ledger, original, { mode: 0o600 });
            const child = Bun.spawn([process.execPath, join(import.meta.dir, '../support/history-rotation-child.ts'), JSON.stringify({ ledger, pending, phase })], { stderr: 'pipe', stdout: 'pipe' });
            expect(await new Response(child.stderr).text()).toBe('');
            expect(await child.exited).not.toBe(0);
            const audit = join(f.history, 'audit'), archived = readdirSync(audit).filter(p => readFileSync(join(audit, p), 'utf8') === original);
            expect(archived.length).toBeGreaterThan(0);
            const recovery = new StreamingHistoryClient(local.client.config, { ...opts, run: 'recovery', stateBytesCap: 48 * 1024 });
            await recovery.reconcile();
            expect(readFileSync(ledger, 'utf8').trim().split('\n').at(-1)).toContain('"state":"acked"');
            expect(statSync(ledger).nlink).toBe(1);
            for (const p of archived) expect(readFileSync(join(audit, p), 'utf8')).toBe(original);
        }
        const partial = { ...pending, keys: pending.keys.map((k: object, i: number) => i ? k : { ...k, content_hash: '0'.repeat(64) }) };
        writeFileSync(ledger, JSON.stringify(partial) + '\n');
        const recovery = new StreamingHistoryClient(local.client.config, { ...opts, run: 'partial' });
        await expect(recovery.reconcile()).rejects.toThrow('ambiguous partial coverage');
        expect(JSON.parse(readFileSync(ledger, 'utf8').trim()).keys).toEqual(partial.keys);
        writeFileSync(ledger, JSON.stringify(pending));
        await expect(recovery.reconcile()).rejects.toThrow('torn history ledger');
        expect(readFileSync(ledger, 'utf8')).toBe(JSON.stringify(pending));
    } finally { await local.stop(); }
}, 60000);

test('R1 restart resumes at acknowledged offset after reconcile; FINAL mismatch blocks queue completion', async () => {
    const { ClickHouse } = await import('../../src/lib/clickhouse');
    const { loadState } = await import('../../src/ship/state');
    const local = await startLocalClickHouse({ keepFreeSpaceBytes: RESERVE }), f = fixture();
    const insert = ClickHouse.prototype.insert;
    try {
        await applySchema(local.client);
        const s = f.source(700, 400, 200);
        writeFileSync(f.manifest, JSON.stringify({ machine: 'm4', sources: [s] }));
        let inserts = 0;
        ClickHouse.prototype.insert = async function (...args) { if (++inserts === 4) throw Error('injected insert failure'); return insert.apply(this, args); };
        const options = { ...f.options, batchBytes: 8192 };
        await expect(runImport(f.manifest, local.client, options)).rejects.toThrow();
        ClickHouse.prototype.insert = insert;
        const dir = join(f.history, hash(readFileSync(f.manifest))), ledger = join(dir, 'ledger.ndjson');
        const cp = loadState(join(dir, hash(s.path) + '.json')).files[s.path];
        expect(cp.offset).toBeGreaterThan(0);
        const before = readFileSync(ledger, 'utf8').trim().split('\n').length;
        await runImport(f.manifest, local.client, options);
        const firstIntent = readFileSync(ledger, 'utf8').trim().split('\n').slice(before).map(l => JSON.parse(l)).find(r => r.state === 'intent');
        expect(firstIntent.start).toBe(cp.offset);
        expect(await local.client.exec('SELECT count() FROM tokenlayer.session_events FINAL')).toBe('400\n');
        // Real missing row behind an otherwise completed checkpoint must fail final acceptance.
        await local.client.exec(`ALTER TABLE tokenlayer.session_events DELETE WHERE byte_offset=${firstIntent.start} SETTINGS mutations_sync=2`);
        await expect(runImport(f.manifest, local.client, options)).rejects.toThrow('source FINAL nonempty LF count failed');
        expect(readFileSync(join(dir, 'receipts.ndjson'), 'utf8').trim().split('\n').at(-1)).toContain('"state":"stopped"');
    } finally { ClickHouse.prototype.insert = insert; await local.stop(); }
}, 60000);
