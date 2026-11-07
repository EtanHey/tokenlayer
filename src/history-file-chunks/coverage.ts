import { createHash } from 'node:crypto';
import { RawClickHouse } from '../raw-document/client';
import type { describe } from './durable';
export type ExpectedDocument = ReturnType<typeof describe>;
const fail = (): never => { throw Error('FINAL_COVERAGE_REFUSED'); };
const hash = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const sha = (v: string) => createHash('sha256').update(v).digest('hex');
/** All17 schema columns:16 exact metadata fields plus actual raw byte length/SHA256. No payload returned. */
export function expectedRow(d: ExpectedDocument) {
  return { contract_version: 1, revision_id: d.revisionId, acquisition_id: d.acquisitionId, custody_machine: d.custodyMachine, source_locator: d.sourceLocator,
    origin_machine: 'UNKNOWN', original_path: 'UNKNOWN', origin_proof: 'UNKNOWN', format: d.format, format_version: d.formatVersion, historical_writer_version: 'UNKNOWN',
    original_hash: d.originalHash, original_bytes: d.originalBytes, acquisition_method: d.acquisition.method, observed_at: d.acquisition.observedAt,
    acquisition_receipt_hash: d.acquisition.receiptHash, actual_bytes: d.originalBytes, actual_hash: d.originalHash };
}
function uint(v: unknown) {
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return v;
  if (typeof v === 'string' && /^(0|[1-9]\d*)$/.test(v) && Number.isSafeInteger(Number(v))) return Number(v);
  return fail();
}
/** Expected metadata MUST be unchanged describe() output from an authenticated safe-reader document.
 * role/index/offset/wireBytes are trusted caller annotations, not validated or certified by this lookup.
 * Evidence covers stored columns only; it grants no source-topology, authorization or completion proof. */
export async function readFinalCoverage(client: RawClickHouse, input: readonly ExpectedDocument[], authorize: () => Promise<void>, signal?: AbortSignal) {
  try {
    if (!Array.isArray(input) || !input.length || input.length > 1025) fail();
    const expected = structuredClone(input), cfg = { ...client.config };
    if (typeof authorize !== 'function' || !expected.length || expected.length > 1025 || !/^[a-zA-Z_][a-zA-Z_0-9]*$/.test(cfg.database) ||
      cfg.requestTimeoutMs === undefined || cfg.maxRequestBytes === undefined || cfg.maxResponseBytes === undefined) fail();
    const ch = new RawClickHouse({ ...cfg, requestTimeoutMs: Math.min(cfg.requestTimeoutMs!, 5000), maxRequestBytes: Math.min(cfg.maxRequestBytes!, 192 * 1024), maxResponseBytes: Math.min(cfg.maxResponseBytes!, 1024 ** 2) });
    const key = (d: ExpectedDocument) => `${d.revisionId}:${d.acquisitionId}`;
    if (expected.some(d => !hash(d.revisionId) || !hash(d.acquisitionId) || !hash(d.originalHash) || !hash(d.acquisition.receiptHash) || !Number.isSafeInteger(d.originalBytes) || d.originalBytes < 0 || d.originalBytes > 1024 ** 2) || new Set(expected.map(key)).size !== expected.length) fail();
    const proofs: string[] = [];
    for (let start = 0; start < expected.length; start += 128) {
      const batch = expected.slice(start, start + 128).sort((a, b) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
      const fields = Object.keys(expectedRow(batch[0])).map(k => k === 'actual_bytes' ? 'toString(length(raw)) AS actual_bytes' : k === 'actual_hash' ? 'lower(hex(SHA256(raw))) AS actual_hash' : k === 'original_bytes' ? 'toString(original_bytes) AS original_bytes' : k).join(',');
      const sql = `SELECT ${fields} FROM ${cfg.database}.raw_documents FINAL WHERE (revision_id,acquisition_id) IN (${batch.map(d => `('${d.revisionId}','${d.acquisitionId}')`).join(',')}) ORDER BY revision_id,acquisition_id SETTINGS readonly=2,max_threads=1,max_execution_time=3,max_memory_usage=67108864,max_result_rows=${batch.length + 1},max_result_bytes=524288,result_overflow_mode='throw'\nFORMAT JSONEachRow`;
      if (Buffer.byteLength(sql) >= 192 * 1024) fail(); await authorize(); signal?.throwIfAborted();
      const text = await ch.exec(sql, signal); if (!text.endsWith('\n')) fail();
      const lines = text.slice(0, -1).split('\n'); if (lines.length !== batch.length) fail();
      lines.forEach((line, i) => {
        const row = JSON.parse(line), wanted = expectedRow(batch[i]), names: string[] = [];
        // Tokenize complete JSON strings, counting only strings followed by a key colon.
        for (const m of line.matchAll(/"(?:\\.|[^"\\])*"/g)) if (/^\s*:/.test(line.slice(m.index! + m[0].length))) names.push(JSON.parse(m[0]));
        if (!row || Array.isArray(row) || names.length !== Object.keys(wanted).length || new Set(names).size !== names.length || Object.keys(row).sort().join() !== Object.keys(wanted).sort().join()) fail();
        for (const [k, v] of Object.entries(wanted)) if ((typeof v === 'number' ? uint(row[k]) : row[k]) !== v) fail();
        proofs.push(sha(JSON.stringify(wanted)));
      });
    }
    return { documents: expected.length, evidenceHash: sha(JSON.stringify(proofs)), sourceComplete: false as const };
  } catch { return fail(); }
}
