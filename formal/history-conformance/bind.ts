/** Sampled reviewed trace edges bound to maintained code, with no socket/server. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const [snapshot, scratch, obligationsPath, mode] = process.argv.slice(2);
const { StreamingHistoryClient } = await import(join(snapshot, 'scripts/history/stream.ts'));
const { shipOnce } = await import(join(snapshot, 'src/ship/ship.ts'));
const { loadState, saveState } = await import(join(snapshot, 'src/ship/state.ts'));
const { ClickHouse } = await import(join(snapshot, 'src/lib/clickhouse.ts'));
const { runImport } = await import(join(snapshot, 'scripts/history/run.ts'));
const { createHash } = await import('node:crypto');
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const obligations = JSON.parse(readFileSync(obligationsPath, 'utf8')).obligations;
class Failure extends Error { constructor(readonly obligation: string) { super(obligation); } }
const check = (id: string, ok: unknown) => { if (!ok) throw new Failure(id); };
const config = { url: 'http://conformance.invalid', database: 'tokenlayer', user: '', password: '' };
const localSpace = () => ({ bsize: 1n, bavail: 100n * 1024n ** 3n }); // Synthetic ONLY.
const fixtures: any[] = [];
let active: any;
function fixture(name: string, count = 2) {
    const dir = join(scratch, name), source = join(dir, 'source'), state = join(dir, 'state');
    mkdirSync(source, { recursive: true, mode: 0o700 });
    const path = join(source, 'fixture.jsonl');
    const text = Array.from({ length: count }, (_, i) => JSON.stringify({ type: 'user', sessionId: 'synthetic',
        timestamp: '2026-11-06T00:00:00Z', message: { role: 'user', content: `row${i}` } }) + '\n').join('');
    writeFileSync(path, text, { mode: 0o600 });
    const f: any = { name, dir, source, path, state, text, events: [], stored: new Map(), dispatches: 0,
        transportFault: '', stop: false, mismatch: false, ledger: join(dir, 'ledger.ndjson') };
    f.emit = (event: string, detail = {}) => f.events.push({ event, ...detail });
    f.records = () => existsSync(f.ledger) ? readFileSync(f.ledger, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
    f.offset = () => loadState(state).files[path]?.offset ?? 0;
    f.client = (extra = {}) => {
        const client = new StreamingHistoryClient(config, { ledger: f.ledger, manifest: 'synthetic', run: name,
            sessionId: 'synthetic', localSpace, shouldStop: () => { f.emit('poll', { stop: f.stop }); return f.stop; }, ...extra });
        const record = client.record.bind(client);
        client.record = (r: any, status: string) => {
            if (status === 'acked' && f.failAck) { f.failAck = false; f.emit('ack-write-failure'); throw Error('INJECTED_ACK_WRITE_FAILURE'); }
            record(r, status); f.emit(status === 'acked' ? 'ack' : status, { durable: f.records().at(-1)?.state });
        };
        return client;
    };
    f.ship = async (client: any, batchLines = 2, maxLines?: number) => {
        active = f;
        return shipOnce({ machine: 'synthetic', roots: [{ kind: 'claude', dir: source }], files: [path],
            statePath: state, clickhouse: client, rateBytesPerSec: 0, batchLines, maxLines,
            writeState: (target: string, value: any) => {
                saveState(target, value);
                f.emit(target.endsWith('.generations') ? 'write-ahead' : 'checkpoint', {
                    offset: loadState(target).files[path]?.offset ?? 0, ledger: f.records().at(-1)?.state ?? 'none' });
            } });
    };
    fixtures.push(f); active = f; return f;
}
// All maintained ClickHouse.post calls terminate here; unknown origin/SQL refuses.
globalThis.fetch = (async (url: any, init: any) => {
    const u = new URL(String(url)), f = active;
    check('NO_NETWORK_TRANSPORT', u.origin === config.url && init.method === 'POST');
    const body = typeof init.body === 'string' ? init.body : Buffer.from(init.body).toString();
    const sql = u.searchParams.get('query') ?? body;
    let rows: any[];
    if (sql.startsWith('INSERT INTO tokenlayer.session_events FORMAT JSONEachRow')) {
        rows = body.trim().split('\n').map(JSON.parse); f.dispatches++;
        const wal = loadState(f.state + '.generations').files[f.path]?.offset ?? 0;
        f.emit('dispatch', { stop: f.stop, ledger: f.records().at(-1)?.state, wal, rows: rows.length });
        const applied = f.transportFault === 'zero' ? [] : f.transportFault === 'partial' ? rows.slice(0, 1) : rows;
        for (const row of applied) f.stored.set(JSON.stringify([row.machine, row.path, row.generation, row.byte_offset, row.content_hash]), row);
        f.emit('apply', { keys: f.stored.size });
        if (f.transportFault) throw Error('INJECTED_RESPONSE_LOSS');
        f.emit('response'); return new Response('');
    }
    if (sql.includes('FROM system.disks')) rows = [{ free_space: String(100 * 1024 ** 3), unreserved_space: String(100 * 1024 ** 3), keep_free_space: '0' }];
    else if (sql.includes('FROM system.tables')) rows = [{ sorting_key: 'machine, path, generation, byte_offset, content_hash', engine: 'ReplacingMergeTree' }];
    else if (sql.includes('FROM system.columns')) rows = [...readFileSync(join(snapshot, 'schema/004_session_events.sql'), 'utf8').matchAll(/^    (\w+)\s+(\w+(?:\([^\n]*?\))?)/gm)].filter(m => m[1] !== 'INDEX').map(m => ({ name: m[1], type: m[2] }));
    else if (sql.includes('GROUP BY machine,harness,month')) rows = [];
    else if (sql.startsWith('SELECT DISTINCT machine,path')) rows = f.stored.size ? [{ machine: 'synthetic', path: f.path }] : [];
    else if (sql.includes('AND NOT (machine=')) rows = [{ n: '0' }]; // No other owner/generation in these fixtures.
    else if (sql.includes('(machine,path,generation,byte_offset,content_hash) IN')) {
        const n = [...f.stored.values()].filter((r: any) => sql.includes(`('${r.machine}','${r.path}','${r.generation}',${r.byte_offset},'${r.content_hash}')`)).length;
        rows = [{ n: String(n) }]; f.emit('coverage', { n });
    } else if (sql.includes('AND byte_offset<')) { rows = [{ n: String(f.stored.size - (f.mismatch ? 1 : 0)) }]; f.emit('FINAL', { n: rows[0].n }); }
    else throw Error('UNMAPPED_SQL');
    return new Response(rows.map(r => JSON.stringify(r)).join('\n'));
}) as typeof fetch;
function ordering(f: any) {
    check('ACK_BEFORE_CHECKPOINT', f.events.every((e: any) => e.event !== 'checkpoint' || e.offset === 0 || e.ledger === 'acked'));
    check('INTENT_WAL_BEFORE_DISPATCH', f.events.every((e: any) => e.event !== 'dispatch' || e.ledger === 'intent' && e.wal > 0));
}
function bind(f: any, trace: string, edge: string[]) {
    check('TRACE_EDGE_PRESENT', obligations[trace].events.join('|').includes(edge.join('|')));
    const observed = f.events.filter((e: any) => edge.includes(e.event)).map((e: any) => e.event).join('|');
    check('TRACE_EDGE_BOUND', observed.includes(edge.join('|')));
    f.emit('bound', { trace, edge });
}
async function orderingCase() {
    const f = fixture('ordering'); await f.ship(f.client(), 1, 1); ordering(f);
    check('TRACE_CHECKPOINT_EFFECT', obligations['reach-checkpoint'].edge.post.cp === 1 && f.offset() === f.text.indexOf('\n') + 1);
    bind(f, 'reach-checkpoint', ['write-ahead', 'intent', 'dispatch', 'apply', 'response', 'ack', 'checkpoint']);
    await f.ship(f.client(), 1); ordering(f); check('ACKNOWLEDGED_BOUNDARY', f.offset() === Buffer.byteLength(f.text));
}
async function recoveryCase(fault: string) {
    const f = fixture('recovery-' + fault); f.failAck = fault === 'ack-write';
    f.transportFault = fault === 'ack-write' ? '' : fault;
    let failure = false; try { await f.ship(f.client()); } catch (e) { failure = true; f.emit('caught-failure', { errors: e instanceof AggregateError ? e.errors.map(String) : [String(e)] }); }
    check('FAILED_BATCH_NO_CHECKPOINT', failure && f.offset() === 0 && f.records().at(-1)?.state === 'ambiguous');
    const before = f.offset(), journal = readFileSync(f.state + '.generations');
    f.transportFault = ''; const recovered = f.client();
    if (fault === 'partial') {
        const ledger = readFileSync(f.ledger); let refused = false;
        try { await recovered.reconcile(); } catch (e) { refused = String(e).includes('ambiguous partial coverage'); f.emit('caught-refusal', { error: String(e) }); }
        check('PARTIAL_PENDING_STOPS_WITH_CUSTODY', refused && ledger.equals(readFileSync(f.ledger)) && journal.equals(readFileSync(f.state + '.generations')) && f.offset() === before);
        check('TRACE_PARTIAL_ANTECEDENT', obligations['reach-partial-effects'].edge.post.pc === 'halt' && obligations['reach-partial-effects'].edge.post.ledger === obligations['reach-partial-effects'].edge.pre.ledger);
        f.emit('bound', { trace: 'reach-partial-effects', effect: 'throw; no reset; pending custody retained' });
        f.ledger = join(f.dir, 'fresh-ledger'); const sent = f.dispatches;
        await f.ship(f.client()); check('FRESH_PARTIAL_DISPATCHES', f.dispatches === sent + 1 && f.stored.size === 2);
    } else {
        await recovered.reconcile();
        check('RECONCILE_NOT_CHECKPOINT', f.offset() === before && f.records().at(-1)?.state === (fault === 'zero' ? 'retry' : 'acked'));
        const sent = f.dispatches; await f.ship(recovered, 1);
        check('CHANGED_BOUNDARY_REPLAY', f.offset() === Buffer.byteLength(f.text) && f.stored.size === 2 && f.dispatches === sent + (fault === 'zero' ? 2 : 0));
        const trace = fault === 'zero' ? 'reach-zero-reconcile' : 'reach-full-reconcile', edge = obligations[trace].edge;
        check('TRACE_RECOVERY_EDGE_PRESENT', edge.pre.cp === edge.post.cp && edge.post.ledger === (fault === 'zero' ? 'retry' : 'acked'));
        f.emit('bound', { trace, effect: 'terminal reconciliation without checkpoint; changed-boundary replay' });
    }
    ordering(f);
}
async function stopCase() {
    const f = fixture('stop-refusal'); let reservation = false;
    const client = f.client({ stateBytesUsed: () => { const bytes = reservation ? client.ledger.cap : 0; reservation = false; return bytes; } });
    await f.ship(client, 1, 1); const cp = f.offset();
    check('TERMINAL_PRIOR_LEDGER', cp > 0 && f.records().at(-1)?.state === 'acked');
    const prior = readFileSync(f.ledger), sent = f.dispatches, used = client.used;
    const records = client.ledger.records.bind(client.ledger);
    const onStop = () => { f.stop = true; f.emit('stop-callback'); }; // Controlled callback, no OS signal.
    client.ledger.records = async function* () {
        const iterator = records(), first = await iterator.next(); // Actual asynchronous ledger read.
        check('TERMINAL_READ', !first.done); f.emit('guard-wait', { cp }); onStop();
        if (!first.done) yield first.value; yield* iterator;
    };
    reservation = true; let refusal = '';
    try { await f.ship(client, 1); } catch (e) { refusal = (e instanceof AggregateError ? e.errors : [e]).map(String).join('|'); f.emit('caught-refusal', { error: refusal }); }
    check('STOP_BEFORE_DISPATCH', f.dispatches === sent && !f.events.some((e: any) => e.event === 'dispatch' && e.stop));
    check('STOP_REFUSAL', refusal === 'Error: history stopped before dispatch' && f.events.some((e: any) => e.event === 'poll' && e.stop));
    check('STOP_CUSTODY', readFileSync(f.ledger).equals(prior) && f.offset() === cp && client.used === used);
    // Model join: the stopped terminal-history wait is reachable, and RecheckStop=TRUE admits only halt there.
    const wait = obligations['reach-terminal-await-stop'], safety = obligations['current-safety'], old = obligations['historical-stop'];
    check('TRACE_STOP_ANTECEDENT', wait.configuration.text.includes(' RecheckStop = TRUE\n') && wait.last.includes('stop |-> TRUE')
        && wait.edge.post.pc === 'guard-wait' && wait.events.slice(-3).join('|') === 'write-ahead|await-reconcile-after-stop-check|stop');
    check('TRACE_STOP_PROPERTY', safety.outcome === 'PASS' && safety.properties.includes('StopBeforeDispatch') && safety.configuration.text.includes(' RecheckStop = TRUE\n'));
    check('HISTORICAL_STOP_RETAINED', old.configuration.text.includes(' RecheckStop = FALSE\n') && old.last.includes('stopBad |-> TRUE'));
    f.emit('bound', { trace: 'reach-terminal-await-stop', model: 'RecheckStop=TRUE: guard-wait+stop -> halt', actual: 'refused before intent/charge/dispatch', OS_signal: 'NOT_RUN' });
    ordering(f);
}
async function acceptanceCase(mismatch: boolean) {
    const f = fixture(mismatch ? 'FINAL-mismatch' : 'FINAL-match', 32); f.mismatch = mismatch;
    const source = { path: f.path, kind: 'claude', sessionId: 'synthetic', physicalSha256: hash(f.text),
        decodedSha256: hash(f.text), decodedBytes: Buffer.byteLength(f.text), prefixBytes: Buffer.byteLength(f.text), prefixSha256: hash(f.text) };
    const manifest = join(f.dir, 'manifest.json'); writeFileSync(manifest, JSON.stringify({ machine: 'synthetic', sources: [source] }), { mode: 0o600 });
    const dir = join(f.dir, 'history', hash(readFileSync(manifest, 'utf8')));
    f.state = join(dir, 'pilot.json'); f.ledger = join(dir, 'ledger.ndjson');
    let failed = false;
    try { await runImport(manifest, new ClickHouse(config), { machine: 'synthetic', roots: [{ kind: 'claude', dir: f.source }], directory: join(f.dir, 'history'), liveStates: [], pilotOnly: true, localSpace }); }
    catch (e) { if (!String(e).includes('pilot FINAL acceptance failed')) throw e; failed = true; f.emit('caught-refusal', { error: String(e) }); }
    const states = readFileSync(join(dir, 'receipts.ndjson'), 'utf8').trim().split('\n').map(JSON.parse).map(r => r.state);
    f.emit('acceptance-receipts', { states, failed });
    check('FINAL_ACCEPTANCE_GUARD', mismatch ? failed && !states.includes('pilot-accepted') && !states.includes('pilot-only') : !failed && states.includes('pilot-accepted') && states.includes('pilot-only'));
    check('ACCEPTANCE_DURABLE_STATE', loadState(f.state).files[f.path]?.offset === Buffer.byteLength(f.text) && f.records().at(-1)?.state === 'acked');
    check('TRACE_ACCEPTANCE_TARGET', obligations['accept-mismatch'].last.includes('accepted |-> TRUE'));
}
let result: any;
try {
    check('SUPPORTED_MODE', ['ordering', 'acceptance', 'stop', 'all'].includes(mode));
    if (mode === 'ordering' || mode === 'all') await orderingCase();
    if (mode === 'acceptance' || mode === 'all') { await acceptanceCase(true); await acceptanceCase(false); }
    if (mode === 'all') for (const fault of ['ack-write', 'zero', 'partial']) await recoveryCase(fault);
    if (mode === 'stop' || mode === 'all') await stopCase();
    result = { outcome: 'PASS_SAMPLED_BINDING', mode };
} catch (e) { result = { outcome: e instanceof Failure ? 'OBLIGATION_FAILED' : 'ERROR', obligation: e instanceof Failure ? e.obligation : undefined, error: String(e) }; }
writeFileSync(join(scratch, 'observations.json'), JSON.stringify({ result, fixtures: fixtures.map(({ name, dir, events }) => ({ name, dir, events })) }, null, 2));
console.log(JSON.stringify(result));
process.exit(result.outcome === 'PASS_SAMPLED_BINDING' ? 0 : result.outcome === 'OBLIGATION_FAILED' ? 2 : 1);
