/** Non-LF bytes. History opts in explicitly; daemon entry points use the default. */
export const DEFAULT_RECORD_BYTES = 1024 ** 2;
export const HISTORY_MAX_RECORD_BYTES = 16 * DEFAULT_RECORD_BYTES;
export function recordLimit(value = DEFAULT_RECORD_BYTES) {
  if (!Number.isSafeInteger(value) || value < 1 || value > HISTORY_MAX_RECORD_BYTES)
    throw Error('record limit must be between 1 byte and 16 MiB');
  return value;
}
/** Carries only a byte count, never record contents. CR counts toward the cap. */
export function recordGuard(max = DEFAULT_RECORD_BYTES) {
  recordLimit(max);
  let bytes = 0;
  return (chunk: Uint8Array) => {
    for (const c of chunk) {
      bytes = c === 10 ? 0 : bytes + 1;
      if (bytes > max) throw Error(`history record exceeds ${max / DEFAULT_RECORD_BYTES} MiB`);
    }
  };
}
