import * as fs from 'node:fs';
import { dirname, basename, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { custodyOps, directoryFlags, closeOnExec, atCwd } from '../metadata/private-fs';
import { guardGit } from '../metadata/gemini-output';
import { FLOOR_BYTES, PENDING_BYTES } from '../metadata/output';
import type { RawDocument } from '../raw-document/storage';

export const CHUNK_BYTES = 1024 ** 2;
const MAX_BYTES = 1024 ** 3, MAX_MANIFEST = 512 * 1024, DEADLINE = 30_000;
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const fail = (s: string): never => { throw Error(`FILE_CHUNKS_${s}`); };
const hash = (s: unknown) => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s);
const text = (s: string, cap: number) => typeof s === 'string' && s.length > 0 && Buffer.byteLength(s) <= cap && Buffer.from(s).toString() === s && !/[\x00-\x1f\x7f]/.test(s);
export function statPin(s: fs.BigIntStats) {
  return { dev: String(s.dev), ino: String(s.ino), size: String(s.size), birthtimeNs: String(s.birthtimeNs), mtimeNs: String(s.mtimeNs), ctimeNs: String(s.ctimeNs) };
}
export type FilePin = { path: string; custodyMachine: string; sourceFormat: string; wholeHash: string; wholeBytes: number;
  stat: ReturnType<typeof statPin>; method: string; observedAt: string; evidenceHash: string };
type Chunk = { index: number; offset: number; bytes: number; hash: string; file: string };
export type FileManifest = FilePin & { kind: 'history-file-chunks-v1'; version: 1; chunkBytes: number; chunkCount: number; chunks: Chunk[];
  sourceRevision: string; acquisitionId: string; originMachine: 'UNKNOWN'; originProof: 'UNKNOWN'; originalPath: 'UNKNOWN';
  acquisitionComplete: boolean; sourceComplete: false };
export type Receipt = { manifest: FileManifest; receiptHash: string };
function validate(p: FilePin) {
  if (!text(p.path, 4096) || resolve(p.path) !== p.path || !text(p.custodyMachine, 128) || !text(p.sourceFormat, 128) ||
    !text(p.method, 256) || !hash(p.wholeHash) || !hash(p.evidenceHash) || !Number.isSafeInteger(p.wholeBytes) || p.wholeBytes < 0 || p.wholeBytes > MAX_BYTES ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(p.observedAt) || !Number.isFinite(Date.parse(p.observedAt)) || new Date(p.observedAt).toISOString() !== p.observedAt ||
    !p.stat || ['dev', 'ino', 'size', 'birthtimeNs', 'mtimeNs', 'ctimeNs'].some(k => !/^\d{1,30}$/.test(p.stat[k as keyof typeof p.stat])) || p.stat.size !== String(p.wholeBytes)) fail('PIN_INVALID');
}
/** Holds canonical ancestor descriptors. No root discovery or pathname-only output writes. */
class Anchor {
  chain: { fd: number; name: string; id: string }[] = [];
  get fd() { return this.chain.at(-1)!.fd; }
  constructor(path: string) {
    try {
      if (resolve(path) !== path || fs.realpathSync(path) !== path || path.length > 4096) fail('PATH_ALIAS');
      this.add(atCwd(), '/');
      const parts = path.split('/').filter(Boolean); if (parts.length > 126) fail('PATH_BOUND');
      for (const name of parts) this.add(this.fd, name);
      this.assert();
    } catch (e) { this.close(); throw e; }
  }
  add(parent: number, name: string) {
    const fd = custodyOps.open(parent, name, directoryFlags), s = fs.fstatSync(fd);
    this.chain.push({ fd, name, id: `${s.dev}:${s.ino}` });
  }
  assert() {
    for (let i = 1; i < this.chain.length; i++) {
      const e = this.chain[i], fd = custodyOps.open(this.chain[i - 1].fd, e.name, directoryFlags);
      try { const s = fs.fstatSync(fd); if (`${s.dev}:${s.ino}` !== e.id) fail('DIRECTORY_CHANGED'); } finally { fs.closeSync(fd); }
    }
  }
  close() { for (const { fd } of this.chain.reverse()) { try { fs.closeSync(fd); } catch {} } this.chain = []; }
}
const revision = (p: FilePin) => sha(JSON.stringify(['history-file-chunks-v1', p.custodyMachine, p.path, p.sourceFormat, p.wholeHash, p.wholeBytes]));
const acquisition = (p: FilePin) => sha(JSON.stringify([revision(p), p.stat, p.method, p.observedAt, p.evidenceHash]));
function topology(m: FileManifest) {
  validate(m);
  if (m.kind !== 'history-file-chunks-v1' || m.version !== 1 || m.chunkBytes !== CHUNK_BYTES ||
    typeof m.acquisitionComplete !== 'boolean' || !Array.isArray(m.chunks) || m.chunkCount !== m.chunks.length || m.chunks.length !== Math.ceil(m.wholeBytes / CHUNK_BYTES) || m.sourceComplete !== false ||
    m.sourceRevision !== revision(m) || m.acquisitionId !== acquisition(m) || m.originMachine !== 'UNKNOWN' || m.originProof !== 'UNKNOWN' || m.originalPath !== 'UNKNOWN') fail('MANIFEST_INVALID');
  m.chunks.forEach((c, i) => { if (c.index !== i || c.offset !== i * CHUNK_BYTES || c.bytes !== Math.min(CHUNK_BYTES, m.wholeBytes - c.offset) ||
    !hash(c.hash) || c.file !== `${String(i).padStart(6, '0')}.bin`) fail('CHUNK_TOPOLOGY'); });
}
/** Streaming join proof only; never a storage checkpoint or source-complete claim. */
export function verifyReassembly(m: FileManifest, buffers: Iterable<Buffer>) {
  topology(m); const digest = createHash('sha256'); let index = 0, bytes = 0;
  for (const b of buffers) {
    const c = m.chunks[index++];
    if (!c || !Buffer.isBuffer(b) || b.length !== c.bytes || sha(b) !== c.hash) fail('CHUNK_CHANGED');
    digest.update(b); bytes += b.length;
  }
  const wholeHash = digest.digest('hex');
  if (index !== m.chunks.length || bytes !== m.wholeBytes || wholeHash !== m.wholeHash) fail('WHOLE_JOIN');
  return { wholeHash, wholeBytes: bytes, joinVerified: true, sourceComplete: false as const };
}
/** Explicit new representation: verified COMPLETE chunk document, not the complete original source. */
export function chunkDocument(r: Receipt, index: number, bytes: Buffer): RawDocument {
  const m = r.manifest; topology(m);
  if (m.acquisitionComplete !== true || sha(JSON.stringify(m)) !== r.receiptHash || !Number.isSafeInteger(index)) fail('RECEIPT_INVALID');
  const c = m.chunks[index]; if (!c || !Buffer.isBuffer(bytes) || bytes.length !== c.bytes || sha(bytes) !== c.hash) fail('CHUNK_CHANGED');
  return { bytes: Buffer.from(bytes), originalHash: c.hash, originalBytes: c.bytes, custodyMachine: m.custodyMachine,
    sourceLocator: `history-file-chunks-v1:${m.sourceRevision}:${index}`, format: 'history-file-chunks-v1', formatVersion: '1',
    acquisition: { method: m.method, observedAt: m.observedAt, receiptHash: r.receiptHash } };
}
/** One explicit allowlisted pin, two descriptor passes, fresh private outputs; no writer, CLI or retry. */
export function acquireFile(input: FilePin, output: string): Receipt {
  const started = performance.now();
  const check = () => { if (performance.now() - started >= DEADLINE) fail('DEADLINE'); };
  let source: Anchor | undefined, out: Anchor | undefined, fd: number | undefined;
  try {
    const copied = structuredClone(input);
    const p: FilePin = { path: copied.path, custodyMachine: copied.custodyMachine, sourceFormat: copied.sourceFormat, wholeHash: copied.wholeHash, wholeBytes: copied.wholeBytes,
      stat: { dev: copied.stat?.dev, ino: copied.stat?.ino, size: copied.stat?.size, birthtimeNs: copied.stat?.birthtimeNs, mtimeNs: copied.stat?.mtimeNs, ctimeNs: copied.stat?.ctimeNs },
      method: copied.method, observedAt: copied.observedAt, evidenceHash: copied.evidenceHash }; validate(p); check();
    source = new Anchor(dirname(p.path));
    fd = custodyOps.open(source.fd, basename(p.path), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK | closeOnExec);
    const stable = () => {
      check(); source!.assert();
      for (const s of [fs.fstatSync(fd!, { bigint: true }), fs.lstatSync(p.path, { bigint: true })])
        if (!s.isFile() || s.nlink !== 1n || JSON.stringify(statPin(s)) !== JSON.stringify(p.stat)) fail('SOURCE_CHANGED');
    };
    stable();
    const chunks: Chunk[] = [], scratch = Buffer.alloc(CHUNK_BYTES);
    const pass = function* (first: boolean): Generator<Buffer> {
      const digest = createHash('sha256'); let offset = 0, index = 0;
      while (offset < p.wholeBytes) {
        check(); const size = Math.min(CHUNK_BYTES, p.wholeBytes - offset); let got = 0;
        while (got < size) { check(); const n = fs.readSync(fd!, scratch, got, size - got, offset + got); if (!n) fail('SHORT_READ'); got += n; }
        const b = scratch.subarray(0, size), h = sha(b); digest.update(b);
        if (first) chunks.push({ index, offset, bytes: size, hash: h, file: `${String(index).padStart(6, '0')}.bin` });
        else if (chunks[index].hash !== h) fail('CHUNK_CHANGED');
        yield b; offset += size; index++;
      }
      check(); if (fs.readSync(fd!, scratch, 0, 1, p.wholeBytes) !== 0 || digest.digest('hex') !== p.wholeHash) fail('WHOLE_PIN');
      stable();
    };
    for (const _ of pass(true)) {} // No payload persistence in first pass.
    const sourceRevision = revision(p), acquisitionId = acquisition(p);
    const m: FileManifest = { ...p, kind: 'history-file-chunks-v1', version: 1, chunkBytes: CHUNK_BYTES, chunkCount: chunks.length, chunks, sourceRevision, acquisitionId,
      originMachine: 'UNKNOWN', originProof: 'UNKNOWN', originalPath: 'UNKNOWN', acquisitionComplete: false, sourceComplete: false };
    topology(m); output = resolve(output); if (output.length > 4096) fail('OUTPUT_PATH');
    out = new Anchor(dirname(output)); guardGit(output); out.assert();
    let remaining = p.wholeBytes + MAX_MANIFEST * 2;
    const room = () => { check(); out!.assert(); if (custodyOps.free(out!.fd) < FLOOR_BYTES + PENDING_BYTES + remaining) fail('SPACE'); };
    room(); custodyOps.mkdir(out.fd, basename(output)); out.add(out.fd, basename(output)); out.assert();
    if ((fs.fstatSync(out.fd).mode & 0o777) !== 0o700) fail('OUTPUT_MODE');
    const write = (name: string, bytes: Buffer) => {
      room(); const f = custodyOps.open(out!.fd, name, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW | closeOnExec, 0o600);
      try {
        const s = fs.fstatSync(f); if (!s.isFile() || s.nlink !== 1 || (s.mode & 0o777) !== 0o600) fail('OUTPUT_MODE');
        out!.assert(); let at = 0;
        while (at < bytes.length) { room(); const n = fs.writeSync(f, bytes, at, bytes.length - at); if (n <= 0) fail('SHORT_WRITE'); at += n; }
        fs.fsyncSync(f); out!.assert(); remaining -= bytes.length;
      } finally { fs.closeSync(f); }
    };
    const json = (v: unknown) => { const b = Buffer.from(JSON.stringify(v) + '\n'); if (b.length > MAX_MANIFEST) fail('MANIFEST_CAP'); return b; };
    write('intent.json', json({ manifest: m, receiptHash: sha(JSON.stringify(m)) }));
    const verified = function* () { let i = 0; for (const b of pass(false)) { write(chunks[i++].file, b); yield b; } };
    verifyReassembly(m, verified()); stable(); room();
    const final: FileManifest = { ...m, acquisitionComplete: true }, receipt = { manifest: final, receiptHash: sha(JSON.stringify(final)) };
    write('manifest.json.pending', json(receipt)); stable(); room(); fs.fsyncSync(out.fd);
    custodyOps.commit(out.fd); // Atomic no-replace final publication; no source-complete claim.
    return receipt;
  } catch (e) {
    if (e instanceof Error && /^FILE_CHUNKS_[A-Z_]+$/.test(e.message)) throw e;
    return fail('IO_OR_CUSTODY'); // Never expose source paths, private bytes or native exception text.
  } finally {
    // Cleanup cannot replace a sanitized refusal or a committed receipt.
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
    try { out?.close(); } catch {}
    try { source?.close(); } catch {}
  }
}
