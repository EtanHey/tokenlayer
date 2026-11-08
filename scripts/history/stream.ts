import { ClickHouse, fixed, type ClickHouseConfig } from '../../src/lib/clickhouse';
import { boundedRowsBytes } from '../../src/lib/row-size';
import { sha256Hex } from '../../src/lib/hash';
import { AuditLog, localHeadroom, STATE_CAP, type LocalSpace } from './journal';
import { dirname } from 'node:path';
export const GiB = 1024 ** 3, RESERVE = 15 * GiB, MARGIN = 2 * GiB;
const MiB = 1024 ** 2, BASE = 384 * MiB;
export const sqlString = (s: string) => `'${s.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
// Each list is byte bounded, including SQL escaping. Combined overlap queries use
// at most three lists; leave room below the server's unchanged 256 KiB default.
function chunks(items: string[]) {
    const groups: string[][] = []; let group: string[] = [], bytes = 0;
    for (const item of items) {
        const n = Buffer.byteLength(item) + 1;
        if (n > 48 * 1024) throw Error('single native SQL key exceeds bound');
        if (bytes + n > 48 * 1024) { groups.push(group); group = []; bytes = 0; }
        group.push(item); bytes += n;
    }
    if (group.length) groups.push(group);
    return groups;
}
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
    readonly ledger: AuditLog;
    stopped = false;
    lastFailure?: unknown;
    constructor(config: ClickHouseConfig, readonly options: {
        ledger: string;
        manifest: string;
        run: string;
        epochBytes?: number;
        stateBytesCap?: number;
        localSpace?: LocalSpace;
        stateBytesUsed?: () => number;
        sessionId: string;
        shouldStop?: () => boolean;
        verifySource?: (extraBytes?: number) => void;
    }) { super(config); fixed(this); this.ledger = new AuditLog(options.ledger, options.stateBytesCap, options.localSpace); }
    record(intent: Intent, state: string) {
        const record: RecordState = { ...intent, state, manifest: this.options.manifest, run: this.options.run };
        this.ledger.append(record);
    }
    async count(sql: string) {
        if (Buffer.byteLength(sql) > 192 * 1024) throw Error('native SQL query exceeds bound');
        const [row] = await this.queryJSON<{ n: string }>(sql);
        if (!row || !/^\d+$/.test(String(row.n)) || !Number.isSafeInteger(Number(row.n))) throw Error('unknown native coverage');
        return Number(row.n);
    }
    async coverage(keys: Key[]) {
        const tuples = [...new Set(keys.map(k => `(${[k.machine, k.path, k.generation].map(sqlString).join(',')},${k.byte_offset},${sqlString(k.content_hash)})`))];
        let n = 0;
        for (const group of chunks(tuples)) n += await this.count(`SELECT count() AS n FROM tokenlayer.session_events FINAL
          WHERE (machine,path,generation,byte_offset,content_hash) IN (${group.join(',')}) SETTINGS max_execution_time=20`);
        return n;
    }
    async reconcile() {
        const pending = new Map<string, RecordState>();
        for await (const r of this.ledger.records()) {
            if (r.manifest !== this.options.manifest) throw Error('ledger manifest mismatch');
            if (['acked', 'retry'].includes(r.state)) pending.delete(r.token);
            else if (['intent', 'ambiguous'].includes(r.state)) pending.set(r.token, r);
            else throw Error('unknown history ledger state');
            if (Buffer.byteLength(JSON.stringify([...pending.values()])) > this.ledger.cap / 2)
                throw Error('unresolved history exceeds active cap');
        }
        // Preserve every old record in immutable audit, and retain unresolved intents
        // atomically before writing terminal reconciliation receipts.
        if (this.ledger.shared() || this.ledger.size() > this.ledger.cap / 2) this.ledger.rotate([...pending.values()]);
        for (const r of pending.values()) {
            const n = await this.coverage(r.keys);
            if (n !== 0 && n !== r.keys.length) throw Error('ambiguous partial coverage; stopped');
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
            if (table === 'session_events' && token && !input.length) return; // Blank-only LF batch has no event keys.
            if (table !== 'session_events' || !token)
                throw Error('history accepts tokenized session_events only');
            if (this.options.shouldStop?.())
                throw Error('history stopped before insert');
            this.options.verifySource?.();
            // Bound token JSON and exact byte-preserving JSONEachRow independently,
            // before any encoding allocation, ledger append or HTTP dispatch.
            if (input.length > 4096) throw Error('history batch exceeds serialization bound');
            boundedRowsBytes(input);
            const bytes = boundedRowsBytes(input, 128 * MiB, true);
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
            const hashes = chunks([...new Set(keys.map(k => sqlString(k.content_hash)))]);
            // Fresh union for this batch only. Never multiply whole-table owner scans by hash chunks.
            const paths = new Set<string>(); let pathBytes = 0;
            for (const owners of chunks(sessions.map(sqlString))) {
                const sql = `SELECT DISTINCT machine,path FROM tokenlayer.session_events FINAL
          WHERE session_id IN (${owners.join(',')}) OR session_alias IN (${owners.join(',')}) OR position(path,${sqlString(this.options.sessionId)})>0
          SETTINGS max_execution_time=20,max_threads=2,max_memory_usage=536870912,max_result_rows=4096,max_result_bytes=2097152,result_overflow_mode='throw'`;
                if (Buffer.byteLength(sql) > 192 * 1024) throw Error('native SQL query exceeds bound');
                const found = await this.queryJSON<{ machine: string; path: string }>(sql);
                for (const p of found) {
                    if (typeof p.machine !== 'string' || typeof p.path !== 'string') throw Error('unknown native owner path');
                    const tuple = `(${sqlString(p.machine)},${sqlString(p.path)})`;
                    if (!paths.has(tuple)) { paths.add(tuple); pathBytes += Buffer.byteLength(tuple) + 1; }
                    if (paths.size > 4096 || pathBytes > 2 * MiB) throw Error('native owner union exceeds bound');
                }
            }
            for (const owners of chunks([...paths])) for (const group of hashes) {
                const overlap = await this.count(`SELECT count() AS n FROM tokenlayer.session_events FINAL
        WHERE (machine,path) IN (${owners.join(',')})
        AND content_hash IN (${group.join(',')})
        AND NOT (machine=${sqlString(k.machine)} AND path=${sqlString(k.path)} AND generation=${sqlString(k.generation)}) SETTINGS max_execution_time=20`);
                if (overlap !== 0) throw Error('unresolved native copy/generation overlap');
            }
            const covered = await this.coverage(keys);
            await this.headroom(this.used + charge);
            this.options.verifySource?.();
            if (this.options.shouldStop?.())
                throw Error('history stopped before dispatch');
            // Previous batches are terminal here. Rotate only after reconciliation,
            // reserving enough space for intent, terminal/ambiguous and recovery records.
            const reserved = 4 * Buffer.byteLength(JSON.stringify({ ...intent, state: 'ambiguous', manifest: this.options.manifest, run: this.options.run })) + 1024;
            if (reserved > this.ledger.cap) throw Error('single history batch exceeds active cap');
            // Bound all pending ledger/recovery, two checkpoint replacements and one receipt segment.
            localHeadroom(dirname(this.options.ledger), reserved + 2 * STATE_CAP + 16 * MiB, this.options.localSpace);
            if (this.ledger.shared() || (this.options.stateBytesUsed?.() ?? this.ledger.size()) + reserved > this.ledger.cap) {
                await this.reconcile();
                if ((this.options.stateBytesUsed?.() ?? this.ledger.size()) + reserved > this.ledger.cap) this.ledger.rotate();
            }
            this.options.verifySource?.(reserved);
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
