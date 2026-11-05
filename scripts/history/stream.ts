import { closeSync, existsSync, fsyncSync, openSync, readFileSync, statSync, writeSync } from 'node:fs';
import { ClickHouse, encodeRow, type ClickHouseConfig } from '../../src/lib/clickhouse';
import { sha256Hex } from '../../src/lib/hash';
export const GiB = 1024 ** 3, RESERVE = 15 * GiB, MARGIN = 2 * GiB;
const MiB = 1024 ** 2, BASE = 384 * MiB, MAX_LEDGER = 64 * MiB;
export const sqlString = (s: string) => `'${s.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
type Key = {
    machine: string;
    path: string;
    generation: string;
    byte_offset: number;
    content_hash: string;
};
type Intent = {
    token: string;
    keys: Key[];
    rowsHash: string;
    start: number;
    end: number;
};
type RecordState = Intent & {
    state: string;
    manifest: string;
    run: string;
};
export class EpochFull extends Error {
}
/** Single in-flight batch; append/fsync intent before HTTP, ack before ship checkpoint. */
export class StreamingHistoryClient extends ClickHouse {
    used = BASE;
    stopped = false;
    lastFailure?: unknown;
    constructor(config: ClickHouseConfig, readonly options: {
        ledger: string;
        manifest: string;
        run: string;
        epochBytes?: number;
        sessionId: string;
        shouldStop?: () => boolean;
        verifySource?: (extraBytes?: number) => void;
    }) { super(config); }
    record(intent: Intent, state: string) {
        const record: RecordState = { ...intent, state, manifest: this.options.manifest, run: this.options.run };
        const bytes = JSON.stringify(record) + '\n';
        if ((existsSync(this.options.ledger) ? statSync(this.options.ledger).size : 0) + Buffer.byteLength(bytes) > MAX_LEDGER)
            throw Error('history ledger cap reached');
        const fd = openSync(this.options.ledger, 'a', 0o600);
        try {
            writeSync(fd, bytes);
            fsyncSync(fd);
        }
        finally {
            closeSync(fd);
        }
    }
    async coverage(keys: Key[]) {
        const tuples = keys.map(k => `(${[k.machine, k.path, k.generation].map(sqlString).join(',')},${k.byte_offset},${sqlString(k.content_hash)})`);
        const [row] = await this.queryJSON<{
            n: string;
        }>(`SELECT count() AS n FROM tokenlayer.session_events FINAL
      WHERE (machine,path,generation,byte_offset,content_hash) IN (${tuples.join(',')}) SETTINGS max_execution_time=20`);
        if (!row || !/^\d+$/.test(String(row.n)))
            throw Error('unknown native coverage');
        return Number(row.n);
    }
    async reconcile() {
        if (!existsSync(this.options.ledger))
            return;
        if (statSync(this.options.ledger).size > MAX_LEDGER)
            throw Error('history ledger exceeds cap');
        const text = readFileSync(this.options.ledger, 'utf8');
        if (text && !text.endsWith('\n'))
            throw Error('torn history ledger; reconcile retained intent before resuming');
        const pending = new Map<string, RecordState>();
        for (const line of text.split('\n').filter(Boolean)) {
            const r = JSON.parse(line) as RecordState;
            if (r.manifest !== this.options.manifest)
                throw Error('ledger manifest mismatch');
            if (['acked', 'retry'].includes(r.state))
                pending.delete(r.token);
            else
                pending.set(r.token, r);
        }
        for (const r of pending.values()) {
            const n = await this.coverage(r.keys);
            if (n !== 0 && n !== r.keys.length)
                throw Error('ambiguous partial coverage; stopped');
            this.record(r, n ? 'acked' : 'retry');
        }
    }
    async headroom(allocation: number) {
        const started = Date.now();
        const [d] = await this.queryJSON<{
            free_space: string;
            unreserved_space: string;
            keep_free_space: string;
        }>("SELECT free_space,unreserved_space,keep_free_space FROM system.disks WHERE name='default' SETTINGS max_execution_time=10");
        if (Date.now() - started > 15000 || !d || [d.free_space, d.unreserved_space, d.keep_free_space].some(v => !/^\d+$/.test(String(v)) || !Number.isSafeInteger(Number(v))))
            throw Error('unknown or stale history headroom');
        const free = Math.min(Number(d.free_space), Number(d.unreserved_space));
        if (free - Math.max(0, RESERVE - Number(d.keep_free_space)) - MARGIN - allocation < 0)
            throw Error('history low space: preserve 15 GiB reserve + 2 GiB margin');
    }
    override async insert(table: string, input: readonly unknown[], token?: string) {
        try {
            if (table !== 'session_events' || !token || !input.length)
                throw Error('history accepts tokenized session_events only');
            if (this.options.shouldStop?.())
                throw Error('history stopped before insert');
            this.options.verifySource?.();
            // Preflight bounds before encoding; ship's source verifier caps each record at 1 MiB.
            if (input.length > 4096 || Buffer.byteLength(JSON.stringify(input)) > 16 * MiB)
                throw Error('history batch exceeds serialization bound');
            const bytes = input.reduce<number>((n, r) => n + encodeRow(r).length + 1, 0);
            if (bytes > 128 * MiB)
                throw Error('history payload cap exceeded');
            const charge = 5 * bytes;
            if (this.used + charge > (this.options.epochBytes ?? GiB))
                throw new EpochFull('history epoch exhausted');
            const rows = input as (Key & {
                line_bytes: number;
                session_id: string;
                session_alias: string;
            })[];
            const keys = rows.map(({ machine, path, generation, byte_offset, content_hash }) => ({ machine, path, generation, byte_offset, content_hash }));
            const intent: Intent = { token, keys, rowsHash: sha256Hex(JSON.stringify(input)), start: rows[0].byte_offset, end: rows.at(-1)!.byte_offset + rows.at(-1)!.line_bytes };
            const sessions = [...new Set([this.options.sessionId, ...rows.flatMap(r => [r.session_id, r.session_alias])].filter(Boolean))];
            if (!sessions.length)
                throw Error('unresolved native owner');
            const k = keys[0];
            const [overlap] = await this.queryJSON<{
                n: string;
            }>(`SELECT count() AS n FROM tokenlayer.session_events FINAL
        WHERE (machine,path) IN (SELECT DISTINCT machine,path FROM tokenlayer.session_events FINAL
          WHERE session_id IN (${sessions.map(sqlString)}) OR session_alias IN (${sessions.map(sqlString)}) OR position(path,${sqlString(this.options.sessionId)})>0)
        AND content_hash IN (${[...new Set(keys.map(k => k.content_hash))].map(sqlString)})
        AND NOT (machine=${sqlString(k.machine)} AND path=${sqlString(k.path)} AND generation=${sqlString(k.generation)}) SETTINGS max_execution_time=20`);
            if (!overlap || Number(overlap.n) !== 0)
                throw Error('unresolved native copy/generation overlap');
            const covered = await this.coverage(keys);
            await this.headroom(this.used + charge);
            this.options.verifySource?.();
            if (this.options.shouldStop?.())
                throw Error('history stopped before dispatch');
            // Leave room for both terminal receipt and a recovery receipt before dispatch.
            if ((existsSync(this.options.ledger) ? statSync(this.options.ledger).size : 0) + 4 * Buffer.byteLength(JSON.stringify(intent)) > MAX_LEDGER)
                throw Error('history ledger cap reached');
            this.options.verifySource?.(4*Buffer.byteLength(JSON.stringify(intent))+1024**2);
            this.record(intent, 'intent');
            this.used += charge;
            try {
                if (covered !== keys.length)
                    await super.insert(table, input, token);
                this.record(intent, 'acked');
            }
            catch (e) {
                this.record(intent, 'ambiguous');
                throw e;
            }
        }
        catch (e) {
            this.stopped = true;
            this.lastFailure = e;
            throw e;
        }
    }
}
