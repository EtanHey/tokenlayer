import * as fs from 'node:fs';
import { dirname, basename, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { custodyOps, directoryFlags, closeOnExec, atCwd } from '../metadata/private-fs';
import { guardGit } from '../metadata/gemini-output';
import { FLOOR_BYTES, PENDING_BYTES } from '../metadata/output';
import { encodeRow, RAW_BYTES } from '../lib/clickhouse';
import type { RawClient } from '../raw-document/client';
import { RawDocumentStore, MAX_WIRE_BYTES, type RawDocument } from '../raw-document/storage';
import { importAcquisition, type ImportAuthority } from './imported';
import { statPin } from './acquire';

export type WriterPins = { scopeHash: string; ownerHash: string; windowHash: string; epochHash: string; schemaHash: string; configHash: string };
type Bound = Readonly<WriterPins & { bindingHash: string }>;
/** Trusted external authentication/current-window + whole-source/state admission, not a hash-based lease. */
export type CurrentAdmission = (phase: 'PREPARE' | 'LOCAL' | 'DISPATCH' | 'FINISH', bound: Bound,
  charge: Readonly<{ localBytes: number; wireBytes: number }>) => Promise<{ admitted: true; bindingHash: string }>;
const sha = (v: Buffer | string) => createHash('sha256').update(v).digest('hex');
const hash = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const fail = (): never => { throw Error('DURABLE_ACQUISITION_REFUSED'); };
const quiet = (fn: () => void) => { try { fn(); } catch {} };
const json = (v: unknown) => JSON.stringify(v) + '\n';
export function describe(d: RawDocument, index: number, offset: number | null) {
  if (d.bytes.length !== d.originalBytes || sha(d.bytes) !== d.originalHash) fail();
  const revisionId = sha(JSON.stringify(['raw-document-revision-v1', d.custodyMachine, d.sourceLocator, d.format, d.formatVersion, d.originalHash, d.originalBytes]));
  const acquisitionId = sha(JSON.stringify(['raw-document-acquisition-v1', revisionId, d.acquisition.method, d.acquisition.observedAt, d.acquisition.receiptHash]));
  const row = { contract_version: 1, revision_id: revisionId, acquisition_id: acquisitionId, custody_machine: d.custodyMachine, source_locator: d.sourceLocator,
    origin_machine: 'UNKNOWN', original_path: 'UNKNOWN', origin_proof: 'UNKNOWN', format: d.format, format_version: d.formatVersion,
    historical_writer_version: 'UNKNOWN', original_hash: d.originalHash, original_bytes: d.originalBytes, acquisition_method: d.acquisition.method,
    observed_at: d.acquisition.observedAt, acquisition_receipt_hash: d.acquisition.receiptHash, raw: '', [RAW_BYTES]: d.bytes };
  const wireBytes = encodeRow(row).length + 1; if (wireBytes > MAX_WIRE_BYTES) fail();
  const { bytes: _, ...metadata } = d;
  return { role: index < 0 ? 'manifest' : 'chunk', index, offset, ...metadata, revisionId, acquisitionId, wireBytes };
}
/** Fresh private namespace only. Existing/partial ledgers NEVER replay or dispatch. */
class Ledger {
  chain: { fd: number; name: string; id: string }[] = [];
  records = new Map<string, string>();
  created = false;
  get fd() { return this.chain.at(-1)!.fd; }
  constructor(readonly path: string, public remaining: number, readonly gate: CurrentAdmission, readonly bound: Bound) {
    try {
      if (typeof path !== 'string' || resolve(path) !== path || path === '/' || path.length > 4096 ||
        fs.realpathSync(dirname(path)) !== dirname(path) || dirname(path).split('/').filter(Boolean).length > 126) fail();
      this.add(atCwd(), '/'); for (const name of dirname(path).split('/').filter(Boolean)) this.add(this.fd, name);
      this.assert(); guardGit(path);
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
    if (this.created) {
      const s = fs.fstatSync(this.fd); if (!s.isDirectory() || s.uid !== process.getuid!() || (s.mode & 0o7777) !== 0o700) fail();
    }
  }
  room() {
    this.assert(); this.confirm(); const free = custodyOps.free(this.fd), need = FLOOR_BYTES + PENDING_BYTES + this.remaining;
    if (!Number.isSafeInteger(free) || free < 0 || free < need || !Number.isSafeInteger(need)) fail();
  }
  confirm(all = false) {
    const names = [...this.records.keys()], selected = all ? names : [...new Set([names[0], names.at(-1)])].filter((n): n is string => n !== undefined);
    for (const name of selected) {
      const fd = custodyOps.open(this.fd, name, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK | closeOnExec);
      try {
        const s = fs.fstatSync(fd, { bigint: true });
        if (!s.isFile() || s.nlink !== 1n || s.uid !== BigInt(process.getuid!()) || (s.mode & 0o7777n) !== 0o600n || JSON.stringify(statPin(s)) !== this.records.get(name)) fail();
      } finally { quiet(() => fs.closeSync(fd)); }
    }
  }
  async admit() {
    const r = await this.gate('LOCAL', this.bound, Object.freeze({ localBytes: this.remaining, wireBytes: 0 }));
    if (r?.admitted !== true || r.bindingHash !== this.bound.bindingHash) fail(); this.room();
  }
  async create() {
    await this.admit(); const parent = this.fd; custodyOps.mkdir(parent, basename(this.path));
    this.add(parent, basename(this.path)); this.created = true; this.assert(); fs.fsyncSync(parent);
  }
  async write(name: string, text: string) {
    const bytes = Buffer.from(text); if (bytes.length > 2 * 1024 ** 2 || bytes.length > this.remaining) fail();
    const start = performance.now(); let at = 0, fd: number | undefined;
    try {
      await this.admit(); fd = custodyOps.open(this.fd, name, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW | closeOnExec, 0o600);
      const privateFile = () => { const s = fs.fstatSync(fd!); if (!s.isFile() || s.nlink !== 1 || s.uid !== process.getuid!() || (s.mode & 0o7777) !== 0o600) fail(); };
      while (at < bytes.length) {
        await this.admit(); privateFile(); const elapsed = performance.now() - start; if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed >= 30_000) fail();
        const n = fs.writeSync(fd, bytes, at, bytes.length - at); if (n <= 0) fail(); at += n;
      }
      privateFile(); if (fs.fstatSync(fd).size !== bytes.length) fail(); fs.fsyncSync(fd);
      const pin = JSON.stringify(statPin(fs.fstatSync(fd, { bigint: true })));
      fs.closeSync(fd); fd = undefined; this.room(); fs.fsyncSync(this.fd); this.assert(); this.records.set(name, pin); this.remaining -= bytes.length;
    } finally { if (fd !== undefined) quiet(() => fs.closeSync(fd!)); }
  }
  close() { for (const e of this.chain.reverse()) quiet(() => fs.closeSync(e.fd)); this.chain = []; }
}
/** Callable ACK-stage core only; FINAL readback/coverage and storage completion explicitly NOT_IMPLEMENTED. */
export async function storeAcquisition(authority: ImportAuthority, writerPins: WriterPins, ledgerPath: string, ch: RawClient, current: CurrentAdmission, signal?: AbortSignal) {
  let ledger: Ledger | undefined, stage = 'REFUSED';
  try {
    const a = structuredClone(authority), p = structuredClone(writerPins), path = ledgerPath;
    if (!p || Object.keys(p).sort().join(',') !== 'configHash,epochHash,ownerHash,schemaHash,scopeHash,windowHash' || !Object.values(p).every(hash) || typeof current !== 'function') fail();
    const bound = Object.freeze({ ...p, bindingHash: sha(JSON.stringify(['history-storage-binding-v1', path, a.directory, a.directoryStat, a.manifestStat,
      a.manifestBytes, a.manifestHash, a.receiptHash, a.sourceRevision, a.acquisitionId, a.wholeHash, a.wholeBytes, a.authorityHash,
      p.scopeHash, p.ownerHash, p.windowHash, p.epochHash, p.schemaHash, p.configHash])) });
    const sink = new RawDocumentStore(ch, 'streaming');
    const gate: CurrentAdmission = async (phase, binding, charge) => {
      signal?.throwIfAborted(); const r = await current(phase, binding, charge); signal?.throwIfAborted();
      if (r?.admitted !== true || r.bindingHash !== bound.bindingHash) fail(); return r;
    };
    await gate('PREPARE', bound, Object.freeze({ localBytes: 4 * 1024 ** 2, wireBytes: 0 }));
    const reader = importAcquisition(a), s = reader.summary;
    const documents = [describe(reader.readManifest(), -1, null)];
    for (const c of s.chunks) documents.push(describe(reader.readChunk(c.index), c.index, c.offset));
    const intent = { kind: 'history-storage-intent-v1', version: 1, bound, ledgerPath: path, authority: a, source: s, documents, sourceComplete: false };
    const intentText = json(intent), intentHash = sha(intentText);
    const acks = documents.map((d, index) => json({ kind: 'history-storage-ack-v1', intentHash, index, revisionId: d.revisionId, acquisitionId: d.acquisitionId, status: 'ACKNOWLEDGED' }));
    const reserve = Buffer.byteLength(intentText) + acks.reduce((n, t) => n + Buffer.byteLength(t), 0);
    if (Buffer.byteLength(intentText) > 2 * 1024 ** 2 || reserve > 4 * 1024 ** 2) fail();
    ledger = new Ledger(path, reserve, gate, bound); await ledger.create(); await ledger.write('intent.json', intentText);
    for (let i = 0; i < documents.length; i++) {
      const expected = documents[i], doc = i === 0 ? reader.readManifest() : reader.readChunk(i - 1);
      if (JSON.stringify(describe(doc, expected.index, expected.offset)) !== JSON.stringify(expected)) fail();
      await gate('DISPATCH', bound, Object.freeze({ localBytes: ledger.remaining, wireBytes: expected.wireBytes })); ledger.room();
      stage = 'ACK_UNKNOWN'; const ack = await sink.put(doc, signal);
      if (ack.status !== 'ACKNOWLEDGED' || ack.revisionId !== expected.revisionId || ack.acquisitionId !== expected.acquisitionId) fail();
      stage = 'ACK_UNRECORDED'; await ledger.write(`ack-${String(i).padStart(6, '0')}.json`, acks[i]); stage = 'REFUSED';
    }
    await gate('FINISH', bound, Object.freeze({ localBytes: ledger.remaining, wireBytes: 0 })); reader.verifyWhole();
    await gate('FINISH', bound, Object.freeze({ localBytes: ledger.remaining, wireBytes: 0 })); reader.verifyWhole(); ledger.assert(); ledger.confirm(true);
    return { status: 'ACKS_DURABLE_COVERAGE_NOT_IMPLEMENTED' as const, intentHash, documents: documents.length, sourceComplete: false as const };
  } catch { throw Error(`DURABLE_ACQUISITION_${stage}`); }
  finally { ledger?.close(); }
}
