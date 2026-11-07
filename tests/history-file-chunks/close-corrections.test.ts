import { test, expect, spyOn, afterAll } from 'bun:test';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { ClickHouse } from '../../src/lib/clickhouse';
import { acquireFile, statPin } from '../../src/history-file-chunks/acquire';
import { storeAcquisition } from '../../src/history-file-chunks/durable';
import { finalizeStorage, type FinalAdmission } from '../../src/history-file-chunks/finalize';
import { custodyOps } from '../../src/metadata/private-fs';
const root = fs.mkdtempSync(join(fs.realpathSync(process.env.FINALIZE_CORRECTIONS_ROOT ?? tmpdir()), 'owned-close-'));
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const rows = new Map<string, Record<string, unknown>>(); let requests = 0;
const columns = [...fs.readFileSync('src/raw-document/schema.sql', 'utf8').matchAll(/^    (\w+) (String|UInt64|UInt8),?$/gm)].map(m => ({ name: m[1], type: m[2] }));
// Owned loopback fake SQL and synthetic headroom/admission; no actual backend authority.
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req): Promise<Response> {
  requests++; const bytes = Buffer.from(await req.arrayBuffer()), sql = new URL(req.url).searchParams.get('query') ?? bytes.toString();
  const json = (v: unknown[]) => new Response(v.map(x => JSON.stringify(x) + '\n').join(''));
  if (sql.startsWith('INSERT')) { const r = JSON.parse(bytes.toString('latin1')), raw = Buffer.from(r.raw, 'latin1'); delete r.raw; rows.set(r.revision_id + ':' + r.acquisition_id, { ...r, actual_hash: sha(raw), actual_bytes: String(raw.length) }); return new Response(''); }
  if (sql.includes('system.tables')) return json([{ engine: 'ReplacingMergeTree', sorting_key: 'revision_id, acquisition_id', storage_policy: 'default' }]);
  if (sql.includes('system.columns')) return json(columns);
  if (sql.includes('system.disks')) return json([{ name: 'default', free_space: String(40 * 1024 ** 3), unreserved_space: String(40 * 1024 ** 3), keep_free_space: String(15 * 1024 ** 3) }]);
  if (sql.includes(' FINAL ')) return json([...sql.matchAll(/\('([a-f0-9]{64})','([a-f0-9]{64})'\)/g)].map(m => rows.get(m[1] + ':' + m[2])).filter(Boolean));
  return new Response('UNEXPECTED', { status: 400 });
} });
afterAll(async () => { await server.stop(true); console.log('CORRECTION_B_STOPPED ' + JSON.stringify({ root, requests, pending: server.pendingRequests })); });
const cooperative: FinalAdmission = async b => ({ admitted: true, bindingHash: b.bindingHash });
for (const fault of ['before-release', 'after-release', 'before-close-fsync', 'success']) test('pending close ownership: ' + fault, async () => {
  const dir = fs.mkdtempSync(join(root, 'case-')), source = join(dir, 'source'), acquired = join(dir, 'acquired'), ledger = join(dir, 'ledger'), bytes = Buffer.from('tiny');
  fs.writeFileSync(source, bytes, { flag: 'wx', mode: 0o600 });
  const free = spyOn(custodyOps, 'free').mockReturnValue(64 * 1024 ** 3);
  let target = -1, attempts = 0, targetAlive = false, pendingOwnership = true; const owned = new Set<number>();
  const op = custodyOps.open, cl = fs.closeSync, sy = fs.fsyncSync;
  let open: ReturnType<typeof spyOn> | undefined, close: ReturnType<typeof spyOn> | undefined, sync: ReturnType<typeof spyOn> | undefined;
  try {
    const r = acquireFile({ path: source, custodyMachine: 'owned', sourceFormat: 'opaque', wholeBytes: bytes.length, wholeHash: sha(bytes), stat: statPin(fs.statSync(source, { bigint: true })), method: 'owned', observedAt: '2026-11-07T00:00:00.000Z', evidenceHash: 'a'.repeat(64) }, acquired);
    const manifest = join(acquired, 'manifest.json'), raw = fs.readFileSync(manifest);
    const authority = { directory: acquired, directoryStat: statPin(fs.statSync(acquired, { bigint: true })), manifestStat: statPin(fs.statSync(manifest, { bigint: true })), manifestBytes: raw.length, manifestHash: sha(raw), receiptHash: r.receiptHash, sourceRevision: r.manifest.sourceRevision, acquisitionId: r.manifest.acquisitionId, wholeHash: sha(bytes), wholeBytes: bytes.length, authorityHash: 'b'.repeat(64) };
    const writerPins = { scopeHash: '1'.repeat(64), ownerHash: '2'.repeat(64), windowHash: '3'.repeat(64), epochHash: '4'.repeat(64), schemaHash: '5'.repeat(64), configHash: '6'.repeat(64) };
    const ch = new ClickHouse({ url: server.url.origin, user: 'owned', password: '', database: 'owned', requestTimeoutMs: 2000, maxRequestBytes: 9 * 1024 ** 2, maxResponseBytes: 1024 ** 2 });
    const ackStage = await storeAcquisition(authority, writerPins, ledger, ch, async (_p, b) => ({ admitted: true, bindingHash: b.bindingHash }));
    const input = { authority, writerPins, ackStage, ledger: { path: ledger, stat: statPin(fs.statSync(ledger, { bigint: true })), intentHash: sha(fs.readFileSync(join(ledger, 'intent.json'))), authorityHash: 'f'.repeat(64), ackStageHash: sha(JSON.stringify(ackStage) + '\n') } };
    open = spyOn(custodyOps, 'open').mockImplementation((...a) => { const fd = op(...a); owned.add(fd); if (a[1] === 'manifest.json.pending' && (a[2] & fs.constants.O_CREAT)) target = fd; return fd; });
    close = spyOn(fs, 'closeSync').mockImplementation(fd => {
      const pending = fd === target && pendingOwnership;
      if (pending) { attempts++; if (fault === 'before-release') throw Error('OWNED_BEFORE_RELEASE'); }
      cl(fd); owned.delete(fd); if (pending && fault === 'after-release') throw Error('OWNED_AFTER_RELEASE');
      if (pending) pendingOwnership = false;
    });
    sync = spyOn(fs, 'fsyncSync').mockImplementation(fd => { if (fd === target && fault === 'before-close-fsync') throw Error('OWNED_PRECLOSE_FSYNC'); sy(fd); });
    if (fault === 'success') expect((await finalizeStorage(input, ch, cooperative)).status).toBe('STORAGE_COMPLETE');
    else await expect(finalizeStorage(input, ch, cooperative)).rejects.toThrow(/^STORAGE_FINALIZE_REFUSED$/);
    try { fs.fstatSync(target); targetAlive = true; } catch {}
    expect(attempts).toBe(1); expect(targetAlive).toBe(fault === 'before-release');
    expect([...owned]).toEqual(fault === 'before-release' ? [target] : []);
    expect(fs.existsSync(join(ledger, 'manifest.json'))).toBe(fault === 'success');
    expect(fs.existsSync(join(ledger, 'manifest.json.pending'))).toBe(fault !== 'success');
    console.log('ONE_CLOSE_CONTROL ' + JSON.stringify({ fault, target, attempts, targetAlive, ownedRemaining: [...owned] }));
  } finally {
    sync?.mockRestore(); close?.mockRestore(); open?.mockRestore(); free.mockRestore();
    // A before-release injected error deliberately leaves descriptor state uncertain. No retry;
    // the test process owns it until exit, independently of the cleaned anchored descriptors.
  }
});
