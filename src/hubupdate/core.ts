export type Connection = { key: string; peer: string; rx: number; tx: number };
export type Point = Connection & { ignored: boolean };
export type Idle = { verdict: "idle" | "busy" | "busy_unknown"; seen: number; ignored: number; changed: number; unattributed: number; reason: string };
export const blindSpots = ["A stream silent for the entire window looks idle.", "Arrivals after the final sample are unseen.", "Connections starting and ending between samples can be missed."];
const fail = () => { throw Error("parse_failure"); };
const endpoint = (s: string) => s.replace(/[\[\]]/g, "").replace(/\.(\d+)$/, ":$1");
const counter = (s: string) => /^\d+$/.test(s) && Number.isSafeInteger(+s) ? +s : fail();
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export function parseNettop(text: string, pid?: number, name = "cliproxyapi", port = 8317): Connection[] {
  const lines = text.trim().split("\n"), out: Connection[] = []; let listener = false;
  const columns = lines.shift(), process = new RegExp(`^${escape(name)}\\.(\\d+),\\d+,\\d+,$`).exec(lines.shift() ?? "");
  const local = new RegExp(`[.:]${port}$`);
  if (columns !== ",bytes_in,bytes_out," || !process || (pid !== undefined && +process[1] !== pid)) fail();
  for (const line of lines) {
    const m = /^tcp[46] (\S+)<->(\S+),([^,]*),([^,]*),$/.exec(line.trim()); if (!m) fail();
    const [, own, peer, input, output] = m!;
    if (peer === "*:*") { if (!local.test(own) || input || output) fail(); listener = true; continue; }
    const rx = counter(input), tx = counter(output);
    if (local.test(own)) out.push({ key: endpoint(own) + "<->" + endpoint(peer), peer: endpoint(peer), rx, tx });
  }
  if (!listener || new Set(out.map(c => c.key)).size !== out.length) fail();
  return out;
}
export function owners(text: string, hub: number, port = 8317): Map<string, number> {
  let pid = 0; const result = new Map<string, number>();
  for (const line of text.trim().split("\n")) {
    if (/^p\d+$/.test(line)) pid = +line.slice(1);
    else if (/^f\S+$/.test(line)) continue;
    else if (line.startsWith("n") && pid) {
      const pair = line.slice(1).split("->"); if (pair.length !== 2) fail();
      if (pid !== hub && pair[1].endsWith(`:${port}`)) {
        const key = endpoint(pair[0]); if (result.has(key) && result.get(key) !== pid) fail(); result.set(key, pid);
      }
    } else fail();
  }
  return result;
}
export function sidecars(text: string): Set<number> {
  const lines = text.trim().split("\n"), pids = new Set<number>();
  if (lines.shift() !== "PID\tStatus\tLabel") fail();
  for (const line of lines) {
    const m = /^(\d+|-)\s+-?\d+\s+(\S+)$/.exec(line); if (!m) fail();
    if (/^com\.tokenlayer\.(drain|fable|ship|steer|usage|dashboard)$/.test(m![2]) && m![1] !== "-") pids.add(+m![1]);
  }
  return pids;
}
export function idle(samples: Point[][]): Idle {
  if (!samples.length) return { verdict: "busy_unknown", seen: 0, ignored: 0, changed: 0, unattributed: 0, reason: "no_samples" };
  const seen = new Set<string>(), ignored = new Set<string>(), changed = new Set<string>();
  const first = new Map(samples[0]?.filter(c => !c.ignored).map(c => [c.key, c]));
  for (const sample of samples) {
    const current = new Map(sample.filter(c => !c.ignored).map(c => [c.key, c]));
    for (const c of sample) { seen.add(c.key); if (c.ignored) ignored.add(c.key); }
    for (const [key, c] of current) { const a = first.get(key); if (!a || a.rx !== c.rx || a.tx !== c.tx) changed.add(key); }
    for (const key of first.keys()) if (!current.has(key)) changed.add(key);
  }
  return { verdict: changed.size ? "busy" : "idle", seen: seen.size, ignored: ignored.size, changed: changed.size, unattributed: 0, reason: changed.size ? "client_activity" : "counters_unchanged" };
}
export const versionPattern = /^\d+(?:\.\d+){1,3}(?:_\d+)?$/;
export function versions(text: string, formula = "cliproxyapi") {
  const f = JSON.parse(text).formulae?.[0];
  const installed = f?.linked_keg, available = f?.versions?.stable + (f?.revision ? "_" + f.revision : "");
  const kegs: unknown[] = Array.isArray(f?.installed) ? f.installed.map((k: { version?: unknown }) => k?.version) : [];
  if (f?.name !== formula || ![installed, available, ...kegs].every(s => typeof s === "string" && versionPattern.test(s))) fail();
  const a = available.split(/[._]/).map(Number), b = installed.split(/[._]/).map(Number);
  const delta = Array.from({ length: Math.max(a.length, b.length) }, (_, i) => (a[i] ?? 0) - (b[i] ?? 0)).find(n => n !== 0) ?? 0;
  return { installed: installed as string, available: available as string, newer: delta > 0, kegs: kegs as string[] };
}
/** Linked keg (null when nothing is linked) and installed kegs; used where a half-finished upgrade may have unlinked everything. */
export function kegState(text: string, formula: string) {
  const f = JSON.parse(text).formulae?.[0], linked = f?.linked_keg ?? null;
  const kegs: unknown[] = Array.isArray(f?.installed) ? f.installed.map((k: { version?: unknown }) => k?.version) : [fail()];
  if (f?.name !== formula || (linked !== null && !(typeof linked === "string" && versionPattern.test(linked))) || !kegs.every(s => typeof s === "string" && versionPattern.test(s))) fail();
  return { linked: linked as string | null, kegs: kegs as string[] };
}
