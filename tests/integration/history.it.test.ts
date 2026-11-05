import { expect, test, spyOn } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, statSync, unlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClickHouse } from '../../src/lib/clickhouse';
import { applySchema } from '../../src/lib/schema';
import { startLocalClickHouse } from '../../src/lib/local-clickhouse';
import { shipOnce } from '../../src/ship/ship';
import { loadState } from '../../src/ship/state';
import { createHash } from 'node:crypto';
const sha256Hex = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
import { StreamingHistoryClient, RESERVE, MARGIN, GiB } from '../../scripts/history/stream';
import { checkSpace } from '../../scripts/deploy/backfill';
import { runImport } from '../../scripts/history/run';
import type { Manifest, Source } from '../../scripts/history/source';
const fixture = () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'history-it-'))), roots = join(dir, 'roots'), history = join(dir, 'history');
    mkdirSync(roots);
    mkdirSync(history, { mode: 0o700 });
    const id = '00000000-0000-4000-8000-000000000001', path = join(roots, `rollout-${id}.jsonl`);
    const lines = Array.from({ length: 80 }, (_, i) => JSON.stringify(i === 0 ? { type: 'session_meta', timestamp: '2026-02-07T12:12:11.951Z', payload: { id } } :
        { type: 'event_msg', ...(i % 2 ? { timestamp: '2026-02-07T12:12:11.969Z' } : {}), payload: { type: 'fixture', n: i % 3 } }) + '\n');
    const raw = Buffer.from(lines.join('')), prefix = Buffer.from(lines.slice(0, 32).join(''));
    writeFileSync(path, raw);
    const source: Source = { path, kind: 'codex', sessionId: id, physicalSha256: sha256Hex(raw), decodedSha256: sha256Hex(raw), decodedBytes: raw.length, prefixBytes: prefix.length, prefixSha256: sha256Hex(prefix) };
    const manifest = join(dir, 'manifest.json');
    writeFileSync(manifest, JSON.stringify({ machine: 'm4', sources: [source] } satisfies Manifest));
    return { dir, roots, history, id, path, raw, source, manifest };
};
const opts = (f: ReturnType<typeof fixture>, ch: ClickHouse) => ({ machine: 'm4', roots: [{ kind: 'codex' as const, dir: f.roots }], directory: f.history, liveStates: [], batchBytes: 300 });
test('real native importer: 32 pilot, autonomous continuation, replay, twin and original lineage', async () => {
    const local = await startLocalClickHouse({ keepFreeSpaceBytes: RESERVE }), f = fixture();
    try {
        await applySchema(local.client);
        const receipt = await runImport(f.manifest, local.client, { ...opts(f, local.client), pilotOnly: true });
        expect(await local.client.exec('SELECT count() FROM tokenlayer.session_events FINAL')).toBe('32\n');
        const keys = await local.client.exec('SELECT machine,path,generation,byte_offset,content_hash FROM tokenlayer.session_events FINAL ORDER BY byte_offset');
        expect(statSync(join(receipt, 'ledger.ndjson')).mode & 0o777).toBe(0o600);
        const cli = Bun.spawn([process.execPath, join(import.meta.dir, '../../scripts/history/run.ts'), '--manifest', f.manifest], { env: {
                PATH: process.env.PATH, HOME: f.dir, TOKENLAYER_ENV_FILES: join(f.dir, 'missing.env'), TOKENLAYER_MACHINE: 'm4', TOKENLAYER_CODEX_DIR: f.roots,
                CLICKHOUSE_URL: local.client.config.url, CLICKHOUSE_USER: 'default', CLICKHOUSE_PASSWORD: '', CLICKHOUSE_DB: 'tokenlayer'
            }, stdout: 'pipe', stderr: 'pipe' });
        expect(await new Response(cli.stderr).text()).toBe('');
        expect(await cli.exited).toBe(0);
        expect(await new Response(cli.stdout).text()).toContain('history receipt directory=');
        expect(await local.client.exec('SELECT count() FROM tokenlayer.session_events FINAL')).toBe('80\n');
        // Different importer state/batch boundaries preserve normal shipper keys.
        const other = join(f.dir, 'other');
        mkdirSync(other, { mode: 0o700 });
        await runImport(f.manifest, local.client, { ...opts(f, local.client), directory: other, batchBytes: 999 });
        expect(await local.client.exec('SELECT count() FROM tokenlayer.session_events FINAL')).toBe('80\n');
        expect(await local.client.exec(`SELECT machine,path,generation,byte_offset,content_hash FROM tokenlayer.session_events FINAL WHERE byte_offset<${f.source.prefixBytes} ORDER BY byte_offset`)).toBe(keys);
        writeFileSync(f.path + '.zst', Bun.zstdCompressSync(f.raw));
        expect((await shipOnce({ machine: 'm4', roots: opts(f, local.client).roots, clickhouse: local.client, statePath: join(f.dir, 'live'), rateBytesPerSec: 0 })).lines).toBe(80);
        const live = readFileSync(join(f.dir, 'live'));
        unlinkSync(f.path);
        f.source.path += '.zst';
        f.source.physicalSha256 = sha256Hex(readFileSync(f.source.path));
        writeFileSync(f.manifest, JSON.stringify({ machine: 'm4', sources: [f.source] }));
        await runImport(f.manifest, local.client, { ...opts(f, local.client), liveStates: [join(f.dir, 'live')] });
        expect(readFileSync(join(f.dir, 'live'))).toEqual(live);
        expect(await local.client.exec('SELECT count() FROM tokenlayer.session_events FINAL')).toBe('80\n');
        expect(await local.client.exec('SELECT count() FROM tokenlayer.proxy_usage')).toBe('0\n');
    }
    finally {
        await local.stop();
    }
}, 60000);
test('real insert guards: low/unknown/reserved space, old floor, stop and ambiguous recovery', async () => {
    const local = await startLocalClickHouse({ keepFreeSpaceBytes: RESERVE }), f = fixture();
    try {
        await applySchema(local.client);
        const options = { ledger: join(f.history, 'ledger'), manifest: 'fixture', run: 'test', sessionId: f.id };
        const client = new StreamingHistoryClient(local.client.config, options);
        const query = client.queryJSON.bind(client);
        const mock = spyOn(client, 'queryJSON').mockImplementation(async (sql: string) => sql.includes('system.disks') ?
            [{ free_space: '0', unreserved_space: '0', keep_free_space: String(RESERVE) }] as any : query(sql));
        const ship = { machine: 'm4', roots: opts(f, client).roots, clickhouse: client, statePath: join(f.history, 'state'), rateBytesPerSec: 0, batchBytes: 300 };
        await expect(shipOnce(ship)).rejects.toThrow();
        expect(await local.client.exec('SELECT count() FROM tokenlayer.session_events FINAL')).toBe('0\n');
        mock.mockRestore();
        const headroom=StreamingHistoryClient.prototype.headroom;
        const low=spyOn(StreamingHistoryClient.prototype,'headroom').mockImplementation(async function(this:StreamingHistoryClient,bytes:number) {
            const disk=spyOn(this,'queryJSON').mockResolvedValue([{free_space:'0',unreserved_space:'0',keep_free_space:String(RESERVE)}] as any);
            try {await headroom.call(this,bytes);} finally {disk.mockRestore();}
        });
        try {await expect(runImport(f.manifest,local.client,opts(f,local.client))).rejects.toThrow('history low space');} finally {low.mockRestore();}
        const stoppedReceipt=readFileSync(join(f.history,createHash('sha256').update(readFileSync(f.manifest)).digest('hex'),'receipts.ndjson'),'utf8');
        expect(stoppedReceipt).toContain('history low space');expect(stoppedReceipt).toContain('"state":"stopped"');
        expect(await local.client.exec('SELECT count() FROM tokenlayer.session_events FINAL')).toBe('0\n');
        const old = spyOn(local.client, 'queryJSON').mockResolvedValue([{ free_space: String(19 * GiB), keep_free_space: String(RESERVE), compressed: '0', uncompressed: '0' }] as any);
        await expect(checkSpace(local.client, 0)).rejects.toThrow('>= 35 GiB');
        old.mockRestore();
        let stopped = false;
        const guarded = new StreamingHistoryClient(local.client.config, { ...options, shouldStop: () => stopped });
        const insert = guarded.insert.bind(guarded);
        guarded.insert = async (...args) => { await insert(...args); stopped = true; };
        const result = await shipOnce({ ...ship, clickhouse: guarded, shouldStop: () => stopped });
        expect(result.lines).toBeGreaterThan(0);
        expect(result.lines).toBeLessThan(80);
        expect(loadState(ship.statePath).files[f.path].offset).toBe(result.bytes);
        // Real insert, lost response: intent/ambiguous survives without checkpoint advancement.
        const lost = new StreamingHistoryClient(local.client.config, { ...options, ledger: join(f.history, 'lost') });
        const record = lost.record.bind(lost);
        lost.record = (r, s) => { if (s === 'acked')
            throw Error('lost ack'); record(r, s); };
        const missing = join(f.history, 'lost-state');
        await expect(shipOnce({ ...ship, clickhouse: lost, statePath: missing, maxLines: 32 })).rejects.toThrow();
        const recovered = new StreamingHistoryClient(local.client.config, { ...options, ledger: join(f.history, 'lost') });
        await recovered.reconcile();
        expect(readFileSync(join(f.history, 'lost'), 'utf8').trim().split('\n').at(-1)).toContain('"state":"acked"');
        await shipOnce({ ...ship, clickhouse: recovered, statePath: missing, maxLines: 32, batchBytes: 1000 });
        expect(await local.client.exec('SELECT count() FROM tokenlayer.session_events FINAL')).toBe('32\n');
        await expect(client.headroom(1)).resolves.toBeUndefined();
        const bad = spyOn(client, 'queryJSON').mockResolvedValue([{ free_space: 'unknown' }] as any);
        await expect(client.headroom(1)).rejects.toThrow();
        bad.mockRestore();
    }
    finally {
        await local.stop();
    }
}, 60000);
test('real SIGKILL after insert before ack/checkpoint re-queries intent and replays different boundaries', async () => {
    const local = await startLocalClickHouse({ keepFreeSpaceBytes: RESERVE }), f = fixture();
    try {
        await applySchema(local.client);
        const clientOptions = { ledger: join(f.history, 'kill-ledger'), manifest: 'kill-fixture', run: 'child', sessionId: f.id };
        const options = { machine: 'm4', roots: opts(f, local.client).roots, statePath: join(f.history, 'kill-state'), rateBytesPerSec: 0, maxLines: 32, batchBytes: f.raw.length };
        const child = Bun.spawn([process.execPath, join(import.meta.dir, '../support/history-crash-child.ts'), JSON.stringify({ config: local.client.config, options, clientOptions })], { stdout: 'pipe', stderr: 'pipe' });
        const error = await new Response(child.stderr).text();
        expect(await child.exited).not.toBe(0);
        expect(error).toBe('');
        expect(await local.client.exec('SELECT count() FROM tokenlayer.session_events FINAL')).toBe('32\n');
        expect(loadState(options.statePath).files[f.path]?.offset ?? 0).toBe(0);
        expect(readFileSync(clientOptions.ledger, 'utf8').trim().split('\n').at(-1)).toContain('"state":"intent"');
        const client = new StreamingHistoryClient(local.client.config, { ...clientOptions, run: 'recovery' });
        await client.reconcile();
        expect(readFileSync(clientOptions.ledger, 'utf8').trim().split('\n').at(-1)).toContain('"state":"acked"');
        await shipOnce({ ...options, clickhouse: client, batchBytes: 300 });
        expect(await local.client.exec('SELECT count() FROM tokenlayer.session_events FINAL')).toBe('32\n');
    }
    finally {
        await local.stop();
    }
}, 60000);
test('native queue stops on copy ambiguity, bad pins, mutation and a stop before dispatch', async () => {
    const local = await startLocalClickHouse({ keepFreeSpaceBytes: RESERVE }), f = fixture();
    try {
        await applySchema(local.client);
        await runImport(f.manifest, local.client, { ...opts(f, local.client), pilotOnly: true });
        const copy = join(f.roots, `copy-${f.id}.jsonl`);
        writeFileSync(copy, f.raw);
        const source = { ...f.source, path: copy };
        writeFileSync(f.manifest, JSON.stringify({ machine: 'm4', sources: [source] }));
        await expect(runImport(f.manifest, local.client, opts(f, local.client))).rejects.toThrow();
        expect(await local.client.exec('SELECT count() FROM tokenlayer.session_events FINAL')).toBe('32\n');
        source.physicalSha256 = '0'.repeat(64);
        writeFileSync(f.manifest, JSON.stringify({ machine: 'm4', sources: [source] }));
        await expect(runImport(f.manifest, local.client, opts(f, local.client))).rejects.toThrow('source pin mismatch');
        const { verifySource } = await import('../../scripts/history/source');
        const check = await verifySource(f.source, opts(f, local.client).roots);
        writeFileSync(f.path, f.raw.subarray(0, -1));
        expect(check).toThrow('source mutated');
        const stopped = new StreamingHistoryClient(local.client.config, { ledger: join(f.history, 'stop'), manifest: 'fixture', run: 'stop', sessionId: f.id, shouldStop: () => true });
        await expect(stopped.insert('session_events', [{}], 'token')).rejects.toThrow('stopped before insert');
    }
    finally {
        await local.stop();
    }
}, 60000);
test('autonomous epochs exceed the pilot and refresh after actual serialization budget exhaustion', async () => {
    const local = await startLocalClickHouse({ keepFreeSpaceBytes: RESERVE }), f = fixture();
    try {
        await applySchema(local.client);
        const head = f.raw.toString().split('\n')[0] + '\n';
        const line = JSON.stringify({ type: 'event_msg', payload: { text: 'x'.repeat(512 * 1024) } }) + '\n';
        const raw = Buffer.from(head + line.repeat(79)), prefix = Buffer.from(head + line.repeat(31));
        writeFileSync(f.path, raw);
        const source = { ...f.source, physicalSha256: sha256Hex(raw), decodedSha256: sha256Hex(raw), decodedBytes: raw.length, prefixBytes: prefix.length, prefixSha256: sha256Hex(prefix) };
        writeFileSync(f.manifest, JSON.stringify({ machine: 'm4', sources: [source] }));
        const id2='00000000-0000-4000-8000-000000000002';
        const raw2=Buffer.from(f.raw.toString().replaceAll(f.id,id2));
        const path2=join(f.roots,`rollout-${id2}.jsonl`);writeFileSync(path2,raw2);
        const prefix2=Buffer.from(raw2.toString().split('\n').slice(0,32).join('\n')+'\n');
        const second={...f.source,path:path2,sessionId:id2,physicalSha256:sha256Hex(raw2),decodedSha256:sha256Hex(raw2),decodedBytes:raw2.length,prefixBytes:prefix2.length,prefixSha256:sha256Hex(prefix2)};
        writeFileSync(f.manifest,JSON.stringify({machine:'m4',sources:[source,second]}));
        const dir = await runImport(f.manifest, local.client, { ...opts(f, local.client), epochBytes: 512 * 1024 ** 2, batchBytes: 256 * 1024 });
        const receipts = readFileSync(join(dir, 'receipts.ndjson'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
        expect(receipts.some(r => !r.pilot && r.state === 'stopped')).toBe(true);
        expect(receipts.some(r => !r.pilot && r.epoch > 1 && r.state === 'epoch')).toBe(true);
        expect(await local.client.exec('SELECT count() FROM tokenlayer.session_events FINAL')).toBe('160\n');
        expect(receipts.at(-1).state).toBe('queue-complete');
    }
    finally {
        await local.stop();
    }
}, 60000);

test('fresh compressed native pilot uses decoded generation, original path and real raw months', async () => {
    const local=await startLocalClickHouse({keepFreeSpaceBytes:RESERVE}),f=fixture();
    try {
        await applySchema(local.client);
        writeFileSync(f.path+'.zst',Bun.zstdCompressSync(f.raw));unlinkSync(f.path);
        const source={...f.source,path:f.path+'.zst',physicalSha256:sha256Hex(readFileSync(f.path+'.zst'))};
        writeFileSync(f.manifest,JSON.stringify({machine:'m4',sources:[source]}));
        await runImport(f.manifest,local.client,{...opts(f,local.client),pilotOnly:true});
        const rows=await local.client.queryJSON<{machine:string;path:string;generation:string;n:string}>('SELECT machine,path,generation,count() AS n FROM tokenlayer.session_events FINAL GROUP BY machine,path,generation');
        expect(rows.map(r=>({...r,n:Number(r.n)}))).toEqual([{machine:'m4',path:f.path,generation:source.decodedSha256.slice(0,16),n:32}]);
        expect(await local.client.exec('SELECT DISTINCT toYYYYMM(ts) FROM tokenlayer.session_events FINAL ORDER BY 1')).toBe('197001\n202602\n');
        await runImport(f.manifest,local.client,{...opts(f,local.client),pilotOnly:true,batchBytes:1000});
        expect(await local.client.exec('SELECT count() FROM tokenlayer.session_events FINAL')).toBe('32\n');
    } finally {await local.stop();}
},60000);
