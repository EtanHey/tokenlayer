import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { encodeRow, RAW_BYTES } from '../lib/clickhouse';
import { cloneRawClient, type RawClient } from './client';
import { diskVerdict } from '../archaeology/disk-plan';

export const MAX_DOCUMENT_BYTES = 16 * 1024 ** 2;
export const MAX_WIRE_BYTES = 8 * 1024 ** 2;
const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const hash = (value: string) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const schema = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
const columns = [...schema.matchAll(/^    (\w+) (String|UInt64|UInt8),?$/gm)].map(m => ({ name: m[1], type: m[2] }));

export type RawDocument = {
  bytes: Buffer; originalHash: string; originalBytes: number;
  custodyMachine: string; sourceLocator: string; format: string; formatVersion: string;
  acquisition: { method: string; observedAt: string; receiptHash: string };
};
function text(value: string, cap: number) {
  if (typeof value !== 'string' || !value.length || Buffer.byteLength(value) > cap ||
    Buffer.from(value).toString('utf8') !== value || /[\x00-\x1f\x7f]/.test(value)) throw Error('DOCUMENT_METADATA_INVALID');
  return value;
}

/** Complete, pinned buffers only. No filesystem reader, DDL executor, retry or runtime entry point. */
export class RawDocumentStore {
  private readonly ch: RawClient;
  #policy: 'manual' | 'streaming';
  #inFlight = false;
  constructor(ch: RawClient, policy: 'manual' | 'streaming' = 'manual') {
    if (policy !== 'manual' && policy !== 'streaming') throw Error('ADMISSION_POLICY_INVALID');
    this.#policy = policy;
    if (!/^[a-zA-Z_][a-zA-Z_0-9]*$/.test(ch.config.database)) throw Error('DATABASE_IDENTIFIER_INVALID');
    this.ch = cloneRawClient(ch);
  }

  /** Returns only after synchronous CH acknowledgement; replay identity never depends on the local clock. */
  async put(input: RawDocument, signal?: AbortSignal) {
    if (this.#inFlight) throw Error('PUT_IN_FLIGHT');
    this.#inFlight = true;
    try { return await this.write(input, signal); } finally { this.#inFlight = false; }
  }
  private async write(input: RawDocument, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (!Buffer.isBuffer(input.bytes) || input.bytes.length > MAX_DOCUMENT_BYTES) throw Error('DOCUMENT_CAP');
    const bytes = Buffer.from(input.bytes); // Own the snapshot before the first asynchronous boundary.
    if (!hash(input.originalHash) || !Number.isSafeInteger(input.originalBytes) ||
      bytes.length !== input.originalBytes || sha(bytes) !== input.originalHash) throw Error('DOCUMENT_PIN_MISMATCH');
    const custody = text(input.custodyMachine, 128), locator = text(input.sourceLocator, 16384);
    const format = text(input.format, 128), version = text(input.formatVersion, 128);
    const method = text(input.acquisition.method, 256), observed = text(input.acquisition.observedAt, 24);
    const receipt = input.acquisition.receiptHash;
    if (!hash(receipt) || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(observed) ||
      !Number.isFinite(Date.parse(observed)) || new Date(observed).toISOString() !== observed) throw Error('ACQUISITION_INVALID');
    // JSON arrays, fixed positions, UTF-8, no LF, lowercase SHA256. No ambiguous delimiter concatenation.
    const revisionId = sha(JSON.stringify(['raw-document-revision-v1', custody, locator, format, version,
      input.originalHash, bytes.length]));
    const acquisitionId = sha(JSON.stringify(['raw-document-acquisition-v1', revisionId, method, observed, receipt]));
    const row = { contract_version: 1, revision_id: revisionId, acquisition_id: acquisitionId,
      custody_machine: custody, source_locator: locator, origin_machine: 'UNKNOWN', original_path: 'UNKNOWN',
      origin_proof: 'UNKNOWN', format, format_version: version, historical_writer_version: 'UNKNOWN',
      original_hash: input.originalHash, original_bytes: bytes.length, acquisition_method: method,
      observed_at: observed, acquisition_receipt_hash: receipt, raw: '', [RAW_BYTES]: bytes };
    const wireBytes = encodeRow(row).length + 1; // Includes JSONEachRow transport LF, never part of raw.
    if (wireBytes > MAX_WIRE_BYTES) throw Error('WIRE_CAP');
    const database = this.ch.config.database;
    const tables = await this.ch.queryJSON<{ engine: string; sorting_key: string; storage_policy: string }>(
      `SELECT engine, sorting_key, storage_policy FROM system.tables WHERE database='${database}' AND name='raw_documents'`, signal);
    const actual = await this.ch.queryJSON<{ name: string; type: string }>(
      `SELECT name, type FROM system.columns WHERE database='${database}' AND table='raw_documents'`, signal);
    if (tables.length !== 1 || tables[0].engine !== 'ReplacingMergeTree' || tables[0].storage_policy !== 'default' || tables[0].sorting_key !== 'revision_id, acquisition_id' ||
      actual.length !== columns.length || columns.some(c => !actual.some(a => a.name === c.name && a.type === c.type)))
      throw Error('SCHEMA_MISMATCH');
    const disks = await this.ch.queryJSON<{ name: string; free_space: string; unreserved_space: string; keep_free_space: string }>(
      "SELECT name, toString(free_space) AS free_space, toString(unreserved_space) AS unreserved_space, toString(keep_free_space) AS keep_free_space FROM system.disks", signal);
    const disk = disks[0];
    const valid = (v: unknown) => typeof v === 'string' && /^(0|[1-9]\d*)$/.test(v) && Number.isSafeInteger(Number(v));
    if (disks.length !== 1 || !disk || disk.name !== 'default' ||
      ![disk.free_space, disk.unreserved_space, disk.keep_free_space].every(valid)) throw Error('SPACE_UNKNOWN');
    const free = Number(disk.free_space), usable = Number(disk.unreserved_space), reserve = Number(disk.keep_free_space);
    if (free === 0 || usable === 0 || usable > free) throw Error('SPACE_REFUSED');
    if (this.#policy === 'streaming') {
      // Both reported free and unreserved already exclude reserve. Never add it to dispatch headroom.
      if (reserve < 15 * 1024 ** 3 || usable < 2 * 1024 ** 3 + 384 * 1024 ** 2 + 5 * wireBytes) throw Error('SPACE_REFUSED');
    } else {
      const temporary = 2 * wireBytes, budget = temporary + Math.ceil(temporary / 4) + 14 * 1024 ** 3;
      // Restore reserve ONLY for the old manual physical-floor accounting; never for its write budget.
      if (!Number.isSafeInteger(free + reserve) || usable < budget ||
        diskVerdict(temporary, free + reserve).verdict !== 'PASS') throw Error('SPACE_REFUSED');
    }
    signal?.throwIfAborted();
    try { await this.ch.insert('raw_documents', [row], acquisitionId, signal); }
    catch { throw Error('ACK_UNKNOWN: replay the same pinned acquisition; no checkpoint or retry performed'); }
    return { revisionId, acquisitionId, status: 'ACKNOWLEDGED' as const };
  }
}
