import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import { newFileState, parseLine, detectHarness, type ParsedLine } from "../ship/parse";

export type Inventory = Record<"machine" | "source_kind" | "container" | "member_path" | "session_id" | "harness" | "bytes" | "lines" | "first_ts" | "last_ts" | "cwd" | "sha256" | "mtime", string>;
export type Evidence = { cwd: string; repo: string; evidence: string; confidence: "high" | "medium"; machine?: string; valid_from?: string | null; valid_to?: string | null };
export type RepoMap = { machine: string; cwd: string; repo_canonical: string; valid_from: string | null; valid_to: string | null; evidence: string[]; confidence: string };
export type Entry = Inventory & { origin: string; repo: string; selected: boolean; relation: string; status: string; container_hash: string; stream: string };
export type Event = ParsedLine & { machine: string; harness: string; path: string; generation: string; byte_offset: number; content_hash: string; line_bytes: number };
type Chunks = AsyncIterable<Uint8Array>;
export const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const hashOK = (hash: string) => /^[a-f0-9]{64}$/.test(hash);
const synthetic = /(?:^|\/)(?:tests?|fixtures?(?:-raw)?|testdata|__fixtures__|benchmarks?|evals?|eval-gates[^/]*|corpus[^/]*|synthetic[^/]*|node_modules|registry|telemetry|[^/]*benchmark[^/]*|[^/]*fixtures[^/]*)(?:\/|$)|\/(?:\.vl[^/]*|\.vd[^/]*|\.tmp-[^/]*|brainlayer-live-verify)\//i;

export function classify(r: Inventory): { session: boolean; reason: string } {
  const path = `${r.container}/${r.member_path}`.replace(/(^|\/)-Users-[^/]+(?=\/|$)/g, "$1project");
  if (/\/(?:\.cursor|\.gemini|\.antigravity)\//.test(path)) return { session: false, reason: "outside Claude/Codex/T3 scope" };
  if (/\/agent-transcripts\//.test(path) || /weave[^\n]*\/findings\//.test(path)) return { session: false, reason: "Cursor transcript or weave findings layout" };
  if (/\/\.system_generated\/logs(?:\/|$)|\/subagents\/workflows\/[^/]+\/findings\//.test(path)) return {session:false,reason:"Antigravity generated logs or workflow findings"};
  if (synthetic.test(path)) return { session: false, reason: "fixture/eval/benchmark/registry/telemetry path" };
  if (Number(r.bytes) === 40 && /\.tgz$/.test(r.member_path)) return { session: false, reason: "40-byte placeholder" };
  if (r.source_kind === "t3_sqlite" && r.harness === "t3") return { session: true, reason: "T3 metadata; transcript export required" };
  if (!/\.jsonl(?:\.zst)?$/.test(r.member_path)) return { session: false, reason: "not session JSONL" };
  if (!["claude", "codex", "t3"].includes(r.harness) || !r.session_id) return { session: false, reason: "no session identity/harness evidence" };
  return { session: true, reason: `${r.harness} session identity from inventory` };
}

export function origin(r: Pick<Inventory, "machine" | "cwd" | "member_path">): string {
  const evidence = r.cwd || r.member_path;
  if (/(?:\/Users\/|-Users-)etanheyman(?:\/|-|$)/.test(evidence)) return "m4";
  if (/(?:\/Users\/|-Users-)happycampr(?:\/|-|$)/.test(evidence)) return "m1";
  return /^(m1|m4)$/i.test(r.machine) ? r.machine.toLowerCase() : "unknown";
}

export function parseEvidenceLine(line: string): Evidence {
  const e: unknown = JSON.parse(line);
  if (!e || typeof e !== "object" || !("cwd" in e) || typeof e.cwd !== "string" || !("repo" in e) || typeof e.repo !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(e.repo) || !("evidence" in e) || typeof e.evidence !== "string" || !("confidence" in e) || (e.confidence !== "high" && e.confidence !== "medium")) throw Error("invalid repo evidence");
  const result: Evidence = {cwd:e.cwd,repo:e.repo,evidence:e.evidence,confidence:e.confidence};
  if ("machine" in e) { if (typeof e.machine !== "string") throw Error("invalid evidence machine"); result.machine=e.machine; }
  for (const key of ["valid_from","valid_to"] as const) if (key in e) {
    const v: unknown=Reflect.get(e,key); if (v!==null && (typeof v!=="string" || !Number.isFinite(Date.parse(v)))) throw Error("invalid evidence interval"); result[key]=v;
  }
  if (result.valid_from && result.valid_to && Date.parse(result.valid_from)>=Date.parse(result.valid_to)) throw Error("empty evidence interval");
  return result;
}

export function repoMap(rows: Inventory[], evidence: Evidence[]): RepoMap[] {
  const groups = new Map<string, Inventory[]>();
  for (const r of rows) { const key = `${origin(r)}\0${r.cwd}`; const group = groups.get(key) ?? []; group.push(r); groups.set(key, group); }
  const byCwd = new Map<string, Evidence[]>();
  for (const e of evidence) { const list=byCwd.get(e.cwd)??[];list.push(e);byCwd.set(e.cwd,list); }
  return [...groups.values()].flatMap(group => {
    const r=group[0],machine=origin(r),matches=(byCwd.get(r.cwd)??[]).filter(e=>!e.machine||e.machine.toLowerCase()===machine);
    const times=group.flatMap(x=>[x.first_ts,x.last_ts]).map(Date.parse).filter(Number.isFinite);
    const observed=times.length?times.reduce((min,ts)=>Math.min(min,ts),Infinity):-Infinity;
    const ranges=matches.map(e=>({e,from:e.valid_from===undefined?observed:e.valid_from===null?-Infinity:Date.parse(e.valid_from),to:e.valid_to?Date.parse(e.valid_to):Infinity}));
    const start=ranges.reduce((min,r)=>Math.min(min,r.from),observed);
    const cuts=[...new Set([start,Infinity,...ranges.flatMap(e=>[e.from,e.to])])].sort((a,b)=>a-b);
    return cuts.slice(0,-1).filter((from,i)=>from<cuts[i+1]).map(from=>{
      const to=cuts[cuts.indexOf(from)+1],active=ranges.filter(e=>e.from<=from&&e.to>=to).map(r=>r.e),repos=new Set(active.map(e=>e.repo));
      return {machine,cwd:r.cwd,repo_canonical:repos.size===1?active[0].repo:"",valid_from:from===-Infinity?null:new Date(from).toISOString(),valid_to:to===Infinity?null:new Date(to).toISOString(),evidence:[...new Set(active.map(e=>e.evidence))],confidence:repos.size===1?active.every(e=>e.confidence==="high")?"high":"medium":"unresolved"};
    });
  });
}

export function subagentFileId(path: string): string | null {
  return /(?:^|\/)subagents\/([^/]+)\.jsonl(?:\.zst)?$/.exec(path)?.[1]
    ?? /(?:^|\/)(agent-[^/]+)\.jsonl(?:\.zst)?$/.exec(path)?.[1] ?? null;
}
function filenameSessionId(path: string): string | null {
  return /([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\.jsonl(?:\.zst)?$/i.exec(path)?.[1] ?? null;
}
export function streamId(session: string, path: string): string {
  if (/^[^/:]+::(?:main|subagent\/[^/]+)$/.test(path)) return path;
  const agent = subagentFileId(path);
  return `${agent ? session : filenameSessionId(path) ?? session}::${agent ? `subagent/${agent}` : "main"}`;
}
/** F-1: match the installed shipper's alias-first column; dedupe uses native identity separately. */
export function codexSessionId(native: string, alias: string): string { return alias || native; }
function codexIdentity(raw: string, declared: string, path: string): {native:string;session:string} | null {
  try {
    const o: unknown=JSON.parse(raw);
    if (!o || typeof o!=="object" || !("type"in o) || o.type!=="session_meta" || !("payload"in o) || !o.payload || typeof o.payload!=="object" || !("id"in o.payload) || typeof o.payload.id!=="string" || !o.payload.id) return null;
    const native=o.payload.id;
    if(native!==declared && native!==filenameSessionId(path)) return null;
    const alias="session_id"in o.payload && typeof o.payload.session_id==="string" ? o.payload.session_id : "";
    return {native,session:codexSessionId(native,alias)};
  } catch {return null;}
}
function identityMatches(raw: string, session: string, kind: "claude" | "codex"): boolean {
  try {
    const o: unknown = JSON.parse(raw);
    if (kind === "claude") return !!o && typeof o === "object" && "sessionId" in o && o.sessionId === session;
    return !!o && typeof o === "object" && "type" in o && o.type === "session_meta" && "payload" in o
      && !!o.payload && typeof o.payload === "object" && "id" in o.payload && o.payload.id === session;
  } catch { return false; }
}
export type ExistingCount = [session: string, streamOrPath: string, hash: string, count: number];

export type MachineRoots = Readonly<Record<string, readonly string[]>>;
export const DEFAULT_SHIPPER_ROOTS: MachineRoots = {
  m4:["/Users/etanheyman/.claude/projects","/Users/etanheyman/.codex/sessions"],
  m1:["/Users/happycampr/.claude/projects","/Users/happycampr/.codex/sessions"],
};
export function parseShipperRoots(value: unknown): MachineRoots {
  if(!value || typeof value!=="object" || Array.isArray(value))throw Error("roots must map machine names to absolute directory arrays");
  const result:Record<string,string[]>={};
  for(const [machine,roots]of Object.entries(value)){
    if(!Array.isArray(roots)||!roots.every((r):r is string=>typeof r==="string"&&r.startsWith("/")))throw Error("invalid machine shipper roots");
    result[machine]=roots;
  }
  return result;
}
/** Mirrors ship.ts listJsonl using the owning machine's explicit roots, never this process's env. */
export function shipperCovers(path: string, machine: string, roots: MachineRoots = DEFAULT_SHIPPER_ROOTS): boolean {
  return path.endsWith(".jsonl") && (roots[machine]??[]).some(root=>path.startsWith(root.replace(/\/$/,"")+"/"));
}

export function manifest(rows: Inventory[], maps: RepoMap[], roots: MachineRoots = DEFAULT_SHIPPER_ROOTS): Entry[] {
  const repos = new Map<string, RepoMap[]>();
  for (const m of maps) {const key=`${m.machine}\0${m.cwd}`,list=repos.get(key)??[];list.push(m);repos.set(key,list);}
  const copies = new Map<string, Entry>();
  for (const r of rows.filter(r => classify(r).session)) {
    const key = JSON.stringify([r.machine, r.source_kind, r.container, r.member_path, r.sha256]);
    const ts=Date.parse(r.first_ts), matching=(repos.get(`${origin(r)}\0${r.cwd}`)??[]).filter(m=>(m.valid_from===null||ts>=Date.parse(m.valid_from))&&(m.valid_to===null||ts<Date.parse(m.valid_to)));
    const names=new Set(matching.map(m=>m.repo_canonical));
    copies.set(key, { ...r, source_kind: r.source_kind === "live" && !shipperCovers(r.member_path,origin(r),roots) ? "archive_dir" : r.source_kind, origin: origin(r), repo: names.size===1?matching[0].repo_canonical:"", selected: false, relation: "unverified", status: "pending", container_hash: "", stream: streamId(r.session_id, r.member_path) });
  }
  const entries = [...copies.values()].sort((a, b) => Number(b.bytes) - Number(a.bytes) || a.member_path.localeCompare(b.member_path));
  const largest = new Map<string, Entry>();
  for (const e of entries) {
    const canonical = largest.get(e.stream);
    if (!canonical) { largest.set(e.stream, e); e.selected = true; }
    if (canonical && hashOK(e.sha256) && canonical.sha256 === e.sha256) e.relation = "identical";
  }
  return entries;
}

/** No shared client accepted. Sources are replayable read-only streams; null means needs fetch/export. */
export async function dryRun(entries: Entry[], options: {
  read: (entry: Entry) => Promise<Chunks | null>;
  database?: string; sampleSize?: number; order?: AsyncIterable<Entry>; existing?: Iterable<ExistingCount>;
  onEntry?: (entry: Entry) => void;
}) {
  const db = new Database(options.database ?? ":memory:");
  db.exec("DROP TABLE IF EXISTS seen; CREATE TABLE IF NOT EXISTS occurrences(session TEXT, stream TEXT, hash TEXT, live_count INTEGER, prior_count INTEGER, PRIMARY KEY(session,stream,hash)) WITHOUT ROWID; DELETE FROM occurrences");
  const insert = db.query("INSERT INTO occurrences VALUES(?,?,?,?,?) ON CONFLICT(session,stream,hash) DO UPDATE SET live_count=max(live_count,excluded.live_count),prior_count=max(prior_count,excluded.prior_count)");
  const find = db.query<{ live_count: number; prior_count: number }, [string, string, string]>("SELECT live_count,prior_count FROM occurrences WHERE session=? AND stream=? AND hash=?");
  const report = { import_rows: 0, import_bytes: 0, import_sessions: 0, skip_live: 0, skip_copy: 0, live_rows: 0, needs_fetch: 0, source_changed: 0, read_errors: 0, not_transcript: 0, invalid_member_hash: 0, divergent_sessions: 0, divergent_streams: 0, unterminated_bytes: 0, sample: [] as Event[], groups: {} as Record<string, { rows: number; bytes: number; skip_live: number; skip_copy: number }> };
  const sessions = new Set<string>(), divergent = new Map<string, string>();
  const prefixes = new Map<string, Map<number, string>>();
  const verified = new Map<string, Entry[]>();
  const lengths = new Map<string, number[]>();
  const sizeSets = new Map<string, Set<number>>();
  for (const e of entries) { const sizes = sizeSets.get(e.stream) ?? new Set<number>(); sizes.add(Number(e.bytes)); sizeSets.set(e.stream, sizes); }
  for (const [stream, sizes] of sizeSets) lengths.set(stream, [...sizes].sort((a,b)=>a-b));
  const ordered = [...entries].sort((a, b) => Number(b.source_kind === "live") - Number(a.source_kind === "live") || Number(b.bytes) - Number(a.bytes));
  try {
    for (const [session, path, hash, count] of options.existing ?? []) {
      if (!hashOK(hash) || !Number.isSafeInteger(count) || count < 1) throw new Error("invalid existing occurrence count/hash");
      const stream=streamId(session,path); insert.run(stream.split("::")[0], stream, hash, count, 0);
    }
    for await (const e of options.order ?? ordered) {
      try {
      if (e.status === "invalid_member_hash") { report.invalid_member_hash++; options.onEntry?.(e); continue; }
      const source = e.origin === "unknown" || e.source_kind === "t3_sqlite" ? null : await options.read(e);
      if (!source) { e.status = "needs_fetch_or_export"; report.needs_fetch++; options.onEntry?.(e); continue; }
      const digest = createHash("sha256"), checkpoints = new Map<number, string>();
      let size = 0, checkpointIndex = 0; const boundaries = lengths.get(e.stream) ?? [];
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
      const again = await options.read(e);
      if (!again) throw new Error("source disappeared between verification and reading");
      const st = newFileState(e.harness === "codex" || /rollout-/.test(e.member_path) ? "codex" : "claude", e.harness === "t3" ? "t3" : e.harness === "codex" ? "codex" : "claude", Date.parse(e.first_ts) || 0);
      st.cwd = e.cwd;
      const subagent = !!subagentFileId(e.member_path) && (`/${e.member_path}`).includes(`/${e.session_id}/subagents/`);
      let stream=e.stream, eventSession=e.session_id;
      let identitySeen = st.kind === "claude" && subagent, firstLine = true, codexHeader = false;
      let offset = 0, carry = Buffer.alloc(0), rows = 0, bytes = 0, skipLive = 0, skipCopy = 0, liveRows = 0;
      const counts = new Map<string, number>();
      const sample: Event[] = [], secondHash = createHash("sha256");
      db.exec("BEGIN");
      try {
        for await (const chunk of again) {
          secondHash.update(chunk); carry = Buffer.concat([carry, chunk]);
          let start = 0, nl: number;
          while ((nl = carry.indexOf(10, start)) >= 0) {
            const line = carry.subarray(start, nl + 1), hash = sha256(line);
            const raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(line);
            const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
            st.harness = detectHarness(st.kind, [text]) ?? st.harness; e.harness = st.harness;
            if (firstLine && st.kind === "codex") {
              const identity=codexIdentity(text,e.session_id,e.member_path);codexHeader=!!identity;
              if(identity){stream=`${identity.native}::main`;eventSession=identity.session;}
            } firstLine = false;
            const parsed = parseLine(text, st);
            if (st.kind === "claude") identitySeen ||= identityMatches(text, e.session_id, "claude");
            const existing = find.get(stream.split("::")[0], stream, hash);
            const occurrence = (counts.get(hash) ?? 0) + 1; counts.set(hash, occurrence);
            if (e.source_kind === "live") {
              if (occurrence > (existing?.live_count ?? 0)) insert.run(stream.split("::")[0], stream, hash, occurrence, 0);
              liveRows++;
            } else if (occurrence <= (existing?.live_count ?? 0)) skipLive++;
            else if (occurrence <= (existing?.prior_count ?? 0)) skipCopy++;
            else {
              insert.run(stream.split("::")[0], stream, hash, 0, occurrence); rows++; bytes += line.length;
              if (sample.length < (options.sampleSize ?? 100)) sample.push({ ...parsed, session_id: eventSession, raw, project: e.repo || parsed.project, machine: e.origin, harness: st.harness, path: `archive://${e.container_hash || fullHash}/${e.member_path}`, generation: `archive:${fullHash}`, byte_offset: offset, content_hash: hash, line_bytes: line.length });
            }
            offset += line.length; start = nl + 1;
          }
          carry = Buffer.from(carry.subarray(start));
        }
        if (secondHash.digest("hex") !== fullHash) throw new Error("source changed during second read");
        // Untagged state markers inherit a proven Claude identity. Subagents may prove it by their parent directory.
        if (!(st.kind === "codex" ? codexHeader : identitySeen || subagent)) {
          db.exec("ROLLBACK"); e.status = "not_transcript"; e.relation = "not_transcript"; e.selected = false;
          report.not_transcript++; options.onEntry?.(e); continue;
        }
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
      e.stream=stream;e.session_id=eventSession;
      checkpoints.set(size, fullHash);
      const known = prefixes.get(e.stream);
      if (known?.get(size) === fullHash) e.relation = "prefix";
      else if (known && checkpoints.get(Math.max(...known.keys())) === known.get(Math.max(...known.keys()))) {
        e.relation = "canonical_verified";
        for (const prior of verified.get(e.stream) ?? []) if (checkpoints.get(Number(prior.bytes)) === prior.sha256) { prior.relation = "prefix"; prior.selected = false; }
      }
      else if (known) { e.relation = "divergent"; divergent.set(e.stream, e.session_id); e.selected = true; }
      else { e.relation = "canonical_verified"; }
      if (!known || size > Math.max(...known.keys())) prefixes.set(e.stream, checkpoints);
      const priorCopies = verified.get(e.stream) ?? []; priorCopies.push(e); verified.set(e.stream, priorCopies);
      e.status = "verified"; report.import_rows += rows; report.import_bytes += bytes; report.skip_live += skipLive; report.skip_copy += skipCopy; report.live_rows += liveRows; report.unterminated_bytes += carry.length;
      if (rows) sessions.add(e.session_id);
      report.sample.push(...sample.slice(0, Math.max(0, (options.sampleSize ?? 100) - report.sample.length)));
      const key = [e.origin, e.harness, e.repo || "unresolved"].join("\t"), group = report.groups[key] ?? { rows: 0, bytes: 0, skip_live: 0, skip_copy: 0 };
      group.rows += rows; group.bytes += bytes; group.skip_live += skipLive; group.skip_copy += skipCopy; report.groups[key] = group;
      options.onEntry?.(e);
      } catch { e.status = "read_error"; report.read_errors++; options.onEntry?.(e); }
    }
    const best = new Map<string, Entry>();
    for (const e of entries) if (e.status !== "not_transcript" && (!best.has(e.stream) || Number(e.bytes) > Number(best.get(e.stream)?.bytes))) best.set(e.stream, e);
    for (const e of entries) e.selected = best.get(e.stream) === e || (e.status === "verified" && e.relation === "divergent");
    report.import_sessions = sessions.size; report.divergent_sessions = new Set(divergent.values()).size; report.divergent_streams = divergent.size;
    return report;
  } finally { db.close(); }
}
