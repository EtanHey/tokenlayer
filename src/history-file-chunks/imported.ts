import * as fs from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { custodyOps, directoryFlags, closeOnExec, atCwd } from '../metadata/private-fs';
import { CHUNK_BYTES, statPin, verifyReassembly, type Receipt } from './acquire';
import type { RawDocument } from '../raw-document/storage';

type Stat = ReturnType<typeof statPin>;
/** Issued by an external authorized allowlist, never inferred from an acquisition's self-hash. */
export type ImportAuthority = { directory: string; directoryStat: Stat; manifestStat: Stat; manifestBytes: number;
  manifestHash: string; receiptHash: string; sourceRevision: string; acquisitionId: string; wholeHash: string; wholeBytes: number; authorityHash: string };
const CAP = 512 * 1024, WHOLE = 1024 ** 3, DEADLINE = 30_000;
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const fail = (): never => { throw Error('IMPORTED_ACQUISITION_REFUSED'); };
const hash = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const number = (v: number, cap: number) => Number.isSafeInteger(v) && v >= 0 && v <= cap;
const statKeys = 'dev,ino,size,birthtimeNs,mtimeNs,ctimeNs';
function keys(value: unknown, names: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).join(',') !== names) fail();
}
function validStat(s: Stat) {
  keys(s, statKeys); if (Object.values(s).some(v => typeof v !== 'string' || !/^(0|[1-9]\d{0,29})$/.test(v))) fail();
}
const quiet = (fn: () => void) => { try { fn(); } catch {} };
const stamp = (s: fs.BigIntStats) => JSON.stringify(statPin(s));
function privateStat(s: fs.BigIntStats, directory = false) {
  if (!(directory ? s.isDirectory() : s.isFile()) || s.uid !== BigInt(process.getuid!()) ||
    (s.mode & 0o7777n) !== (directory ? 0o700n : 0o600n) || (!directory && s.nlink !== 1n)) fail();
}
function budget(bytes: number) {
  const start = performance.now(); let calls = 0, charged = 0;
  const check = () => { const now = performance.now(); if (!Number.isFinite(start) || !Number.isFinite(now) || now < start || now - start >= DEADLINE) fail(); };
  return { check, read: (n: number) => { check(); if (++calls > 8192 || (charged += n) > bytes) fail(); } };
}
type Budget = ReturnType<typeof budget>;
class Anchor {
  chain: { fd: number; name: string; id: string }[] = [];
  get fd() { return this.chain.at(-1)!.fd; }
  constructor(private p: ImportAuthority, private b: Budget) {
    try {
      b.check(); if (fs.realpathSync(p.directory) !== p.directory) fail();
      this.add(atCwd(), '/'); const parts = p.directory.split('/').filter(Boolean);
      if (parts.length > 126) fail(); for (const name of parts) this.add(this.fd, name);
      this.assert();
    } catch { this.close(); fail(); }
  }
  add(parent: number, name: string) {
    this.b.check(); const fd = custodyOps.open(parent, name, directoryFlags), e = { fd, name, id: '' };
    this.chain.push(e); const s = fs.fstatSync(fd, { bigint: true }); e.id = `${s.dev}:${s.ino}`;
  }
  assert() {
    this.b.check();
    for (let i = 1; i < this.chain.length; i++) {
      const e = this.chain[i], fd = custodyOps.open(this.chain[i - 1].fd, e.name, directoryFlags);
      try { const s = fs.fstatSync(fd, { bigint: true }); if (`${s.dev}:${s.ino}` !== e.id) fail(); }
      finally { quiet(() => fs.closeSync(fd)); }
    }
    const s = fs.fstatSync(this.fd, { bigint: true }); privateStat(s, true);
    if (stamp(s) !== JSON.stringify(this.p.directoryStat)) fail(); this.b.check();
  }
  close() { for (const e of this.chain.reverse()) quiet(() => fs.closeSync(e.fd)); this.chain = []; }
}
/** No public constructor/verified-record input: only closure-bound handles from a complete anchored join. */
export function importAcquisition(input: ImportAuthority) {
  try {
    const p = structuredClone(input); // Snapshot all caller-controlled authority before IO or async work.
    if (!p || Object.keys(p).sort().join(',') !== 'acquisitionId,authorityHash,directory,directoryStat,manifestBytes,manifestHash,manifestStat,receiptHash,sourceRevision,wholeBytes,wholeHash') fail();
    if (!p || typeof p.directory !== 'string' || p.directory.length > 4096 || resolve(p.directory) !== p.directory ||
      p.directory === '/' || !number(p.manifestBytes, CAP) || p.manifestBytes === 0 || !number(p.wholeBytes, WHOLE) ||
      ![p.manifestHash, p.receiptHash, p.sourceRevision, p.acquisitionId, p.wholeHash, p.authorityHash].every(hash)) fail();
    validStat(p.directoryStat); validStat(p.manifestStat); if (p.manifestStat.size !== String(p.manifestBytes)) fail();
    let receipt: Receipt, intentBytes: number, intentHash: string, intentPin: string | undefined;
    const chunkPins: string[] = [], chunkName = (i: number) => `${String(i).padStart(6, '0')}.bin`;
    function file(a: Anchor, b: Budget, name: string, size: number, expected: string | undefined, target: Buffer, digest: string) {
      b.check(); const fd = custodyOps.open(a.fd, name, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK | closeOnExec);
      try {
        const s = fs.fstatSync(fd, { bigint: true }); privateStat(s); const pin = stamp(s);
        if (s.size !== BigInt(size) || (expected !== undefined && pin !== expected)) fail();
        let at = 0;
        while (at < size) { b.read(size - at); const n = fs.readSync(fd, target, at, size - at, at); if (n <= 0) fail(); at += n; }
        // Charge attempted read sizes conservatively, including a one-byte EOF probe.
        const eof = Buffer.alloc(1); b.read(1);
        if (fs.readSync(fd, eof, 0, 1, size) !== 0 || sha(target.subarray(0, size)) !== digest) fail();
        const end = fs.fstatSync(fd, { bigint: true }); privateStat(end); if (stamp(end) !== pin) fail();
        b.check(); return pin;
      } finally { quiet(() => fs.closeSync(fd)); }
    }
    function load(a: Anchor, b: Budget) {
      const raw = Buffer.alloc(p.manifestBytes);
      file(a, b, 'manifest.json', p.manifestBytes, JSON.stringify(p.manifestStat), raw, p.manifestHash);
      if (!receipt) {
        const text = raw.toString('utf8'); if (!Buffer.from(text).equals(raw)) fail();
        const r = JSON.parse(text); keys(r, 'manifest,receiptHash'); const m = r.manifest;
        keys(m, 'path,custodyMachine,sourceFormat,wholeHash,wholeBytes,stat,method,observedAt,evidenceHash,kind,version,chunkBytes,chunkCount,chunks,sourceRevision,acquisitionId,originMachine,originProof,originalPath,acquisitionComplete,sourceComplete');
        validStat(m.stat);
        if (!Array.isArray(m.chunks) || m.chunks.length > 1024) fail();
        for (const c of m.chunks) keys(c, 'index,offset,bytes,hash,file');
        if (JSON.stringify(r) + '\n' !== text || m.acquisitionComplete !== true || r.receiptHash !== p.receiptHash ||
          sha(JSON.stringify(m)) !== p.receiptHash || m.sourceRevision !== p.sourceRevision || m.acquisitionId !== p.acquisitionId ||
          m.wholeHash !== p.wholeHash || m.wholeBytes !== p.wholeBytes) fail();
        receipt = r; // Internal only; topology validated before any chunk opens by verifyReassembly.
        const intent = JSON.stringify({ manifest: { ...m, acquisitionComplete: false }, receiptHash: sha(JSON.stringify({ ...m, acquisitionComplete: false })) }) + '\n';
        intentBytes = Buffer.byteLength(intent); if (intentBytes > CAP) fail(); intentHash = sha(intent);
      }
      intentPin = file(a, b, 'intent.json', intentBytes, intentPin, Buffer.alloc(intentBytes), intentHash);
    }
    function layout(a: Anchor, b: Budget) {
      a.assert(); const expected = new Set(['manifest.json', 'intent.json', ...receipt.manifest.chunks.map((_, i) => chunkName(i))]);
      // Bounded name-only listing of the pinned path, with anchored identity checks on both sides.
      const dir = fs.opendirSync(p.directory); let count = 0;
      try { for (;;) { b.check(); const entry = dir.readSync(); if (!entry) break;
        if (++count > 1026 || !expected.delete(entry.name)) fail(); } }
      finally { quiet(() => dir.closeSync()); }
      if (expected.size) fail(); a.assert();
    }
    function run<T>(whole: boolean, fn: (a: Anchor, b: Budget) => T): T {
      const b = budget((whole ? p.wholeBytes : CHUNK_BYTES) + 4 * CAP + 1028); let a: Anchor | undefined;
      try { a = new Anchor(p, b); load(a, b); const result = fn(a, b); load(a, b); layout(a, b); b.check(); return result; }
      catch { return fail(); } finally { a?.close(); }
    }
    const whole = () => run(true, (a, b) => {
      const scratch = Buffer.alloc(Math.min(CHUNK_BYTES, p.wholeBytes));
      function* chunks() {
        for (const c of receipt.manifest.chunks) {
          chunkPins[c.index] = file(a, b, chunkName(c.index), c.bytes, chunkPins[c.index], scratch, c.hash);
          yield scratch.subarray(0, c.bytes);
        }
      }
      const result = verifyReassembly(receipt.manifest, chunks());
      // A later chunk read must not hide drift in an earlier chunk's completed snapshot.
      for (const c of receipt.manifest.chunks) {
        b.check(); const fd = custodyOps.open(a.fd, chunkName(c.index), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK | closeOnExec);
        try { const s = fs.fstatSync(fd, { bigint: true }); privateStat(s); if (stamp(s) !== chunkPins[c.index]) fail(); }
        finally { quiet(() => fs.closeSync(fd)); }
      }
      return result;
    });
    whole(); // Never expose a handle after a partial join, including the explicit empty-source case.
    const m = receipt!.manifest;
    const summary = Object.freeze({ sourceRevision: m.sourceRevision, acquisitionId: m.acquisitionId, receiptHash: p.receiptHash,
      custodyMachine: m.custodyMachine, method: m.method, observedAt: m.observedAt,
      manifestHash: p.manifestHash, authorityHash: p.authorityHash, wholeHash: m.wholeHash, wholeBytes: m.wholeBytes, chunkCount: m.chunkCount,
      chunks: Object.freeze(m.chunks.map(({ index, offset, bytes, hash }) => Object.freeze({ index, offset, bytes, hash }))), sourceComplete: false as const });
    return Object.freeze({ summary, verifyWhole: whole,
      /** Declared parent document: exact final receipt bytes including LF, never an original-source row. */
      readManifest(): RawDocument {
        return run(false, (a, b) => {
          const bytes = Buffer.alloc(p.manifestBytes);
          file(a, b, 'manifest.json', p.manifestBytes, JSON.stringify(p.manifestStat), bytes, p.manifestHash);
          return { bytes, originalHash: p.manifestHash, originalBytes: p.manifestBytes, custodyMachine: m.custodyMachine,
            sourceLocator: `history-file-chunks-manifest-v1:${m.sourceRevision}`, format: 'history-file-chunks-manifest-v1', formatVersion: '1',
            acquisition: { method: m.method, observedAt: m.observedAt, receiptHash: p.receiptHash } };
        });
      },
      readChunk(index: number): RawDocument {
        if (!number(index, m.chunkCount - 1)) fail();
        return run(false, (a, b) => {
          const c = m.chunks[index], bytes = Buffer.alloc(c.bytes);
          file(a, b, chunkName(index), c.bytes, chunkPins[index], bytes, c.hash);
          // Same mapping as chunkDocument; avoid its extra payload copy. Reader retains no returned Buffer.
          return { bytes, originalHash: c.hash, originalBytes: c.bytes, custodyMachine: m.custodyMachine,
            sourceLocator: `history-file-chunks-v1:${m.sourceRevision}:${index}`, format: 'history-file-chunks-v1', formatVersion: '1',
            acquisition: { method: m.method, observedAt: m.observedAt, receiptHash: p.receiptHash } };
        });
      } });
  } catch { return fail(); }
}
