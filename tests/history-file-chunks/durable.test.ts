import { test, expect, spyOn, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { acquireFile, statPin, CHUNK_BYTES } from '../../src/history-file-chunks/acquire';
import { storeAcquisition, type WriterPins } from '../../src/history-file-chunks/durable';
import { custodyOps } from '../../src/metadata/private-fs';
import { ClickHouse, RAW_BYTES, encodeRow } from '../../src/lib/clickhouse';
import { RawDocumentStore } from '../../src/raw-document/storage';
const owned = new Set<string>();
afterEach(() => { for (const path of owned) fs.rmSync(path, { recursive: true, force: true }); owned.clear(); });
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const pins: WriterPins = { scopeHash: '1'.repeat(64), ownerHash: '2'.repeat(64), windowHash: '3'.repeat(64), epochHash: '4'.repeat(64), schemaHash: '5'.repeat(64), configHash: '6'.repeat(64) };
function fixture(bytes = Buffer.from('\ufeff{\r\n "x":"שלום🌍"}\tTAIL')) {
  const dir = fs.mkdtempSync(join(fs.realpathSync('/tmp'), 'tokenlayer-durable-')); owned.add(dir);
  const source = join(dir, 'source'), out = join(dir, 'out'), ledger = join(dir, 'ledger');
  fs.writeFileSync(source, bytes, { flag: 'wx', mode: 0o600 }); let calls = 0;
  const free = spyOn(custodyOps, 'free').mockImplementation(() => { calls++; return 64 * 1024 ** 3; });
  const receipt = acquireFile({ path: source, custodyMachine: 'owned', sourceFormat: 'opaque', wholeBytes: bytes.length, wholeHash: sha(bytes),
    stat: statPin(fs.statSync(source, { bigint: true })), method: 'owned-durable-proof', observedAt: '2026-11-07T00:00:00.000Z', evidenceHash: 'a'.repeat(64) }, out);
  const raw = fs.readFileSync(join(out, 'manifest.json'));
  const authority = { directory: out, directoryStat: statPin(fs.statSync(out, { bigint: true })), manifestStat: statPin(fs.statSync(join(out, 'manifest.json'), { bigint: true })),
    manifestBytes: raw.length, manifestHash: sha(raw), receiptHash: receipt.receiptHash, sourceRevision: receipt.manifest.sourceRevision,
    acquisitionId: receipt.manifest.acquisitionId, wholeHash: sha(bytes), wholeBytes: bytes.length, authorityHash: 'b'.repeat(64) };
  const ch = new ClickHouse({ url: 'http://NO_NETWORK.invalid', user: '', password: '', database: 'owned' });
  const columns = [...fs.readFileSync('src/raw-document/schema.sql', 'utf8').matchAll(/^    (\w+) (String|UInt64|UInt8),?$/gm)].map(m => ({ name: m[1], type: m[2] }));
  let onQuery = (_sql: string) => {};
  const query = spyOn(ClickHouse.prototype, 'queryJSON').mockImplementation(async sql => { onQuery(sql); return sql.includes('system.tables') ? [{ engine: 'ReplacingMergeTree', sorting_key: 'revision_id, acquisition_id', storage_policy: 'default' }] as never :
    sql.includes('system.columns') ? columns as never : [{ name: 'default', free_space: String(40 * 1024 ** 3), unreserved_space: String(40 * 1024 ** 3), keep_free_space: String(15 * 1024 ** 3) }] as never; });
  return { source, out, ledger, raw, authority, ch, calls: () => calls, onQuery: (fn: (sql: string) => void) => { onQuery = fn; }, restore: () => { query.mockRestore(); free.mockRestore(); } };
}
test('actual private intent/ACK fsync order, declared exact parent bytes, chunk IDs/wire and empty manifest ACK', async () => {
  for (const bytes of [Buffer.alloc(0), Buffer.from('{\r\n "x":"🌍"}\tTAIL'), Buffer.concat([Buffer.alloc(CHUNK_BYTES, 0), Buffer.from('TAIL')])]) {
    const f = fixture(bytes), events: string[] = [], names = new Map<number, string>(), originalOpen = custodyOps.open, sync = fs.fsyncSync, close = fs.closeSync;
    const open = spyOn(custodyOps, 'open').mockImplementation((...args) => { const fd = originalOpen(...args); if (args[2] & fs.constants.O_CREAT) names.set(fd, args[1]); return fd; });
    const fsync = spyOn(fs, 'fsyncSync').mockImplementation(fd => { sync(fd); events.push('sync:' + (names.get(fd) ?? 'dir')); });
    const closed = spyOn(fs, 'closeSync').mockImplementation(fd => { close(fd); if (names.has(fd)) { events.push('close:' + names.get(fd)); names.delete(fd); } });
    let put = 0;
    const insert = spyOn(ClickHouse.prototype, 'insert').mockImplementation(async (_table, rows, token) => {
      const intent = JSON.parse(fs.readFileSync(join(f.ledger, 'intent.json'), 'utf8')), expected = intent.documents[put], row = rows[0] as { [RAW_BYTES]: Buffer };
      expect(events.slice(-2)).toEqual(['close:' + (put ? `ack-${String(put - 1).padStart(6, '0')}.json` : 'intent.json'), 'sync:dir']);
      expect(token).toBe(expected.acquisitionId); expect(encodeRow(row).length + 1).toBe(expected.wireBytes);
      expect(row).toMatchObject({ revision_id: expected.revisionId, acquisition_id: expected.acquisitionId, source_locator: expected.sourceLocator,
        format: put ? 'history-file-chunks-v1' : 'history-file-chunks-manifest-v1', original_bytes: expected.originalBytes, observed_at: '2026-11-07T00:00:00.000Z', origin_machine: 'UNKNOWN', original_path: 'UNKNOWN' });
      expect(sha(row[RAW_BYTES])).toBe(expected.originalHash); if (!put) expect(row[RAW_BYTES]).toEqual(f.raw); else expect(row[RAW_BYTES]).toEqual(bytes.subarray(expected.offset, expected.offset + expected.originalBytes));
      events.push('put:' + put++);
    });
    try {
      const supplied = structuredClone(f.authority), writer = { ...pins };
      const result = await storeAcquisition(supplied, writer, f.ledger, f.ch, async (phase, bound) => {
        if (phase === 'PREPARE') { supplied.directoryStat.ino = '0'; writer.ownerHash = '0'.repeat(64); }
        return { admitted: true, bindingHash: bound.bindingHash };
      });
      expect(result.status).toBe('ACKS_DURABLE_COVERAGE_NOT_IMPLEMENTED'); expect(result.sourceComplete).toBe(false); expect(put).toBe(Math.ceil(bytes.length / CHUNK_BYTES) + 1);
      const intent = JSON.parse(fs.readFileSync(join(f.ledger, 'intent.json'), 'utf8'));
      for (let i = 0; i < put; i++) { const ack = JSON.parse(fs.readFileSync(join(f.ledger, `ack-${String(i).padStart(6, '0')}.json`), 'utf8')); expect(ack.acquisitionId).toBe(intent.documents[i].acquisitionId); }
      expect(fs.existsSync(join(f.ledger, 'storage-complete.json'))).toBe(false); expect(fs.statSync(f.ledger).mode & 0o777).toBe(0o700);
      await expect(storeAcquisition(f.authority, pins, f.ledger, f.ch, async (_p, b) => ({ admitted: true, bindingHash: b.bindingHash }))).rejects.toThrow('DURABLE_ACQUISITION_REFUSED');
      expect(put).toBe(Math.ceil(bytes.length / CHUNK_BYTES) + 1); expect(f.calls()).toBeGreaterThan(0);
    } finally { insert.mockRestore(); closed.mockRestore(); fsync.mockRestore(); open.mockRestore(); f.restore(); }
  }
});
test('intent/ACK IO, unknown/wrong ACK, current-owner and reader drift stop without advance or completion', async () => {
  for (const fault of ['intent', 'dir', 'close', 'ack', 'unknown', 'wrong', 'owner', 'schema', 'reader', 'space', 'partial', 'intent-drift', 'ack-drift', 'finish']) {
    const f = fixture(), originalOpen = custodyOps.open, sync = fs.fsyncSync, close = fs.closeSync, names = new Map<number, string>(), live = new Set<number>(); let puts = 0, directories = 0, closeFault = false;
    if (fault === 'partial') { fs.mkdirSync(f.ledger, { mode: 0o700 }); fs.writeFileSync(join(f.ledger, 'intent.json'), '{', { flag: 'wx', mode: 0o600 }); }
    const space = fault === 'space' ? spyOn(custodyOps, 'free').mockReturnValue(1) : undefined;
    const open = spyOn(custodyOps, 'open').mockImplementation((...args) => { const fd = originalOpen(...args); live.add(fd); if (args[2] & fs.constants.O_CREAT) names.set(fd, args[1]); return fd; });
    const closed = spyOn(fs, 'closeSync').mockImplementation(fd => { close(fd); live.delete(fd); if (fault === 'close' && names.get(fd) === 'intent.json' && !closeFault) { closeFault = true; throw Error('PRIVATE_CLOSE_SENTINEL'); } });
    const fsync = spyOn(fs, 'fsyncSync').mockImplementation(fd => { if ((fault === 'dir' && fs.fstatSync(fd).isDirectory() && ++directories === 2) || names.get(fd) === (fault === 'intent' ? 'intent.json' : fault === 'ack' ? 'ack-000000.json' : 'NONE')) throw Error('PRIVATE_IO_SENTINEL'); sync(fd); });
    const insert = spyOn(ClickHouse.prototype, 'insert').mockImplementation(async () => { puts++; if (fault === 'unknown') throw Error('PRIVATE_UNKNOWN_SENTINEL');
      if (fault === 'reader') fs.chmodSync(join(f.out, '000000.bin'), 0o644); });
    const wrong = fault === 'wrong' ? spyOn(RawDocumentStore.prototype, 'put').mockImplementation(async () => { puts++; return { revisionId: '0'.repeat(64), acquisitionId: '0'.repeat(64), status: 'ACKNOWLEDGED' }; }) : undefined;
    try {
      await expect(storeAcquisition(f.authority, pins, f.ledger, f.ch, async (phase, b) => {
        if (phase === 'DISPATCH' && (fault === 'intent-drift' || fault === 'ack-drift' && puts > 0)) fs.writeFileSync(join(f.ledger, fault === 'intent-drift' ? 'intent.json' : 'ack-000000.json'), '{');
        return { admitted: ((fault !== 'schema' || phase !== 'DISPATCH') && (fault !== 'finish' || phase !== 'FINISH')) as true, bindingHash: fault === 'owner' && phase === 'DISPATCH' ? '0'.repeat(64) : b.bindingHash };
      })).rejects.toThrow(new RegExp('^DURABLE_ACQUISITION_' + (fault === 'unknown' || fault === 'wrong' ? 'ACK_UNKNOWN' : fault === 'ack' ? 'ACK_UNRECORDED' : 'REFUSED') + '$'));
      expect(puts).toBe(['intent', 'dir', 'close', 'owner', 'schema', 'space', 'partial', 'intent-drift'].includes(fault) ? 0 : fault === 'finish' ? 2 : 1); expect(fs.existsSync(join(f.ledger, 'storage-complete.json'))).toBe(false);
      expect(fs.existsSync(join(f.ledger, 'ack-000001.json'))).toBe(fault === 'finish'); expect(fs.existsSync(join(f.ledger, 'intent.json'))).toBe(fault !== 'space'); expect(live.size).toBe(0);
    } finally { wrong?.mockRestore(); insert.mockRestore(); fsync.mockRestore(); closed.mockRestore(); open.mockRestore(); space?.mockRestore(); f.restore(); }
  }
});

// Honest final admission awaits while a separate actor changes the imported source.
test('R1 final admission source drift refuses after last awaited gate', async () => {
  for (const mutation of ['mode', 'bytes', 'manifest']) {
    const f = fixture(); let finish = 0, puts = 0;
    const insert = spyOn(ClickHouse.prototype, 'insert').mockImplementation(async () => { puts++; });
    let release!: () => void, reached!: () => void;
    const latch = new Promise<void>(r => { release = r; });
    const ready = new Promise<void>(r => { reached = r; });
    const pending = storeAcquisition(f.authority, pins, f.ledger, f.ch, async (phase, binding) => {
      if (phase === 'FINISH' && ++finish === 2) { reached(); await latch; }
      return { admitted: true, bindingHash: binding.bindingHash };
    });
    try {
      await ready;
      if (mutation === 'mode') fs.chmodSync(join(f.out, '000000.bin'), 0o644);
      if (mutation === 'bytes') fs.writeFileSync(join(f.out, '000000.bin'), Buffer.alloc(f.authority.wholeBytes));
      if (mutation === 'manifest') fs.appendFileSync(join(f.out, 'manifest.json'), ' ');
      release();
      await expect(pending).rejects.toThrow(/^DURABLE_ACQUISITION_REFUSED$/);
      expect(finish).toBe(2); expect(puts).toBe(2);
      expect(fs.existsSync(join(f.ledger, 'storage-complete.json'))).toBe(false);
    } finally { release(); insert.mockRestore(); f.restore(); }
  }
});

test('DISPATCH follows put preflight so owner loss cannot admit an INSERT', async () => {
  const f = fixture(); let owned = true, puts = 0;
  f.onQuery(sql => { if (sql.includes('system.disks')) owned = false; });
  const insert = spyOn(ClickHouse.prototype, 'insert').mockImplementation(async () => { puts++; });
  try {
    await expect(storeAcquisition(f.authority, pins, f.ledger, f.ch, async (phase, binding) => ({
      admitted: (phase !== 'DISPATCH' || owned) as true, bindingHash: binding.bindingHash,
    }))).rejects.toThrow(/^DURABLE_ACQUISITION_REFUSED$/);
    expect(puts).toBe(0); expect(fs.existsSync(join(f.ledger, 'ack-000000.json'))).toBe(false);
  } finally { insert.mockRestore(); f.restore(); }
});
