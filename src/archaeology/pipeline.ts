import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import { newFileState, parseLine, detectHarness, type ParsedLine } from "../ship/parse";

export type Inventory = Record<"machine" | "source_kind" | "container" | "member_path" | "session_id" | "harness" | "bytes" | "lines" | "first_ts" | "last_ts" | "cwd" | "sha256" | "mtime", string>;
export type Evidence = { cwd: string; repo: string; evidence: string; confidence: "high" | "medium"; machine?: string; valid_from?: string; valid_to?: string };
export type RepoMap = { machine: string; cwd: string; repo_canonical: string; valid_from: string; valid_to: string; evidence: string[]; confidence: string };
export type Entry = Inventory & { origin: string; repo: string; selected: boolean; relation: string; status: string; container_hash: string };
export type Event = ParsedLine & { machine: string; harness: string; path: string; generation: string; byte_offset: number; content_hash: string; line_bytes: number };
type Chunks = AsyncIterable<Uint8Array>;
export const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const hashOK = (hash: string) => /^[a-f0-9]{64}$/.test(hash);
const synthetic = /(?:^|\/)(?:tests?|fixtures?(?:-raw)?|testdata|__fixtures__|benchmarks?|evals?|eval-gates[^/]*|corpus[^/]*|synthetic[^/]*|node_modules|registry|telemetry|[^/]*benchmark[^/]*|[^/]*fixtures[^/]*)(?:\/|$)|\/(?:\.vl[^/]*|\.vd[^/]*|\.tmp-[^/]*|brainlayer-live-verify)\//i;

export function classify(r: Inventory): { session: boolean; reason: string } {
  const path = `${r.container}/${r.member_path}`.replace(/(^|\/)-Users-[^/]+(?=\/|$)/g, "$1project");
  if (/\/(?:\.cursor|\.gemini|\.antigravity)\//.test(path)) return { session: false, reason: "outside Claude/Codex/T3 scope" };
  if (synthetic.test(path)) return { session: false, reason: "fixture/eval/benchmark/registry/telemetry path" };
  if (Number(r.bytes) === 40 && /\.tgz$/.test(r.member_path)) return { session: false, reason: "40-byte placeholder" };
  if (r.source_kind === "t3_sqlite" && r.harness === "t3") return { session: true, reason: "T3 metadata; transcript export required" };
  if (!/\.jsonl(?:\.zst)?$/.test(r.member_path)) return { session: false, reason: "not session JSONL" };
  if (!["claude", "codex", "t3"].includes(r.harness) || !r.session_id) return { session: false, reason: "no session identity/harness evidence" };
  return { session: true, reason: `${r.harness} session identity from inventory` };
}

export function origin(r: Inventory): string {
  const evidence = r.cwd || r.member_path;
  if (/(?:\/Users\/|-Users-)etanheyman(?:\/|-|$)/.test(evidence)) return "m4";
  if (/(?:\/Users\/|-Users-)happycampr(?:\/|-|$)/.test(evidence)) return "m1";
  return /^(m1|m4)$/i.test(r.machine) ? r.machine.toLowerCase() : "unknown";
}

export function repoMap(rows: Inventory[], evidence: Evidence[]): RepoMap[] {
  const groups = new Map<string, Inventory[]>();
  for (const r of rows) { const key = `${origin(r)}\0${r.cwd}`; const group = groups.get(key) ?? []; group.push(r); groups.set(key, group); }
  return [...groups.values()].map(group => {
    const r = group[0], machine = origin(r);
    const matches = evidence.filter(e => e.cwd === r.cwd && (!e.machine || e.machine === machine));
    const repos = new Set(matches.map(e => e.repo));
    const times = group.flatMap(x => [x.first_ts, x.last_ts]).filter(x => Number.isFinite(Date.parse(x))).sort((a, b) => Date.parse(a) - Date.parse(b));
    return { machine, cwd: r.cwd, repo_canonical: repos.size === 1 ? matches[0].repo : "", valid_from: times[0] ?? "", valid_to: times.length ? new Date(Date.parse(times.at(-1)!) + 1).toISOString() : "", evidence: matches.map(e => e.evidence), confidence: repos.size === 1 ? matches.every(e => e.confidence === "high") ? "high" : "medium" : "unresolved" };
  });
}

/** Mirrors ship.ts listJsonl: plain JSONL in configured/default Claude or Codex trees. */
export function shipperCovers(path: string, roots?: readonly string[]): boolean {
  if (!path.endsWith(".jsonl")) return false;
  const under = (root: string) => path.startsWith(root.replace(/\/$/, "") + "/");
  if (roots) return roots.some(under);
  return (process.env.TOKENLAYER_CLAUDE_DIR ? under(process.env.TOKENLAYER_CLAUDE_DIR) : /\/\.claude\/projects\//.test(path))
    || (process.env.TOKENLAYER_CODEX_DIR ? under(process.env.TOKENLAYER_CODEX_DIR) : /\/\.codex\/sessions\//.test(path));
}

export function manifest(rows: Inventory[], maps: RepoMap[]): Entry[] {
  const repos = new Map(maps.map(m => [`${m.machine}\0${m.cwd}`, m.repo_canonical]));
  const copies = new Map<string, Entry>();
  for (const r of rows.filter(r => classify(r).session)) {
    const key = JSON.stringify([r.machine, r.source_kind, r.container, r.member_path, r.sha256]);
    copies.set(key, { ...r, source_kind: r.source_kind === "live" && !shipperCovers(r.member_path) ? "archive_dir" : r.source_kind, origin: origin(r), repo: repos.get(`${origin(r)}\0${r.cwd}`) ?? "", selected: false, relation: "unverified", status: "pending", container_hash: "" });
  }
  const entries = [...copies.values()].sort((a, b) => Number(b.bytes) - Number(a.bytes) || a.member_path.localeCompare(b.member_path));
  const largest = new Map<string, Entry>();
  for (const e of entries) {
    const canonical = largest.get(e.session_id);
    if (!canonical) { largest.set(e.session_id, e); e.selected = true; }
    if (canonical && hashOK(e.sha256) && canonical.sha256 === e.sha256) e.relation = "identical";
  }
  return entries;
}

/** No shared client accepted. Sources are replayable read-only streams; null means needs fetch/export. */
export async function dryRun(entries: Entry[], options: {
  read: (entry: Entry) => Promise<Chunks | null>;
  database?: string; sampleSize?: number; order?: AsyncIterable<Entry>; existing?: Iterable<[string, string]>;
  onEntry?: (entry: Entry) => void;
}) {
  const db = new Database(options.database ?? ":memory:");
  db.exec("CREATE TABLE IF NOT EXISTS seen(session TEXT, hash TEXT, live INTEGER, PRIMARY KEY(session,hash)) WITHOUT ROWID; DELETE FROM seen");
  const insert = db.query("INSERT OR IGNORE INTO seen VALUES(?,?,?)");
  const find = db.query<{ live: number }, [string, string]>("SELECT live FROM seen WHERE session=? AND hash=?");
  const report = { import_rows: 0, import_bytes: 0, import_sessions: 0, skip_live: 0, skip_copy: 0, live_rows: 0, needs_fetch: 0, source_changed: 0, read_errors: 0, divergent_sessions: 0, unterminated_bytes: 0, sample: [] as Event[], groups: {} as Record<string, { rows: number; bytes: number; skip_live: number; skip_copy: number }> };
  const sessions = new Set<string>(), divergent = new Set<string>();
  const prefixes = new Map<string, Map<number, string>>();
  const lengths = new Map<string, number[]>();
  for (const e of entries) lengths.set(e.session_id, [...new Set([...(lengths.get(e.session_id) ?? []), Number(e.bytes)])].sort((a, b) => a - b));
  const ordered = [...entries].sort((a, b) => Number(b.source_kind === "live") - Number(a.source_kind === "live") || Number(b.bytes) - Number(a.bytes));
  try {
    for (const [session, hash] of options.existing ?? []) { if (!hashOK(hash)) throw new Error("invalid existing content hash"); insert.run(session, hash, 1); }
    for await (const e of options.order ?? ordered) {
      try {
      const source = e.origin === "unknown" || e.source_kind === "t3_sqlite" ? null : await options.read(e);
      if (!source) { e.status = "needs_fetch_or_export"; report.needs_fetch++; options.onEntry?.(e); continue; }
      const digest = createHash("sha256"), checkpoints = new Map<number, string>();
      let size = 0, checkpointIndex = 0; const boundaries = lengths.get(e.session_id) ?? [];
      for await (const chunk of source) {
        let start = 0;
        while (checkpointIndex < boundaries.length && boundaries[checkpointIndex] <= size + chunk.length) {
          const boundary = boundaries[checkpointIndex++];
          if (boundary > size) {
            digest.update(chunk.subarray(start, boundary - size)); start = boundary - size;
            checkpoints.set(boundary, digest.copy().digest("hex"));
          }
        }
        digest.update(chunk.subarray(start)); size += chunk.length;
      }
      const fullHash = digest.digest("hex");
      if ((hashOK(e.sha256) && e.sha256 !== fullHash) || (e.bytes && Number(e.bytes) !== size)) {
        e.status = "source_changed"; report.source_changed++; options.onEntry?.(e); continue;
      }
      e.sha256 = fullHash; e.bytes = String(size);
      const known = prefixes.get(e.session_id);
      if (known?.get(size) === fullHash) e.relation = "prefix";
      else if (known && checkpoints.get(Math.max(...known.keys())) === known.get(Math.max(...known.keys()))) {
        e.relation = "canonical_verified";
        for (const prior of entries.filter(p => p.session_id === e.session_id && p.status === "verified")) if (checkpoints.get(Number(prior.bytes)) === prior.sha256) { prior.relation = "prefix"; prior.selected = false; }
      }
      else if (known) { e.relation = "divergent"; divergent.add(e.session_id); e.selected = true; }
      else { e.relation = "canonical_verified"; }
      if (!known || size > Math.max(...known.keys())) prefixes.set(e.session_id, checkpoints);
      const again = await options.read(e);
      if (!again) throw new Error("source disappeared between verification and reading");
      const st = newFileState(e.harness === "codex" || /rollout-/.test(e.member_path) ? "codex" : "claude", e.harness === "t3" ? "t3" : e.harness === "codex" ? "codex" : "claude", Date.parse(e.first_ts) || 0);
      st.sessionId = e.session_id; st.cwd = e.cwd;
      let offset = 0, carry = Buffer.alloc(0), rows = 0, bytes = 0, skipLive = 0, skipCopy = 0, liveRows = 0;
      const sample: Event[] = [], secondHash = createHash("sha256");
      db.exec("BEGIN");
      try {
        for await (const chunk of again) {
          secondHash.update(chunk); carry = Buffer.concat([carry, chunk]);
          let start = 0, nl: number;
          while ((nl = carry.indexOf(10, start)) >= 0) {
            const line = carry.subarray(start, nl + 1), hash = sha256(line);
            const raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(line);
            st.harness = detectHarness(st.kind, [raw]) ?? st.harness; e.harness = st.harness;
            const parsed = parseLine(raw, st), existing = find.get(e.session_id, hash);
            if (e.source_kind === "live") { insert.run(e.session_id, hash, 1); liveRows++; }
            else if (existing) { if (existing.live) skipLive++; else skipCopy++; }
            else {
              insert.run(e.session_id, hash, 0); rows++; bytes += line.length;
              if (sample.length < (options.sampleSize ?? 100)) sample.push({ ...parsed, session_id: e.session_id, raw, project: e.repo || parsed.project, machine: e.origin, harness: st.harness, path: `archive://${e.container_hash || fullHash}/${e.member_path}`, generation: `archive:${fullHash}`, byte_offset: offset, content_hash: hash, line_bytes: line.length });
            }
            offset += line.length; start = nl + 1;
          }
          carry = Buffer.from(carry.subarray(start));
        }
        if (secondHash.digest("hex") !== fullHash) throw new Error("source changed during second read");
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
      e.status = "verified"; report.import_rows += rows; report.import_bytes += bytes; report.skip_live += skipLive; report.skip_copy += skipCopy; report.live_rows += liveRows; report.unterminated_bytes += carry.length;
      if (rows) sessions.add(e.session_id);
      report.sample.push(...sample.slice(0, Math.max(0, (options.sampleSize ?? 100) - report.sample.length)));
      const key = [e.origin, e.harness, e.repo || "unresolved"].join("\t"), group = report.groups[key] ?? { rows: 0, bytes: 0, skip_live: 0, skip_copy: 0 };
      group.rows += rows; group.bytes += bytes; group.skip_live += skipLive; group.skip_copy += skipCopy; report.groups[key] = group;
      options.onEntry?.(e);
      } catch { e.status = "read_error"; report.read_errors++; options.onEntry?.(e); }
    }
    report.import_sessions = sessions.size; report.divergent_sessions = divergent.size;
    return report;
  } finally { db.close(); }
}
