// Synthetic files only. Inject space data; never call statfs or an actual CH service.
import { mkdirSync, writeFileSync, readFileSync, readdirSync, lstatSync, linkSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { StreamingHistoryClient } from '../../scripts/history/stream';
const { AuditLog } = await import(process.argv[2]);
const root = process.argv[3];
mkdirSync(root, { mode: 0o700 });
const space = () => ({ bsize: 1n, bavail: 1n << 60n });
const pending = { token: 'p', state: 'intent', manifest: 'm', run: 'r', keys: [{}, {}] };
const original = JSON.stringify({ ...pending, token: 'old', state: 'acked' }) + '\n' + JSON.stringify(pending) + '\n';
function capture(path: string) {
    const { dev, ino } = lstatSync(path, { bigint: true });
    return { dev, ino, bytes: readFileSync(path) };
}
function custody(retiring: ReturnType<typeof capture>, audit: string, stage: string) {
    const aliases = readdirSync(audit).filter(p => {
        const found = capture(join(audit, p));
        return found.dev === retiring.dev && found.ino === retiring.ino && found.bytes.equals(retiring.bytes);
    });
    assert.ok(aliases.length > 0, 'RETIRING_INODE_NOT_PUBLISHED');
    console.log(JSON.stringify({ stage, dev: String(retiring.dev), ino: String(retiring.ino), aliases }));
}
for (const coverage of [0, 2, 1]) {
    const dir = join(root, String(coverage));
    mkdirSync(dir, { mode: 0o700 });
    const path = join(dir, 'ledger.ndjson'), audit = join(dir, 'audit');
    writeFileSync(path, original, { mode: 0o600 });
    const log = new AuditLog(path, 4096, space);
    // Real hardlink reproduces completed link + process interruption before rename.
    mkdirSync(audit, { mode: 0o700 });
    const archived = join(audit, 'interrupted.ndjson');
    linkSync(path, archived);
    assert.equal(log.shared(), true);
    let refused = false;
    try { log.append({ token: 'forbidden' }); } catch (e) {
        assert.match(String(e), /requires reconciliation\/rotation/); refused = true;
    }
    assert.ok(refused, 'SHARED_APPEND_NOT_REFUSED');
    assert.equal(readFileSync(archived, 'utf8'), original);
    const client = new StreamingHistoryClient({ url: 'http://invalid.local', database: 'unused', user: '', password: '' },
        { ledger: path, manifest: 'm', run: 'r', sessionId: 'synthetic', stateBytesCap: 4096, localSpace: space });
    Object.assign(client, { ledger: log });
    client.coverage = async () => coverage;
    const recovering = capture(path);
    if (coverage === 1) await assert.rejects(client.reconcile(), /ambiguous partial coverage/);
    else await client.reconcile();
    custody(recovering, audit, 'recovery-' + coverage);
    assert.notEqual(lstatSync(path, { bigint: true }).ino, recovering.ino);
    assert.equal(lstatSync(path).nlink, 1);
    assert.equal(readFileSync(archived, 'utf8'), original);
    const records = readFileSync(path, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    assert.equal(records[0].token, 'p');
    assert.equal(records.at(-1).state, coverage === 1 ? 'intent' : coverage ? 'acked' : 'retry');
    // A completed real rotation preserves every archived byte and changes active inode.
    const before = new Map(readdirSync(audit).map(p => [p, readFileSync(join(audit, p))]));
    const retiring = capture(path);
    log.rotate([pending]);
    custody(retiring, audit, 'repeat-' + coverage);
    assert.notEqual(lstatSync(path, { bigint: true }).ino, retiring.ino);
    for (const [p, bytes] of before) assert.deepEqual(readFileSync(join(audit, p)), bytes);
    writeFileSync(path, JSON.stringify(pending), { mode: 0o600 });
    const torn = readFileSync(path);
    await assert.rejects(client.reconcile(), /torn history ledger/);
    assert.deepEqual(readFileSync(path), torn);
    console.log(JSON.stringify({ coverage, sharedRefused: true, recovered: true, tornRefused: true }));
}
console.log('SAMPLED_CONFORMANCE_PASS');
