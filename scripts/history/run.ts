import { recordLimit } from '../../src/ship/record-limit';
import { MAX_SERIALIZED_BATCH_BYTES } from '../../src/lib/row-size';
import { existsSync, mkdirSync, openSync, closeSync, unlinkSync, readFileSync, statSync, realpathSync, fsyncSync, writeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ClickHouse } from '../../src/lib/clickhouse';
import { expandHome, loadEnvFiles } from '../../src/lib/env';
import { installErrorHandlers, writeOut } from '../../src/lib/egress';
import { sha256Hex } from '../../src/lib/hash';
import { verifySessionSchema } from '../../src/lib/session-schema';
import { logicalSessionPath, shipOnce, type ShipRoot } from '../../src/ship/ship';
import { loadState, saveState } from '../../src/ship/state';
import { EpochFull, GiB, StreamingHistoryClient, sqlString } from './stream';
import { AuditLog, localHeadroom, privateSize, STATE_CAP, type LocalSpace } from './journal';
import { seedLineage, verifySource, type Manifest, type Source } from './source';
import { failureDetails, secondaryFailure } from './diagnostic-bundle';
export async function runImport(manifestPath: string, ch: ClickHouse, options: {
    machine: string;
    roots: ShipRoot[];
    directory: string;
    liveStates: string[];
    epochBytes?: number;
    shouldStop?: () => boolean;
    pilotOnly?: boolean;
    batchBytes?: number;
    maxRecordBytes?: number;
    stateBytesCap?: number;
    receiptBytesCap?: number;
    localSpace?: LocalSpace;
}) {
    const maxRecordBytes = recordLimit(options.maxRecordBytes);
    const batchBytes = options.batchBytes ?? 256 * 1024;
    if (!Number.isSafeInteger(batchBytes) || batchBytes < 1 || batchBytes > 4 * 1024 ** 2)
        throw Error('history batchBytes must be between 1 byte and 4 MiB');
    if (statSync(manifestPath).size > 16 * 1024 ** 2)
        throw Error('manifest scratch cap');
    const text = readFileSync(manifestPath, 'utf8'), manifest = JSON.parse(text) as Manifest, hash = sha256Hex(text);
    const epochBytes = options.epochBytes ?? GiB, stop = options.shouldStop ?? (() => false);
    if (!Number.isSafeInteger(epochBytes) || epochBytes < 512 * 1024 ** 2 || epochBytes > GiB)
        throw Error('epoch must be between 512 MiB and 1 GiB');
    if (manifest.machine !== options.machine || !Array.isArray(manifest.sources) || !manifest.sources.length || manifest.sources.length > 4096)
        throw Error('invalid native manifest/machine');
    if (new Set(manifest.sources.map(s => logicalSessionPath(s.path))).size !== manifest.sources.length)
        throw Error('duplicate logical source ownership');
    // All importer-owned state lives outside repositories and outside live ship/backfill files.
    const parent = resolve(options.directory);
    for (let p = parent;; p = dirname(p)) {
        if (existsSync(join(p, '.git')))
            throw Error('history state must be outside repositories');
        if (dirname(p) === p)
            break;
    }
    if (options.liveStates.some(p => resolve(p).startsWith(parent + '/')))
        throw Error('history state overlaps live state');
    localHeadroom(parent, 4096, options.localSpace);
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    if (realpathSync(parent) !== parent || (statSync(parent).mode & 0o077))
        throw Error('history directory must be private and canonical');
    const dir = join(parent, hash);
    localHeadroom(dir, 4096, options.localSpace);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (realpathSync(dir) !== dir || (statSync(dir).mode & 0o077))
        throw Error('unsafe history manifest directory');
    const run = randomUUID(), receipts = join(dir, 'receipts.ndjson');
    const stateCap = options.stateBytesCap ?? STATE_CAP;
    const receiptLog = new AuditLog(receipts, options.receiptBytesCap ?? 16 * 1024 ** 2, options.localSpace);
    const lock = join(parent, 'writer.lock');
    localHeadroom(parent, 4096, options.localSpace);
    const fd = openSync(lock, 'wx', 0o600);
    let lockFd: number | undefined = fd;
    let terminal: { error: unknown } | undefined;
    const recordFailure = (error: unknown, stage: string) => {
        terminal = { error: terminal ? secondaryFailure(terminal.error, stage, error) : error };
    };
    const receipt = (value: unknown) => receiptLog.receipt({ at: new Date().toISOString(), run, manifest: hash, ...value as object });
    const matrix = () => ch.queryJSON("SELECT machine,harness,toYYYYMM(ts) AS month,count() AS rows,min(ts) AS oldest FROM tokenlayer.session_events FINAL GROUP BY machine,harness,month ORDER BY machine,harness,month SETTINGS max_execution_time=30,max_threads=2,max_memory_usage=536870912,max_result_rows=4096,result_overflow_mode='throw'");
    // Completed checkpoints and immutable audit are retained but are not active
    // scratch. Bound the current source, pilot lineage and in-flight ledger only.
    const usage = (state: string) => [...new Set([state, state + '.generations', state + '.tmp', state + '.generations.tmp',
        join(dir, 'pilot.json'), join(dir, 'pilot.json.generations'), join(dir, 'ledger.ndjson'), join(dir, 'ledger.ndjson.next')])]
        .reduce((n, path) => n + privateSize(path), 0);
    const writeState: typeof saveState = (path, value) => {
        const bytes = Buffer.byteLength(JSON.stringify(value));
        if (bytes > stateCap) throw Error('active checkpoint cap');
        localHeadroom(dirname(path), bytes + 4096, options.localSpace);
        saveState(path, value);
    };
    // Importer state is v3 only. Avoid loadState's legacy-upgrade writes outside the guarded writer.
    const readState: typeof loadState = path => {
        if (existsSync(path) && JSON.parse(readFileSync(path, 'utf8')).version !== 3) throw Error('legacy importer state needs reconciliation');
        return loadState(path);
    };
    try {
        writeSync(fd, JSON.stringify({pid:process.pid, manifest:hash, started:new Date().toISOString()}));
        fsyncSync(fd);
        lockFd = undefined; // Never retry a close that may already have closed the descriptor.
        closeSync(fd);
        await verifySessionSchema(ch);
        receipt({ state: 'before', matrix: await matrix() });
        const execute = async (s: Source, pilot: boolean) => {
            const sourceDir = options.roots.filter(r => existsSync(r.dir));
            const check = await verifySource(s, sourceDir, stop, maxRecordBytes);
            const state = join(dir, (pilot ? 'pilot' : sha256Hex(logicalSessionPath(s.path))) + '.json');
            if ([state, state + '.generations', join(dir, 'pilot.json'), join(dir, 'pilot.json.generations')].reduce((n, p) => n + privateSize(p), 0) > stateCap)
                throw Error('active checkpoint cap');
            seedLineage(s, state, [...options.liveStates, ...(!pilot ? [join(dir, 'pilot.json')] : [])], writeState);
            for (let epoch = 1;; epoch++) {
                const client = new StreamingHistoryClient(ch.config, { ledger: join(dir, 'ledger.ndjson'), manifest: hash, run, sessionId: s.sessionId, epochBytes, shouldStop: stop, stateBytesCap: stateCap, stateBytesUsed: () => usage(state), localSpace: options.localSpace,
                    verifySource: (extraBytes=0) => { check(); if (usage(state)+extraBytes > stateCap)
                        throw Error('durable history state cap'); } });
                await client.reconcile();
                if (usage(state) > stateCap) throw Error('durable history state cap');
                // Reconcile durable intent first. Then discard only importer-owned
                // write-ahead progress beyond the acknowledged checkpoint.
                const acknowledged = readState(state);
                if (acknowledged.files[logicalSessionPath(s.path)]) writeState(`${state}.generations`, acknowledged);
                await client.headroom(384 * 1024 ** 2);
                readState(`${state}.generations`);
                const prior = readState(state).files[logicalSessionPath(s.path)];
                if (pilot && (check.prefixEnds.length !== 32 || check.prefixEnds.at(-1) !== s.prefixBytes))
                    throw Error('pilot prefix must pin exactly 32 records');
                const remaining = pilot ? check.prefixEnds.filter(end => end > (prior?.offset ?? 0)).length : undefined;
                let failed = false, failure: unknown;
                try {
                    await shipOnce({ machine: options.machine, roots: sourceDir, files: [s.path], statePath: state, writeState, clickhouse: client,
                        maxLines: remaining, batchLines: 4096, maxRecordBytes, maxBatchJsonBytes: MAX_SERIALIZED_BATCH_BYTES, shouldStop: () => stop() || client.stopped, rateBytesPerSec: 0, batchBytes });
                }
                catch (e) {
                    failed = true;
                    failure = e;
                }
                let cp;
                try {
                    check();
                    cp = readState(state).files[logicalSessionPath(s.path)];
                    receipt({ state: failed ? (client.lastFailure instanceof EpochFull ? 'epoch-rollover' : 'stopped') : 'epoch', pilot, epoch, path: s.path, offset: cp?.offset ?? 0, charged: client.used, matrix: await matrix() });
                } catch (diagnostic) {
                    // Diagnostics must succeed before rollover or acceptance can continue.
                    if (failed) throw secondaryFailure(failure, 'epoch diagnostics', diagnostic);
                    throw diagnostic;
                }
                if (failed) {
                    if (!pilot && client.lastFailure instanceof EpochFull && client.used > 384 * 1024 ** 2) {
                        // Admission refused before HTTP. The shipper's write-ahead journal includes
                        // that unallocated batch; resume the pinned input from owned acknowledged progress.
                        writeState(`${state}.generations`, readState(state));
                        continue;
                    }
                    throw failure;
                }
                if (stop())
                    throw Error('history stopped');
                if (!cp || cp.offset !== (pilot ? s.prefixBytes : s.decodedBytes))
                    throw Error('incomplete native source/pilot boundary');
                // Verify acknowledged keys, including an earlier crash's ledger, before advancing the queue.
                const [count] = await ch.queryJSON<{
                    n: string;
                }>(`SELECT count() AS n FROM tokenlayer.session_events FINAL WHERE machine=${sqlString(options.machine)} AND path=${sqlString(logicalSessionPath(s.path))} AND generation=${sqlString(cp.generation)} AND byte_offset<${cp.offset}`);
                if (Number(count?.n) !== (pilot ? 32 : check.nonemptyLines))
                    throw Error(pilot ? 'pilot FINAL acceptance failed' : 'source FINAL nonempty LF count failed');
                return;
            }
        };
        await execute(manifest.sources[0], true);
        receipt({ state: 'pilot-accepted' });
        if (!options.pilotOnly)
            for (const s of manifest.sources) {
                if (stop())
                    throw Error('history stopped');
                await execute(s, false);
            }
        receipt({ state: options.pilotOnly ? 'pilot-only' : 'queue-complete', matrix: await matrix() });
    }
    catch (e) {
        recordFailure(e, 'import');
        const diagnostic = failureDetails(e);
        if (diagnostic.failures.length)
            recordFailure(new AggregateError(diagnostic.failures, 'history diagnostic rendering failed'), 'diagnostic rendering');
        try {
            receipt({ state: 'stopped', reason: diagnostic.text });
        } catch (diagnostic) { recordFailure(diagnostic, 'stop receipt'); }
    }
    finally {
        if (lockFd !== undefined) {
            try { closeSync(lockFd); }
            catch (cleanup) { recordFailure(cleanup, 'writer lock close'); }
        }
        try { unlinkSync(lock); }
        catch (cleanup) { recordFailure(cleanup, 'writer lock removal'); }
    }
    if (terminal) throw terminal.error;
    return dir;
}
if (import.meta.main) {
    installErrorHandlers();
    const args = process.argv.slice(2), value = (name: string) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
    if (args.includes('--help')) {
        writeOut('bun scripts/history/run.ts --manifest pinned-native.json [--epoch-bytes 1073741824] [--pilot-only] [--max-record-bytes 16777216]');
        process.exit(0);
    }
    const manifest = value('--manifest');
    if (!manifest)
        throw Error('--manifest required');
    const env = loadEnvFiles((process.env.TOKENLAYER_ENV_FILES ?? '~/.config/tokenlayer/ship.env:~/.config/tokenlayer/clickhouse.env').split(':'));
    if (!env.TOKENLAYER_MACHINE)
        throw Error('TOKENLAYER_MACHINE required');
    const roots: ShipRoot[] = [
        { kind: 'claude', dir: expandHome(env.TOKENLAYER_CLAUDE_DIR ?? '~/.claude/projects') },
        { kind: 'codex', dir: expandHome(env.TOKENLAYER_CODEX_DIR ?? '~/.codex/sessions') },
        { kind: 'antigravity-cli', dir: expandHome(env.TOKENLAYER_ANTIGRAVITY_CLI_DIR ?? '~/.gemini/antigravity-cli/brain') },
        { kind: 't3-antigravity', dir: expandHome(env.TOKENLAYER_T3_ANTIGRAVITY_DIR ?? '~/.t3/userdata/providers/antigravity') },
    ];
    let stopping = false;
    for (const sig of ['SIGINT', 'SIGTERM'] as const)
        process.on(sig, () => { stopping = true; });
    const dir = await runImport(manifest, ClickHouse.fromEnv(env), { machine: env.TOKENLAYER_MACHINE, roots, directory: expandHome('~/.config/tokenlayer/history-import'),
        liveStates: [expandHome(env.TOKENLAYER_SHIP_STATE ?? '~/.config/tokenlayer/ship-state.json'), expandHome('~/.config/tokenlayer/backfill-state.json')],
        epochBytes: value('--epoch-bytes') === undefined ? undefined : Number(value('--epoch-bytes')), maxRecordBytes: args.includes('--max-record-bytes') ? Number(value('--max-record-bytes')) : undefined, shouldStop: () => stopping, pilotOnly: args.includes('--pilot-only') });
    writeOut(`history receipt directory=${dir}`);
}
