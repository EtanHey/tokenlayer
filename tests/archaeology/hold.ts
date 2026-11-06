import { expect } from "bun:test";
import { dryRun, type Entry } from "../../src/archaeology/pipeline";

/** Assert admission HOLD without deleting source metadata or reaching any reader.
 * This is only an assertion helper; it cannot supply origin or bypass admission.
 */
export async function expectHeld(entries: Entry[], options: Parameters<typeof dryRun>[1] = { read: async () => null }) {
  const before = entries.map(e => ({ ...e }));
  let reads = 0;
  const result = await dryRun(entries, { ...options, read: async () => { reads++; throw Error("held source must not be read"); } });
  expect(reads).toBe(0);
  expect(result).toMatchObject({ import_rows: 0, import_bytes: 0, import_sessions: 0, needs_fetch: entries.length, sample: [], groups: {} });
  entries.forEach((e, i) => {
    expect(e).toMatchObject({ ...before[i], selected: e.selected, origin: "unknown", status: "needs_fetch_or_export" });
  });
  return result;
}
