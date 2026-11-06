import { expect, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runImport } from '../../scripts/history/run';
import { LOCAL_FLOOR } from '../../scripts/history/journal';
import { RESERVE } from '../../scripts/history/stream';
import { ClickHouse } from '../../src/lib/clickhouse';
import { formatError, registerSecrets } from '../../src/lib/egress';
import { sha256Hex } from '../../src/lib/hash';
import { startLocalClickHouse } from '../../src/lib/local-clickhouse';
import { applySchema } from '../../src/lib/schema';
import { historyFixtureDirectories } from '../fixtures/history-temp';

const directory = historyFixtureDirectories('history-failure-');
const fixture = () => {
    const root = directory(), roots = join(root, 'roots'), history = join(root, 'history');
    mkdirSync(roots); mkdirSync(history, { mode: 0o700 });
    const id = '00000000-0000-4000-8000-000000000077', path = join(roots, `rollout-${id}.jsonl`);
    const raw = Buffer.from(Array.from({ length: 40 }, (_, i) => JSON.stringify(i
        ? { type: 'event_msg', payload: { i } } : { type: 'session_meta', payload: { id } }) + '\n').join(''));
    writeFileSync(path, raw);
    const prefix = Buffer.from(raw.toString().split('\n').slice(0, 32).join('\n') + '\n');
    const source = { path, kind: 'codex', sessionId: id, physicalSha256: sha256Hex(raw.toString('utf8')), decodedSha256: sha256Hex(raw.toString('utf8')),
        decodedBytes: raw.length, prefixBytes: prefix.length, prefixSha256: sha256Hex(prefix.toString('utf8')) };
    const manifest = join(root, 'manifest.json');
    writeFileSync(manifest, JSON.stringify({ machine: 'm4', sources: [source] }));
    const state = join(history, sha256Hex(readFileSync(manifest, 'utf8'))), lock = join(history, 'writer.lock');
    return { path, raw, manifest, state, lock, receipts: join(state, 'receipts.ndjson'),
        options: { machine: 'm4', roots: [{ kind: 'codex' as const, dir: roots }], directory: history, liveStates: [], batchBytes: 300 } };
};
const primaryText = 'synthetic_primary';
const constraint = `ALTER TABLE tokenlayer.session_events ADD CONSTRAINT ${primaryText} CHECK 0`;
const caught = async (operation: Promise<unknown>) => {
    try { await operation; } catch (error) { return error; }
    throw Error('expected importer failure');
};
const messages = (error: unknown): string => error instanceof AggregateError
    ? [formatError(error), ...error.errors.map(messages)].join('\n') : formatError(error);
const enoughSpace = () => ({ bsize: 1n, bavail: BigInt(LOCAL_FLOOR + 1024 ** 3) });
// Inspect only wrappers created by the importer, stopping before hostile originals.
const retains = (error: unknown, primary: unknown): boolean => Object.is(error, primary) ||
    error instanceof AggregateError && retains(error.cause, primary);
// Inspect data properties only, without invoking hostile original getters again.
const contains = (root: unknown, needle: unknown, seen = new Set<unknown>()): boolean => {
    if (Object.is(root, needle)) return true;
    if (!root || typeof root !== 'object' || seen.has(root)) return false;
    seen.add(root);
    const cause = Object.getOwnPropertyDescriptor(root, 'cause')?.value;
    const members = Object.getOwnPropertyDescriptor(root, 'errors')?.value;
    return contains(cause, needle, seen) || Array.isArray(members) &&
        Array.from({ length: Math.min(members.length, 34) }, (_, i) =>
            Object.getOwnPropertyDescriptor(members, String(i))?.value).some(v => contains(v, needle, seen));
};

for (const mode of ['late stop receipt', 'late cleanup', 'cascading'] as const) {
    test(`real importer retains all exact rendering failures during ${mode}`, async () => {
        const local = await startLocalClickHouse({ keepFreeSpaceBytes: RESERVE }), f = fixture();
        let fired = false, reads = 0;
        const raised: Error[] = [];
        const primary = Object.defineProperty(Error('original'), 'stack', { get() {
            if (++reads === 2 || mode === 'cascading') {
                const error = Error(`exact rendering failure ${reads}`); raised.push(error); throw error;
            }
            return 'Error: original';
        } });
        try {
            await applySchema(local.client);
            const error = await caught(runImport(f.manifest, local.client, { ...f.options,
                localSpace: () => fired && mode !== 'late cleanup' ? { bsize: 1n, bavail: 0n } : enoughSpace(),
                shouldStop: () => { fired = true;
                    if (mode === 'late cleanup') { unlinkSync(f.lock); mkdirSync(f.lock); }
                    throw primary;
                } }));
            expect(retains(error, primary)).toBe(true);
            expect(raised.length).toBe(mode === 'cascading' ? 3 : 1);
            for (const failure of raised) expect(contains(error, failure)).toBe(true);
            let first = error as AggregateError;
            while (first.cause !== primary) {
                expect(first.errors[0]).toBe(first.cause); first = first.cause as AggregateError;
            }
            expect(first.errors[0]).toBe(primary); expect(first.cause).toBe(primary);
            expect(formatError(error)).toContain('[diagnostic unavailable]');
            expect(formatError(error)).toContain(mode === 'late cleanup' ? 'writer lock removal' : 'stop receipt');
            expect(formatError(error).length).toBeLessThanOrEqual(8192);
            expect(existsSync(f.lock)).toBe(mode === 'late cleanup');
            if (mode === 'late cleanup') rmdirSync(f.lock);
            expect(existsSync(f.receipts) ? readFileSync(f.receipts, 'utf8') : '').not.toMatch(/pilot-accepted|queue-complete/);
            expect(await local.client.exec('SELECT count() FROM tokenlayer.session_events FINAL')).toBe('0\n');
        } finally { await local.stop(); }
    }, 60000);
}

test('real importer bounds saturated rendering and redacts assembled multiline wrapper and durable copies', async () => {
    const local = await startLocalClickHouse({ keepFreeSpaceBytes: RESERVE });
    try {
        await applySchema(local.client);
        const first = 'synthetic multiline first', last = 'synthetic multiline last', secret = `${first}\n${last}`;
        registerSecrets({ INTEGRATION_SECRET: secret });
        const primary = Object.defineProperty(new AggregateError([
            Object.defineProperty(Error('member'), 'stack', { value: last })
        ]), 'stack', { value: first });
        const f = fixture();
        const error = await caught(runImport(f.manifest, local.client, { ...f.options, localSpace: enoughSpace,
            shouldStop: () => { unlinkSync(f.lock); mkdirSync(f.lock); throw primary; } }));
        for (const text of [formatError(error), (error as Error).message, (error as Error).stack!,
            JSON.parse(readFileSync(f.receipts, 'utf8').trim().split('\n').at(-1)!).reason]) {
            expect(text).not.toContain(secret); expect(text).toContain('[redacted]');
            expect(text.length).toBeLessThanOrEqual(8192);
        }
        expect((error as AggregateError).errors[0]).toBe(primary);
        expect((error as AggregateError).cause).toBe(primary); rmdirSync(f.lock);
        const raised: Error[] = [];
        const fail = () => { const failure = Error('exact saturated failure'); raised.push(failure); throw failure; };
        const hostile = () => {
            const value = Object.defineProperty(new AggregateError([]), 'stack', { get: fail });
            value.errors = new Proxy(new Array(16), { get(target, key, receiver) {
                if (/^\d+$/.test(String(key))) return fail();
                return Reflect.get(target, key, receiver);
            } }); return value;
        };
        const saturated = hostile(); saturated.cause = hostile();
        const g = fixture(); let fired = false;
        const bounded = await caught(runImport(g.manifest, local.client, { ...g.options,
            localSpace: () => fired ? { bsize: 1n, bavail: 0n } : enoughSpace(),
            shouldStop: () => { fired = true; throw saturated; } }));
        expect(retains(bounded, saturated)).toBe(true);
        expect(raised.length).toBeGreaterThanOrEqual(32);
        expect(raised.length).toBeLessThanOrEqual(3 * 32); // Three bounded rendering calls; limits occupy slots too.
        for (const failure of raised) expect(contains(bounded, failure)).toBe(true);
        expect(formatError(bounded).length).toBeLessThanOrEqual(8192);
        expect(formatError(bounded)).toContain('[diagnostic unavailable]');
        expect(existsSync(g.lock)).toBe(false);
        expect(await local.client.exec('SELECT count() FROM tokenlayer.session_events FINAL')).toBe('0\n');
    } finally { await local.stop(); }
}, 60000);

for (const kind of ['stack getter', 'toString'] as const) {
    test(`Review A MUST1: retains exact primary through throwing ${kind}`, async () => {
        const local = await startLocalClickHouse({ keepFreeSpaceBytes: RESERVE }), f = fixture();
        const renderingFailure = Error('synthetic formatter failure');
        const primary = kind === 'stack getter' ? Object.defineProperty(Error('synthetic original'), 'stack', {
            get() { throw renderingFailure; }
        }) : { toString() { throw renderingFailure; } };
        let fired = false;
        try {
            await applySchema(local.client);
            const error = await caught(runImport(f.manifest, local.client, { ...f.options,
                localSpace: () => fired && kind === 'stack getter' ? { bsize: 1n, bavail: 0n } : enoughSpace(),
                shouldStop: () => { fired = true; throw primary; } }));
            expect(retains(error, primary)).toBe(true);
            expect(error).toBeInstanceOf(AggregateError);
            let wrapper = error as AggregateError;
            while (wrapper.cause !== primary) wrapper = wrapper.cause as AggregateError;
            expect(wrapper.errors[0]).toBe(primary);
            expect(wrapper.cause).toBe(primary);
            expect((wrapper.errors[1] as AggregateError).errors).toContain(renderingFailure);
            expect(formatError(error)).toContain('[diagnostic unavailable]');
            if (kind === 'stack getter') expect(formatError(error)).toContain('local history low space');
            expect(existsSync(f.lock)).toBe(false);
            const text = existsSync(f.receipts) ? readFileSync(f.receipts, 'utf8') : '';
            expect(text).not.toMatch(/pilot-accepted|queue-complete/);
            expect(await local.client.exec('SELECT count() FROM tokenlayer.session_events FINAL')).toBe('0\n');
        } finally { await local.stop(); }
    }, 60000);
}

test('real importer retains primary schema failure when outer stop receipt refuses local space', async () => {
    const local = await startLocalClickHouse({ keepFreeSpaceBytes: RESERVE }), f = fixture();
    try {
        // No schema: the real schema verifier fails after lock acquisition.
        const error = await caught(runImport(f.manifest, local.client, { ...f.options,
            localSpace: () => existsSync(f.lock) ? { bsize: 1n, bavail: 0n } : enoughSpace() }));
        expect(messages(error)).toContain('session_events schema mismatch');
        expect(messages(error)).toContain('local history low space');
        expect(error).toBeInstanceOf(AggregateError);
        expect((error as AggregateError).cause).toBe((error as AggregateError).errors[0]);
        expect(((error as AggregateError).errors[0] as Error).stack).toContain('verifySessionSchema');
        expect(formatError(error)).toContain('session_events schema mismatch');
        expect(formatError(error)).toContain('stop receipt');
        expect(existsSync(f.lock)).toBe(false);
        expect(existsSync(f.receipts)).toBe(false);
    } finally { await local.stop(); }
}, 60000);

for (const diagnostic of ['source check', 'checkpoint read', 'matrix', 'epoch receipt'] as const) {
    test(`real importer preserves insert rejection through inner ${diagnostic} failure`, async () => {
        const local = await startLocalClickHouse({ keepFreeSpaceBytes: RESERVE }), f = fixture();
        let failedInsert = false, attempts = 0, matrices = 0;
        const insert = ClickHouse.prototype.insert;
        const intercept = spyOn(ClickHouse.prototype, 'insert').mockImplementation(async function(this: ClickHouse, ...args: Parameters<ClickHouse['insert']>) {
            attempts++;
            try { return await insert.apply(this, args); }
            catch (error) {
                failedInsert = true;
                if (diagnostic === 'source check') writeFileSync(f.path, Buffer.concat([f.raw, Buffer.from('{}\n')]));
                return Promise.reject(error);
            }
        });
        const query = local.client.queryJSON.bind(local.client);
        const matrix = spyOn(local.client, 'queryJSON').mockImplementation(async (sql: string) => {
            if (sql.includes('GROUP BY machine,harness,month') && ++matrices === 2 && diagnostic === 'matrix')
                return query("SELECT throwIf(1, 'synthetic_matrix_failure')") as any;
            return query(sql) as any;
        });
        const statePath = join(f.state, 'pilot.json');
        let queued = false;
        const localSpace = () => {
            if (failedInsert && diagnostic === 'checkpoint read' && !queued &&
                readFileSync(join(f.state, 'ledger.ndjson'), 'utf8').includes('"state":"ambiguous"')) {
                queued = true;
                // Run after shipOnce's synchronous final save, before its awaited
                // rejection reaches the importer's diagnostic checkpoint read.
                queueMicrotask(() => writeFileSync(statePath, '{', { mode: 0o600 }));
            }
            return failedInsert && diagnostic === 'epoch receipt' && existsSync(statePath)
                ? { bsize: 1n, bavail: 0n } : enoughSpace();
        };
        try {
            await applySchema(local.client); await local.client.exec(constraint);
            const error = await caught(runImport(f.manifest, local.client, { ...f.options, localSpace }));
            expect(messages(error)).toContain(primaryText);
            expect(formatError(error)).toContain(primaryText);
            const secondary = diagnostic === 'source check' ? 'source mutated during import'
                : diagnostic === 'matrix' ? 'synthetic_matrix_failure'
                : diagnostic === 'epoch receipt' ? 'local history low space' : 'JSON';
            expect(messages(error)).toContain(secondary);
            expect(formatError(error)).toContain(secondary);
            if (diagnostic === 'epoch receipt') {
                expect(formatError(error)).toContain('epoch diagnostics');
                expect(formatError(error)).toContain('stop receipt');
            }
            expect(existsSync(f.lock)).toBe(false);
            expect(attempts).toBe(1);
            const receipts = readFileSync(f.receipts, 'utf8');
            expect(receipts).not.toContain('pilot-accepted'); expect(receipts).not.toContain('queue-complete');
            const ledger = readFileSync(join(f.state, 'ledger.ndjson'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
            expect(ledger.map(r => r.state)).toEqual(['intent', 'ambiguous']);
            expect(await local.client.exec('SELECT count() FROM tokenlayer.session_events FINAL')).toBe('0\n');
            expect(await local.client.exec('SELECT count() FROM tokenlayer.proxy_usage')).toBe('0\n');
        } finally { intercept.mockRestore(); matrix.mockRestore(); await local.stop(); }
    }, 60000);
}

test('normal insert failure keeps its primary error and sanitized durable stop reason', async () => {
    const local = await startLocalClickHouse({ keepFreeSpaceBytes: RESERVE }), f = fixture();
    const secret = 'SyntheticConfiguredCredentialValue';
    registerSecrets({ SYNTHETIC_API_KEY: secret });
    try {
        await applySchema(local.client);
        await local.client.exec(`ALTER TABLE tokenlayer.session_events ADD CONSTRAINT ${primaryText} CHECK throwIf(1, '${secret}') = 0`);
        const error = await caught(runImport(f.manifest, local.client, { ...f.options, localSpace: enoughSpace }));
        expect(error).toBeInstanceOf(AggregateError);
        expect((error as Error).message).toBe('ship failed for some files');
        const receipts = readFileSync(f.receipts, 'utf8');
        expect(receipts).toContain('"state":"stopped"'); expect(receipts).toContain('[redacted]');
        expect(receipts).not.toContain(secret);
        expect(existsSync(f.lock)).toBe(false);
        expect(await local.client.exec('SELECT count() FROM tokenlayer.session_events FINAL')).toBe('0\n');
    } finally { await local.stop(); }
}, 60000);

test('cleanup failure after successful import remains fatal', async () => {
    const local = await startLocalClickHouse({ keepFreeSpaceBytes: RESERVE }), f = fixture();
    let matrices = 0;
    const query = local.client.queryJSON.bind(local.client);
    const capture = spyOn(local.client, 'queryJSON').mockImplementation(async (sql: string) => {
        const result = await query(sql);
        if (sql.includes('GROUP BY machine,harness,month') && ++matrices === 4) {
            unlinkSync(f.lock); mkdirSync(f.lock);
        }
        return result as any;
    });
    try {
        await applySchema(local.client);
        await expect(runImport(f.manifest, local.client, { ...f.options, localSpace: enoughSpace })).rejects.toThrow(/EISDIR|EPERM/);
        expect(readFileSync(f.receipts, 'utf8')).toContain('"state":"queue-complete"');
        expect(await local.client.exec('SELECT count() FROM tokenlayer.session_events FINAL')).toBe('40\n');
        rmdirSync(f.lock);
    } finally { capture.mockRestore(); await local.stop(); }
}, 60000);

test('lock removal failure retains primary and secondary; an unowned lock is untouched', async () => {
    const local = await startLocalClickHouse({ keepFreeSpaceBytes: RESERVE }), f = fixture();
    const primary = Error('synthetic primary before diagnostics');
    try {
        await applySchema(local.client);
        const error = await caught(runImport(f.manifest, local.client, { ...f.options, localSpace: enoughSpace, shouldStop: () => {
            unlinkSync(f.lock); mkdirSync(f.lock); throw primary;
        } }));
        expect(messages(error)).toContain(primary.message);
        expect(formatError(error)).toContain(primary.message);
        expect(formatError(error)).toContain('writer lock removal');
        expect((error as AggregateError).errors[0]).toBe(primary);
        expect((error as AggregateError).cause).toBe(primary);
        expect(messages(error)).toMatch(/EISDIR|EPERM/);
        rmdirSync(f.lock);
        writeFileSync(f.lock, 'another writer', { mode: 0o600 });
        await expect(runImport(f.manifest, local.client, { ...f.options, localSpace: enoughSpace })).rejects.toThrow('EEXIST');
        expect(readFileSync(f.lock, 'utf8')).toBe('another writer');
    } finally { await local.stop(); }
}, 60000);
