import { test, expect, spyOn } from 'bun:test';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { acquireFile, verifyReassembly, chunkDocument, CHUNK_BYTES, statPin } from '../../src/history-file-chunks/acquire';
import { custodyOps } from '../../src/metadata/private-fs';
import { encodeRow, RAW_BYTES } from '../../src/lib/clickhouse';
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
function fixture(bytes = Buffer.concat([Buffer.from('\ufeff{\r\n"x":"שלום🌍"}'), Buffer.alloc(CHUNK_BYTES, 0), Buffer.from([255, 128, 32, 9])])) {
  const dir = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'history-chunks-'))), path = join(dir, 'source');
  fs.writeFileSync(path, bytes);
  const spec = { path, custodyMachine: 'synthetic-m4', sourceFormat: 'opaque-file', wholeHash: sha(bytes), wholeBytes: bytes.length,
    stat: statPin(fs.lstatSync(path, { bigint: true })), method: 'synthetic-two-pass', observedAt: '2026-11-07T00:00:00.000Z', evidenceHash: 'a'.repeat(64) };
  return { dir, path, bytes, spec, out: join(dir, 'out') };
}

test('two-pass exact whole file, stable replay, private complete acquisition not stored-source completion', () => {
  const f = fixture(), a = acquireFile(f.spec, f.out), b = acquireFile(f.spec, join(f.dir, 'replay'));
  expect(a.manifest.chunkCount).toBe(a.manifest.chunks.length); expect(a).toEqual(b); expect(a.manifest.acquisitionComplete).toBe(true); expect(a.manifest.sourceComplete).toBe(false);
  const buffers = a.manifest.chunks.map(c => fs.readFileSync(join(f.out, c.file)));
  expect(Buffer.concat(buffers)).toEqual(f.bytes); expect(verifyReassembly(a.manifest, buffers).wholeHash).toBe(f.spec.wholeHash);
  expect(fs.statSync(f.out).mode & 0o777).toBe(0o700);
  for (const file of fs.readdirSync(f.out)) expect(fs.statSync(join(f.out, file)).mode & 0o777).toBe(0o600);
  const input = chunkDocument(a, 0, buffers[0]); expect(input.format).toBe('history-file-chunks-v1');
  const { bytes: _bytes, ...metadata } = input; const row = { ...metadata, raw: '', [RAW_BYTES]: buffers[0] }; expect(encodeRow(row).length + 1).toBeLessThan(8 * 1024 ** 2);
  expect(() => acquireFile(f.spec, f.out)).toThrow(); expect(fs.readFileSync(f.path)).toEqual(f.bytes);
});

test('missing, reordered, gaps, overlap, changed chunks and whole hash refuse; cross-custody stays distinct', () => {
  const f = fixture(), a = acquireFile(f.spec, f.out), m = a.manifest;
  const buffers = m.chunks.map(c => fs.readFileSync(join(f.out, c.file)));
  for (const chunks of [buffers.slice(1), [...buffers].reverse(), [Buffer.from('changed'), ...buffers.slice(1)]])
    expect(() => verifyReassembly(m, chunks)).toThrow();
  for (const change of [{ offset: 1 }, { index: 1 }, { bytes: 1 }]) {
    const bad = structuredClone(m); Object.assign(bad.chunks[0], change); expect(() => verifyReassembly(bad, buffers)).toThrow();
  }
  expect(() => verifyReassembly({ ...m, chunkCount: m.chunkCount + 1 }, buffers)).toThrow();
  expect(() => verifyReassembly({ ...m, acquisitionComplete: 'yes' as never }, buffers)).toThrow();
  expect(() => verifyReassembly({ ...m, wholeHash: 'b'.repeat(64) }, buffers)).toThrow();
  const copy = acquireFile({ ...f.spec, custodyMachine: 'synthetic-m1' }, join(f.dir, 'copy'));
  expect(copy.manifest.sourceRevision).not.toBe(m.sourceRevision); expect(copy.manifest.wholeHash).toBe(m.wholeHash);
});

test('symlink, wrong pins, oversized metadata and deadline refuse without final manifest', () => {
  const f = fixture(Buffer.from('{"x":1}'));
  fs.symlinkSync(f.path, join(f.dir, 'alias'));
  for (const change of [{ path: join(f.dir, 'alias') }, { wholeHash: 'b'.repeat(64) }, { wholeBytes: 1024 ** 3 + 1 }, { custodyMachine: 'x'.repeat(129) }])
    expect(() => acquireFile({ ...f.spec, ...change }, f.out)).toThrow();
  const clock = spyOn(performance, 'now'); let n = 0; clock.mockImplementation(() => n++ ? 60_000 : 0);
  try { expect(() => acquireFile(f.spec, f.out)).toThrow('FILE_CHUNKS_DEADLINE'); } finally { clock.mockRestore(); }
  expect(fs.existsSync(join(f.out, 'manifest.json'))).toBe(false);
  const hard = fixture(Buffer.from('hardlink')); fs.linkSync(hard.path, join(hard.dir, 'second-name'));
  expect(() => acquireFile(hard.spec, hard.out)).toThrow('FILE_CHUNKS_SOURCE_CHANGED');
});

test('second-pass source mutation retains partial evidence and never commits source completion', () => {
  const f = fixture(), original = custodyOps.open; let mutated = false;
  const mock = spyOn(custodyOps, 'open').mockImplementation((fd, name, flags, mode) => {
    if (name === '000001.bin' && !mutated) { mutated = true; fs.appendFileSync(f.path, 'SYNTHETIC_CHANGED'); }
    return original(fd, name, flags, mode);
  });
  try { expect(() => acquireFile(f.spec, f.out)).toThrow(); } finally { mock.mockRestore(); }
  expect(mutated).toBe(true); expect(fs.existsSync(join(f.out, 'intent.json'))).toBe(true);
  expect(fs.existsSync(join(f.out, '000000.bin'))).toBe(true); expect(fs.existsSync(join(f.out, 'manifest.json'))).toBe(false);
});

test('anchored output refuses ancestor substitution and retains existing destination', () => {
  const f = fixture(Buffer.from('no-final-LF')), target = join(f.dir, 'target'), original = custodyOps.open;
  fs.mkdirSync(target); let changed = false;
  const mock = spyOn(custodyOps, 'open').mockImplementation((fd, name, flags, mode) => {
    if (name === '000000.bin' && !changed) { changed = true; fs.renameSync(f.out, f.out + '-old'); fs.symlinkSync(target, f.out); }
    return original(fd, name, flags, mode);
  });
  try { expect(() => acquireFile(f.spec, f.out)).toThrow(); } finally { mock.mockRestore(); }
  expect(changed).toBe(true); expect(fs.readdirSync(target)).toEqual([]);
  expect(fs.existsSync(join(f.out + '-old', 'manifest.json'))).toBe(false);
});

test('empty source and final manifest destination collision remain explicit and no-overwrite', () => {
  const empty = fixture(Buffer.alloc(0)), r = acquireFile(empty.spec, empty.out);
  expect(r.manifest.chunks).toHaveLength(0); expect(verifyReassembly(r.manifest, []).wholeHash).toBe(sha(Buffer.alloc(0)));
  const f = fixture(Buffer.from('tail')), original = custodyOps.open; let planted = false;
  const mock = spyOn(custodyOps, 'open').mockImplementation((fd, name, flags, mode) => {
    if (name === 'manifest.json.pending' && !planted) { planted = true; fs.writeFileSync(join(f.out, 'manifest.json'), 'EXISTING', { flag: 'wx', mode: 0o600 }); }
    return original(fd, name, flags, mode);
  });
  try { expect(() => acquireFile(f.spec, f.out)).toThrow(); } finally { mock.mockRestore(); }
  expect(planted).toBe(true); expect(fs.readFileSync(join(f.out, 'manifest.json'), 'utf8')).toBe('EXISTING');
  expect(fs.existsSync(join(f.out, 'manifest.json.pending'))).toBe(true);
});
