import { test, expect, spyOn } from 'bun:test';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { acquireFile, statPin, CHUNK_BYTES, chunkDocument } from '../../src/history-file-chunks/acquire';
import { importAcquisition, type ImportAuthority } from '../../src/history-file-chunks/imported';
import { custodyOps } from '../../src/metadata/private-fs';
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
function fixture(bytes = Buffer.from('\ufeff{\r\n  "x":"שלום🌍"\r\n}\tTAIL')) {
  const root = process.env.IMPORTED_READER_TEST_ROOT!;
  if (!root) throw Error('OWNED_TEST_ROOT_REQUIRED');
  const dir = fs.mkdtempSync(join(root, 'reader-')), source = join(dir, 'source'), out = join(dir, 'out');
  fs.writeFileSync(source, bytes, { mode: 0o600, flag: 'wx' });
  let calls = 0;
  const free = spyOn(custodyOps, 'free').mockImplementation(() => { calls++; return 64 * 1024 ** 3; });
  let r;
  try { r = acquireFile({ path: source, custodyMachine: 'owned', sourceFormat: 'opaque', wholeHash: sha(bytes), wholeBytes: bytes.length,
    stat: statPin(fs.statSync(source, { bigint: true })), method: 'owned', observedAt: '2026-11-07T00:00:00.000Z', evidenceHash: 'a'.repeat(64) }, out); }
  finally { free.mockRestore(); }
  expect(calls).toBeGreaterThan(0);
  const manifest = join(out, 'manifest.json'), raw = fs.readFileSync(manifest);
  const pin = (): ImportAuthority => ({ directory: out, directoryStat: statPin(fs.statSync(out, { bigint: true })),
    manifestStat: statPin(fs.statSync(manifest, { bigint: true })), manifestBytes: raw.length, manifestHash: sha(raw), receiptHash: r.receiptHash,
    sourceRevision: r.manifest.sourceRevision, acquisitionId: r.manifest.acquisitionId, wholeHash: sha(bytes), wholeBytes: bytes.length, authorityHash: 'b'.repeat(64) });
  return { out, dir, source, bytes, r, raw, pin };
}
const refused = (fn: () => unknown) => expect(fn).toThrow('IMPORTED_ACQUISITION_REFUSED');
test('owned complete bytes, tail, empty, bounded chunks, immutable handle and fresh completion join', () => {
  for (const bytes of [Buffer.alloc(0), Buffer.from('{"x":1}'), Buffer.concat([Buffer.alloc(CHUNK_BYTES, 0), Buffer.from([255, 128, 32, 9])])]) {
    const f = fixture(bytes), authority = f.pin(), reader = importAcquisition(authority);
    authority.wholeHash = '0'.repeat(64); authority.directoryStat.ino = '0';
    expect(Object.isFrozen(reader)).toBe(true); expect(Object.isFrozen(reader.summary)).toBe(true);
    expect(Object.isFrozen(reader.summary.chunks)).toBe(true);
    for (const chunk of reader.summary.chunks) expect(Object.isFrozen(chunk)).toBe(true);
    let at = 0;
    for (let i = 0; i < reader.summary.chunkCount; i++) { const doc = reader.readChunk(i); expect(doc.bytes).toEqual(bytes.subarray(at, at + doc.originalBytes));
      expect(doc).toEqual(chunkDocument(f.r, i, doc.bytes)); at += doc.originalBytes; }
    expect(at).toBe(bytes.length); expect(reader.verifyWhole()).toEqual({ wholeHash: sha(bytes), wholeBytes: bytes.length, joinVerified: true, sourceComplete: false });
    refused(() => reader.readChunk(-1)); expect(fs.readFileSync(f.source)).toEqual(bytes);
  }
  const f = fixture(), reader = importAcquisition(f.pin()); expect(reader.readChunk(0).bytes).toEqual(f.bytes);
  reader.readChunk(0).bytes.fill(0); expect(reader.readChunk(0).bytes).toEqual(f.bytes);
  const clock = spyOn(performance, 'now').mockReturnValue(1_000_000);
  try { expect(reader.verifyWhole().joinVerified).toBe(true); } finally { clock.mockRestore(); }
});
test('externally pinned canonical final receipt only; duplicate/unknown/pending/malformed authority refuses', () => {
  const f = fixture();
  for (const edit of [(s: string) => s.replace('"manifest":', '"extra":0,"manifest":'), (s: string) => s.replace('"version":1', '"version":1,"version":1'),
    (s: string) => s.replace('"acquisitionComplete":true', '"acquisitionComplete":false'), (s: string) => s.replace('000000.bin', '../bad.bin'), (s: string) => s.replace('"index":0', '"index":1'),
    (s: string) => ' ' + s, (s: string) => s.replace('"wholeBytes":', '"wholeBytes":1e999,"ignored":')]) {
    const raw = Buffer.from(edit(f.raw.toString())); fs.writeFileSync(join(f.out, 'manifest.json'), raw);
    const pin = f.pin(); pin.manifestBytes = raw.length; pin.manifestHash = sha(raw); pin.manifestStat = statPin(fs.statSync(join(f.out, 'manifest.json'), { bigint: true }));
    refused(() => importAcquisition(pin));
  }
  fs.writeFileSync(join(f.out, 'manifest.json'), f.raw);
  for (const change of [{ authorityHash: '' }, { manifestHash: '0'.repeat(64) }, { wholeBytes: -1 }, { wholeBytes: 1024 ** 3 + 1 }, { wholeBytes: NaN }, { manifestBytes: 512 * 1024 + 1 }]) refused(() => importAcquisition({ ...f.pin(), ...change }));
  fs.writeFileSync(join(f.out, 'manifest.json.pending'), 'owned'); refused(() => importAcquisition(f.pin()));
});
test('read and completion recheck identity, permissions, contents, missing/extra chunks and aliases', () => {
  for (const kind of ['corrupt', 'mode', 'hard', 'symlink', 'missing', 'extra', 'directory', 'manifest']) {
    const f = fixture(), reader = importAcquisition(f.pin()), file = join(f.out, '000000.bin');
    if (kind === 'corrupt') fs.writeFileSync(file, Buffer.alloc(f.bytes.length));
    if (kind === 'mode') fs.chmodSync(file, 0o644);
    if (kind === 'hard') fs.linkSync(file, join(f.dir, 'hard'));
    if (kind === 'symlink') { fs.renameSync(file, join(f.dir, 'saved')); fs.symlinkSync(join(f.dir, 'saved'), file); }
    if (kind === 'missing') fs.renameSync(file, join(f.dir, 'missing'));
    if (kind === 'extra') fs.writeFileSync(join(f.out, '000001.bin'), 'extra', { mode: 0o600 });
    if (kind === 'directory') fs.chmodSync(f.out, 0o755);
    if (kind === 'manifest') fs.appendFileSync(join(f.out, 'manifest.json'), ' ');
    refused(() => reader.readChunk(0)); refused(() => reader.verifyWhole()); refused(() => importAcquisition(f.pin()));
  }
  const f = fixture(); fs.symlinkSync(f.out, join(f.dir, 'alias')); refused(() => importAcquisition({ ...f.pin(), directory: join(f.dir, 'alias') }));
});
test('local deadline and independent read-only close faults are sanitized and all descriptors attempted', () => {
  const f = fixture(), originalOpen = custodyOps.open, originalClose = fs.closeSync, live = new Set<number>(); let injected = false;
  let target = -1;
  const open = spyOn(custodyOps, 'open').mockImplementation((...args) => { const fd = originalOpen(...args); live.add(fd); if (args[1] === 'out' && target < 0) target = fd; return fd; });
  const close = spyOn(fs, 'closeSync').mockImplementation(fd => { originalClose(fd); live.delete(fd); if (fd === target && !injected) { injected = true; throw Error('OWNED_PRIVATE_SENTINEL'); } });
  try { expect(importAcquisition(f.pin()).verifyWhole().joinVerified).toBe(true); } finally { close.mockRestore(); open.mockRestore(); }
  expect(injected).toBe(true); expect(live.size).toBe(0);
  const clock = spyOn(performance, 'now'); let n = 0; clock.mockImplementation(() => n++ ? 60_000 : 0);
  try { refused(() => importAcquisition(f.pin())); } finally { clock.mockRestore(); }
});
test('whole join refuses earlier chunk drift during a later read; original source is never reopened', () => {
  const f = fixture(Buffer.concat([Buffer.alloc(CHUNK_BYTES, 1), Buffer.from('TAIL')])), original = fs.readSync;
  fs.renameSync(f.source, join(f.dir, 'original-not-at-locator'));
  const reader = importAcquisition(f.pin()); let changed = false;
  const read = spyOn(fs, 'readSync').mockImplementation((fd: number, buffer: NodeJS.ArrayBufferView, offset: number | fs.ReadOptions = {}, length?: number, position?: fs.ReadPosition | null) => {
    const n = typeof offset === 'number' ? original(fd, buffer, offset, length!, position ?? null) : original(fd, buffer, offset);
    if (!changed && position === 0 && n === 4) { changed = true; fs.chmodSync(join(f.out, '000000.bin'), 0o644); }
    return n;
  });
  try { refused(() => reader.verifyWhole()); } finally { read.mockRestore(); }
  expect(changed).toBe(true); expect(fs.existsSync(f.source)).toBe(false);
});
test('authority is cloned before IO; read faults sanitize primary error and close every owned descriptor', () => {
  const f = fixture(), p = f.pin(), originalOpen = custodyOps.open, originalClose = fs.closeSync;
  let mutated = false;
  const open = spyOn(custodyOps, 'open').mockImplementation((...args) => {
    if (!mutated) { mutated = true; p.directory = '/NOT_AUTHORIZED'; p.manifestStat.ino = '0'; }
    return originalOpen(...args);
  });
  try { expect(importAcquisition(p).readChunk(0).bytes).toEqual(f.bytes); } finally { open.mockRestore(); }
  const live = new Set<number>(); let injected = false;
  const track = spyOn(custodyOps, 'open').mockImplementation((...args) => { const fd = originalOpen(...args); live.add(fd); return fd; });
  const close = spyOn(fs, 'closeSync').mockImplementation(fd => { originalClose(fd); live.delete(fd); if (!injected) { injected = true; throw Error('OWNED_CLOSE_SENTINEL'); } });
  const read = spyOn(fs, 'readSync').mockImplementation(() => { throw Error('OWNED_PATH_AND_BYTES_SENTINEL'); });
  try { refused(() => importAcquisition(f.pin())); } finally { read.mockRestore(); close.mockRestore(); track.mockRestore(); }
  expect(injected).toBe(true); expect(live.size).toBe(0);
});
