import { expect, test } from 'bun:test';
import { linkSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StreamingHistoryClient } from '../../scripts/history/stream';
import { sha256Hex } from '../../src/lib/hash';

function latch() {
    let release!: () => void;
    const promise = new Promise<void>(resolve => { release = resolve; });
    return { promise, release };
}
const row = (i: number) => ({ machine: 'fixture', path: '/synthetic/history', generation: 'g',
    byte_offset: i * 10, content_hash: sha256Hex(String(i)), line_bytes: 10,
    session_id: 'native', session_alias: '', raw: '{}\n' });

for (const mode of ['terminal-stop', 'terminal-continue', 'recovered-full', 'recovered-zero', 'recovered-partial'] as const) {
    test(`terminal-ledger await: ${mode}`, async () => {
        const directory = mkdtempSync(join(process.env.TOKENLAYER_TEST_ARTIFACT_DIR ?? tmpdir(), 'history-stop-'));
        const ledger = join(directory, 'ledger.ndjson'), stored = new Set<string>(), inserts: string[] = [];
        const recovered = mode.startsWith('recovered'), stoppedMode = mode !== 'terminal-continue';
        const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
            const url = new URL(req.url), sql = url.searchParams.get('query') ?? await req.text();
            if (sql.startsWith('INSERT INTO tokenlayer.session_events ')) {
                const token = url.searchParams.get('insert_deduplication_token')!;
                inserts.push(token);
                const rows = (await req.text()).trim().split('\n').map(line => JSON.parse(line));
                for (const [i, r] of rows.entries()) {
                    if (token !== 'prior' || (mode !== 'recovered-zero' && (mode !== 'recovered-partial' || i === 0))) stored.add(r.content_hash);
                }
                return new Response('', { status: recovered && token === 'prior' ? 500 : 200 });
            }
            if (sql.includes('SELECT DISTINCT machine,path')) return new Response('');
            if (sql.includes('SELECT count() AS n')) return Response.json({ n: String([...stored].filter(hash => sql.includes(`'${hash}'`)).length) });
            if (sql.includes('FROM system.disks')) return Response.json({ free_space: String(100 * 1024 ** 3), unreserved_space: String(100 * 1024 ** 3), keep_free_space: '0' });
            throw Error(`unexpected fixture query: ${sql}`);
        } });
        let stopped = false, sourceChecks = 0, finalSourceChecks = 0, reads = 0, released = false;
        const held = latch(), resume = latch();
        const client = new StreamingHistoryClient({ url: server.url.href, user: '', password: '', database: 'tokenlayer' }, {
            ledger, manifest: 'fixture', run: 'fixture', sessionId: 'native', stateBytesCap: 8192,
            localSpace: () => ({ bsize: 1n, bavail: 1n << 60n }), shouldStop: () => stopped,
            verifySource: extra => { sourceChecks++; if (extra) finalSourceChecks++; },
        });
        try {
            const seed = client.insert('session_events', [row(0), row(1)], 'prior');
            if (recovered) await expect(seed).rejects.toThrow('HTTP 500');
            else await seed;
            const before = readFileSync(ledger), used = client.used;
            expect(JSON.parse(before.toString().trim().split('\n').at(-1)!).state).toBe(recovered ? 'ambiguous' : 'acked');
            // A real shared inode forces the insert's conditional reconcile path.
            const retained = join(directory, 'retained.ndjson');
            linkSync(ledger, retained);
            const records = client.ledger.records.bind(client.ledger);
            client.ledger.records = async function* () {
                for await (const record of records()) { reads++; yield record; }
                held.release();
                await resume.promise;
            };
            sourceChecks = 0; finalSourceChecks = 0;
            const batch = [row(2)], token = 'new-batch';
            const operation = client.insert('session_events', batch, token).then(() => undefined, e => e as Error);
            await held.promise;
            expect(reads).toBe(2);
            expect(sourceChecks).toBe(2);
            expect(client.used).toBe(used);
            expect(inserts).toEqual(['prior']);
            expect(readFileSync(ledger)).toEqual(before);
            stopped = stoppedMode;
            resume.release(); released = true;
            const error = await operation;
            const active = readFileSync(ledger, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
            const fresh = active.filter(record => record.token === token);
            const charge = client.used - used, dispatches = inserts.filter(t => t === token).length;
            console.log(JSON.stringify({ mode, reads, stopped, intents: fresh.filter(r => r.state === 'intent').length,
                charge, dispatches, acks: fresh.filter(r => r.state === 'acked').length,
                recovery: active.filter(r => r.token === 'prior').map(r => r.state), error: error?.message, directory }));
            expect(readFileSync(retained)).toEqual(before);
            expect(readdirSync(join(directory, 'audit')).length).toBe(1);
            if (stoppedMode) {
                expect(error).toBeInstanceOf(Error);
                expect(error?.message).toContain(mode === 'recovered-partial' ? 'ambiguous partial coverage' : 'history stopped before dispatch');
                expect(fresh).toEqual([]);
                expect(charge).toBe(0);
                expect(dispatches).toBe(0);
                expect(client.stopped).toBe(true);
                expect(client.lastFailure).toBe(error);
                if (recovered) expect(active.map(r => r.state)).toEqual(mode === 'recovered-partial' ? ['ambiguous'] : ['ambiguous', mode === 'recovered-full' ? 'acked' : 'retry']);
            } else {
                expect(error).toBeUndefined();
                expect(fresh.map(r => r.state)).toEqual(['intent', 'acked']);
                expect(charge).toBeGreaterThan(0);
                expect(dispatches).toBe(1);
                expect(finalSourceChecks).toBe(1);
                expect(client.stopped).toBe(false);
            }
        } finally {
            if (!released) resume.release();
            server.stop(true);
        }
    });
}
