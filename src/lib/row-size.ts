import { RAW_BYTES } from './clickhouse';
export const MAX_SERIALIZED_BATCH_BYTES = 128 * 1024 ** 2;
/** Exact JSON UTF-8 size for the shipper's scalar row fields, without a large stringify. */
function stringBytes(value: string) {
  let bytes = Buffer.byteLength(value) + 2;
  for (const match of value.matchAll(/[\x00-\x1f"\\\ud800-\udfff]/gu)) {
    const c = match[0].charCodeAt(0);
    bytes += c >= 0xd800 ? 3 : c === 34 || c === 92 || [8, 9, 10, 12, 13].includes(c) ? 1 : 5;
  }
  return bytes;
}
export function rowBytes(row: unknown, exactRaw = false) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) throw Error('non-object ship row');
  const raw = (row as { [RAW_BYTES]?: Buffer })[RAW_BYTES];
  let bytes = 2, count = 0;
  for (const [key, value] of Object.entries(row)) {
    if (value === undefined) continue;
    bytes += (count++ ? 1 : 0) + stringBytes(key) + 1;
    if (key === 'raw' && exactRaw && raw) {
      bytes += raw.length + 2;
      for (const c of raw) bytes += c === 34 || c === 92 || [9, 10, 13].includes(c) ? 1 : c < 32 ? 5 : 0;
    } else if (typeof value === 'string') bytes += stringBytes(value);
    else if (value === null || typeof value === 'number' || typeof value === 'boolean') bytes += JSON.stringify(value).length;
    else throw Error('non-scalar ship row field');
  }
  return bytes;
}
export function boundedRowsBytes(rows: readonly unknown[], limit = MAX_SERIALIZED_BATCH_BYTES, exactRaw = false) {
  let bytes = exactRaw ? 0 : 2;
  for (let i = 0; i < rows.length; i++) {
    bytes += rowBytes(rows[i], exactRaw) + (exactRaw || i ? 1 : 0);
    if (bytes > limit) throw Error(exactRaw ? 'history payload cap exceeded' : 'history batch exceeds serialization bound');
  }
  return bytes;
}
