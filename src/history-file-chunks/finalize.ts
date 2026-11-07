import * as fs from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { ClickHouse } from '../lib/clickhouse';
import { custodyOps, directoryFlags, closeOnExec, atCwd } from '../metadata/private-fs';
import { guardGit } from '../metadata/gemini-output';
import { FLOOR_BYTES, PENDING_BYTES } from '../metadata/output';
import { statPin } from './acquire';
import { importAcquisition, type ImportAuthority } from './imported';
import { describe, type WriterPins, type storeAcquisition } from './durable';
import { readFinalCoverage } from './coverage';
type Stat = ReturnType<typeof statPin>;
export type FinalizeInput = { authority: ImportAuthority; writerPins: WriterPins; ackStage: Awaited<ReturnType<typeof storeAcquisition>>;
  ledger: { path: string; stat: Stat; intentHash: string; authorityHash: string; ackStageHash: string } };
/** Must AUTHENTICATE issued completion/ACK-stage scope and current sole owner, schema/config and full allocation. */
export type FinalAdmission = (context: Readonly<WriterPins & { bindingHash: string; authorityHash: string; ackStageHash: string;
  intentHash: string; phase: 'PREPARE' | 'LOOKUP' | 'COMPLETE'; localBytes: number; wholeBytes: number }>) => Promise<{ admitted: true; bindingHash: string }>;
const sha = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const json = (v: unknown) => JSON.stringify(v) + '\n';
const fail = (): never => { throw Error('STORAGE_FINALIZE_REFUSED'); };
const hash = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const quiet = (fn: () => void) => { try { fn(); } catch {} };
const stamp = (s: fs.BigIntStats) => JSON.stringify(statPin(s));
function privateStat(s: fs.BigIntStats, dir = false) {
  if (!(dir ? s.isDirectory() : s.isFile()) || s.uid !== BigInt(process.getuid!()) || (s.mode & 0o7777n) !== (dir ? 0o700n : 0o600n) || !dir && s.nlink !== 1n) fail();
}
type RecordFile = { name: string; text: string };
class Snapshot {
  chain: { fd: number; name: string; id: string }[] = []; pins = new Map<string, string>(); dirStamp: string;
  get fd() { return this.chain.at(-1)!.fd; }
  constructor(readonly path: string, pin: Stat) {
    this.dirStamp = JSON.stringify(pin);
    try {
      if (typeof path !== 'string' || path.length > 4096 || resolve(path) !== path || fs.realpathSync(path) !== path || path.split('/').filter(Boolean).length > 127) fail();
      this.add(atCwd(), '/'); for (const name of path.split('/').filter(Boolean)) this.add(this.fd, name); this.assert();
    } catch { this.close(); fail(); }
  }
  add(parent: number, name: string) {
    const fd = custodyOps.open(parent, name, directoryFlags), e = { fd, name, id: '' }; this.chain.push(e);
    const s = fs.fstatSync(fd, { bigint: true }); e.id = `${s.dev}:${s.ino}`;
  }
  assert() {
    for (let i = 1; i < this.chain.length; i++) {
      const e = this.chain[i], fd = custodyOps.open(this.chain[i - 1].fd, e.name, directoryFlags);
      try { const s = fs.fstatSync(fd, { bigint: true }); if (`${s.dev}:${s.ino}` !== e.id) fail(); } finally { quiet(() => fs.closeSync(fd)); }
    }
    const s = fs.fstatSync(this.fd, { bigint: true }); privateStat(s, true); if (stamp(s) !== this.dirStamp) fail();
  }
  all(records: RecordFile[]) {
    const start = performance.now(); let reads = 0, charge = 0;
    const check = () => { const elapsed = performance.now() - start; if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed >= 30_000) fail(); };
    this.assert();
    for (const r of records) {
      check(); const expected = Buffer.from(r.text); if (expected.length > 2 * 1024 ** 2) fail();
      const fd = custodyOps.open(this.fd, r.name, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW | closeOnExec);
      try {
        const s = fs.fstatSync(fd, { bigint: true }); privateStat(s); const pin = stamp(s);
        if (s.size !== BigInt(expected.length) || this.pins.has(r.name) && this.pins.get(r.name) !== pin) fail();
        const bytes = Buffer.alloc(expected.length); let at = 0;
        while (at < bytes.length) { check(); charge += bytes.length - at; if (++reads > 8192 || charge > 4 * 1024 ** 2) fail();
          const n = fs.readSync(fd, bytes, at, bytes.length - at, at); if (n <= 0) fail(); at += n; }
        check(); if (++reads > 8192 || fs.readSync(fd, Buffer.alloc(1), 0, 1, bytes.length) !== 0 || !bytes.equals(expected)) fail();
        const after = fs.fstatSync(fd, { bigint: true }); privateStat(after); if (stamp(after) !== pin) fail(); this.pins.set(r.name, pin);
      } finally { quiet(() => fs.closeSync(fd)); }
    }
    const names = new Set(records.map(r => r.name)), dir = fs.opendirSync(this.path); let count = 0;
    try { for (;;) { check(); const e = dir.readSync(); if (!e) break; if (++count > 1027 || !names.delete(e.name)) fail(); } }
    finally { quiet(() => dir.closeSync()); }
    if (names.size) fail();
    for (const r of records) {
      check(); const fd = custodyOps.open(this.fd, r.name, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW | closeOnExec);
      try { const s = fs.fstatSync(fd, { bigint: true }); privateStat(s); if (stamp(s) !== this.pins.get(r.name)) fail(); }
      finally { quiet(() => fs.closeSync(fd)); }
    }
    this.assert(); check();
  }
  room(bytes: number) {
    this.assert(); const free = custodyOps.free(this.fd);
    if (!Number.isSafeInteger(free) || free < FLOOR_BYTES + PENDING_BYTES + bytes) fail();
  }
  pending(text: string) {
    const bytes = Buffer.from(text); if (bytes.length > 64 * 1024) fail(); this.room(bytes.length);
    const fd = custodyOps.open(this.fd, 'manifest.json.pending', fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW | closeOnExec, 0o600);
    let closeAttempted = false; const start = performance.now();
    try {
      this.dirStamp = stamp(fs.fstatSync(this.fd, { bigint: true })); let at = 0;
      while (at < bytes.length) {
        this.room(bytes.length - at); privateStat(fs.fstatSync(fd, { bigint: true }));
        const elapsed = performance.now() - start; if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed >= 30_000) fail();
        const n = fs.writeSync(fd, bytes, at, bytes.length - at); if (n <= 0) fail(); at += n;
      }
      fs.fsyncSync(fd); const s = fs.fstatSync(fd, { bigint: true }); privateStat(s); if (s.size !== BigInt(bytes.length)) fail();
      this.pins.set('manifest.json.pending', stamp(s)); closeAttempted = true; fs.closeSync(fd); fs.fsyncSync(this.fd);
    } finally { if (!closeAttempted) quiet(() => fs.closeSync(fd)); }
  }
  close() { for (const e of this.chain.reverse()) quiet(() => fs.closeSync(e.fd)); this.chain = []; }
}
/** No caller-supplied coverage/verified handle. Concrete fresh FINAL + complete synchronous commit protocol. */
export async function finalizeStorage(input: FinalizeInput, client: ClickHouse, current: FinalAdmission, signal?: AbortSignal) {
  let snapshot: Snapshot | undefined, committing = false;
  try {
    const c = structuredClone(input), a = c.authority, p = c.writerPins, l = c.ledger, ch = new ClickHouse({ ...client.config });
    if (typeof current !== 'function' || Object.keys(p).sort().join(',') !== 'configHash,epochHash,ownerHash,schemaHash,scopeHash,windowHash' || !Object.values(p).every(hash) ||
      !hash(l.intentHash) || !hash(l.authorityHash) || !hash(l.ackStageHash) || !ch.config.requestTimeoutMs || !ch.config.maxRequestBytes || !ch.config.maxResponseBytes) fail();
    const bindingHash = sha(json(['history-storage-finalize-v1', c]));
    const admit = async (phase: 'PREPARE' | 'LOOKUP' | 'COMPLETE') => {
      signal?.throwIfAborted(); const r = await current(Object.freeze({ ...p, bindingHash, authorityHash: l.authorityHash, ackStageHash: l.ackStageHash, intentHash: l.intentHash, phase, localBytes: 64 * 1024, wholeBytes: a.wholeBytes }));
      signal?.throwIfAborted(); if (r?.admitted !== true || r.bindingHash !== bindingHash) fail();
    };
    await admit('PREPARE');
    const reader = importAcquisition(a), s = reader.summary, documents = [describe(reader.readManifest(), -1, null)];
    for (const chunk of s.chunks) documents.push(describe(reader.readChunk(chunk.index), chunk.index, chunk.offset));
    const bound = { ...p, bindingHash: sha(JSON.stringify(['history-storage-binding-v1', l.path, a.directory, a.directoryStat, a.manifestStat, a.manifestBytes,
      a.manifestHash, a.receiptHash, a.sourceRevision, a.acquisitionId, a.wholeHash, a.wholeBytes, a.authorityHash, p.scopeHash, p.ownerHash, p.windowHash, p.epochHash, p.schemaHash, p.configHash])) };
    const intent = json({ kind: 'history-storage-intent-v1', version: 1, bound, ledgerPath: l.path, authority: a, source: s, documents, sourceComplete: false });
    if (sha(intent) !== l.intentHash || json(c.ackStage) !== json({ status: 'ACKS_DURABLE_COVERAGE_NOT_IMPLEMENTED', intentHash: l.intentHash, documents: documents.length, sourceComplete: false }) || sha(json(c.ackStage)) !== l.ackStageHash) fail();
    const records: RecordFile[] = [{ name: 'intent.json', text: intent }, ...documents.map((d, index) => ({ name: `ack-${String(index).padStart(6, '0')}.json`, text: json({ kind: 'history-storage-ack-v1', intentHash: l.intentHash, index, revisionId: d.revisionId, acquisitionId: d.acquisitionId, status: 'ACKNOWLEDGED' }) }))];
    if (records.reduce((n, r) => n + Buffer.byteLength(r.text), 0) > 4 * 1024 ** 2) fail();
    snapshot = new Snapshot(l.path, l.stat); snapshot.all(records);
    const proof = await readFinalCoverage(ch, documents, () => admit('LOOKUP'), signal);
    const completion = json({ kind: 'history-storage-completion-v1', version: 1, intentHash: l.intentHash, authorityHash: l.authorityHash, ackStageHash: l.ackStageHash,
      sourceRevision: s.sourceRevision, acquisitionId: s.acquisitionId, wholeHash: s.wholeHash, wholeBytes: s.wholeBytes, documentCount: documents.length, coverageHash: proof.evidenceHash, sourceComplete: false, storageComplete: true });
    await admit('COMPLETE'); // LAST await. Continuous exclusive owner/namespace contract still required.
    guardGit(join(l.path, 'manifest.json.pending')); guardGit(join(l.path, 'manifest.json'));
    reader.verifyWhole(); snapshot.all(records); snapshot.pending(completion);
    reader.verifyWhole(); snapshot.all([...records, { name: 'manifest.json.pending', text: completion }]); snapshot.room(0);
    committing = true; custodyOps.commit(snapshot.fd); fs.fsyncSync(snapshot.fd);
    return { status: 'STORAGE_COMPLETE' as const, completionHash: sha(completion), documents: documents.length, sourceComplete: false as const };
  } catch { throw Error(committing ? 'STORAGE_COMPLETION_COMMIT_UNKNOWN' : 'STORAGE_FINALIZE_REFUSED'); }
  finally { snapshot?.close(); }
}
