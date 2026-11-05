/** Importer guard only, in non-LF bytes. Unset readers keep their legacy bounds. */
export const HISTORY_DEFAULT_RECORD_BYTES = 1024 ** 2;
export const HISTORY_MAX_RECORD_BYTES = 16 * HISTORY_DEFAULT_RECORD_BYTES;
export function recordLimit(value = HISTORY_DEFAULT_RECORD_BYTES) {
  if (!Number.isSafeInteger(value) || value < 1 || value > HISTORY_MAX_RECORD_BYTES)
    throw Error('record limit must be between 1 byte and 16 MiB');
  return value;
}
/** Carries only a byte count, never record contents. CR counts toward the cap. */
export function recordGuard(max: number) {
  recordLimit(max);
  let bytes = 0;
  return (chunk: Uint8Array) => {
    for (const c of chunk) {
      bytes = c === 10 ? 0 : bytes + 1;
      if (bytes > max) throw Error(`history record exceeds ${max / HISTORY_DEFAULT_RECORD_BYTES} MiB`);
    }
  };
}
