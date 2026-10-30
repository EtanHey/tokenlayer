import { writeOut, writeErr, installErrorHandlers } from "../lib/egress";
import { mkdirSync, mkdtempSync, renameSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { classify, repoMap, manifest, dryRun, parseEvidenceLine, parseShipperRoots, DEFAULT_SHIPPER_ROOTS, type Inventory, type Evidence } from "./pipeline";
import { localSources } from "./sources";
import { validatedDryRun } from "./validation";
import { assertOutputsSeparate, assertSafeOutput, atomicOutput } from "./output-paths";
import { readExisting, exportExisting } from "./existing";
export { readExisting } from "./existing";

export function readTSV(path: string): Record<string, string>[] {
  const [header, ...lines] = readFileSync(path, "utf8").replace(/\r?\n$/, "").split(/\r?\n/);
  const keys = header.split("\t");
  return lines.filter(Boolean).map(line => Object.fromEntries(line.split("\t").map((v, i) => [keys[i], v])));
}
export function inventory(path: string): Inventory[] {
  return readTSV(path).map(r => {
    for (const key of ["machine", "source_kind", "container", "member_path", "session_id", "harness", "bytes", "lines", "first_ts", "last_ts", "cwd", "sha256", "mtime"]) if (typeof r[key] !== "string") throw new Error(`missing inventory column ${key}`);
    return { machine: r.machine, source_kind: r.source_kind, container: r.container, member_path: r.member_path, session_id: r.session_id, harness: r.harness, bytes: r.bytes, lines: r.lines, first_ts: r.first_ts, last_ts: r.last_ts, cwd: r.cwd, sha256: r.sha256, mtime: r.mtime };
  });
}
const ddl = `-- PROPOSAL: tokenlayer owns final DDL. Intervals follow dated evidence; null bounds are open.\nCREATE TABLE tokenlayer.repo_map (machine LowCardinality(String), cwd String, repo_canonical String, valid_from Nullable(DateTime64(3,'UTC')), valid_to Nullable(DateTime64(3,'UTC')), evidence Array(String), confidence LowCardinality(String)) ENGINE=MergeTree ORDER BY (machine,cwd);\n`;

if (import.meta.main) {
  installErrorHandlers();
  if (process.argv[2] === "export-existing") {
    const { values } = parseArgs({ args: process.argv.slice(3), options: { out: { type: "string" } } });
    if (!values.out) throw Error("usage: export-existing --out NEW_EXPORT.tsv (CLICKHOUSE_* environment)");
    const { ClickHouse } = await import("../lib/clickhouse");
    await exportExisting(ClickHouse.fromEnv(), values.out);
    process.exit(0);
  }
  const { values } = parseArgs({ options: { inventory: { type: "string", multiple: true }, manifest: { type: "string" }, existing: { type: "string" }, evidence: { type: "string" }, roots: {type:"string"}, out: { type: "string" }, validate: { type: "boolean", default: false } } });
  if (!values.out || (!values.manifest && !values.inventory?.length)) throw new Error("usage: --inventory TSV [--inventory TSV] --evidence NDJSON --existing EXPORT.tsv --out DIR [--validate]");
  const existing = readExisting(values.existing);
  const inputPaths = values.manifest ? [values.manifest] : values.inventory ?? [];
  const rows = inputPaths.flatMap(inventory);
  const evidence: Evidence[] = values.evidence ? readFileSync(values.evidence, "utf8").split("\n").filter(Boolean).map(parseEvidenceLine) : [];
  if (process.env.USER === "happycampr") throw new Error("Phase 4 dry-run is M4-only");
  const out = resolve(values.out);
  const targets = ["dedupe.sqlite", "dedupe.sqlite-wal", "dedupe.sqlite-shm", "repo_map.ndjson", "repo_map.ddl.sql", "unresolved-cwds.ndjson", "manifest.tsv", "dry-run.json", "classification.tsv", "shipper-roots.json"].map(p => join(out, p));
  assertOutputsSeparate(targets, [...inputPaths, values.evidence, values.existing, values.roots, ...rows.flatMap(r => [r.member_path, r.container])].filter((p): p is string => !!p));
  mkdirSync(out, { recursive: true });
  if (inputPaths.some(p => ["manifest.tsv", "classification.tsv"].some(n => resolve(p) === join(out, n)))) throw new Error("output directory must not contain input inventories");
  if (values.manifest && !values.evidence) for (const r of readTSV(values.manifest)) if (/^[\w.-]+\/[\w.-]+$/.test(r.repo ?? "")) evidence.push({ cwd: r.cwd, repo: r.repo, evidence: "prior manifest mapping", confidence: "medium" });
  const roots=values.roots?parseShipperRoots(JSON.parse(readFileSync(values.roots,"utf8"))):DEFAULT_SHIPPER_ROOTS;
  const maps = repoMap(rows.filter(r => classify(r).session), evidence), entries = manifest(rows, maps, roots);
  let processed = 0;
  const sources = localSources(entries);
  const database = join(mkdtempSync(join(out, ".dedupe-")), "dedupe.sqlite");
  const options = {...sources,existing,database,onEntry:()=>{if(++processed%1000===0)writeErr(`verified progress ${processed}/${entries.length}`);}};
  const {report,validated,baseline} = values.validate ? await validatedDryRun(entries,options) : {report:await dryRun(entries,options),validated:0,baseline:null};
  assertSafeOutput(join(out, "dedupe.sqlite"));
  renameSync(database, join(out, "dedupe.sqlite"));
  const output = (name: string, value: string) => atomicOutput(join(out, name), value);
  output("shipper-roots.json",JSON.stringify(roots,null,2)+"\n");
  output("repo_map.ndjson", maps.map(m => JSON.stringify(m)).join("\n") + "\n"); output("repo_map.ddl.sql", ddl);
  output("unresolved-cwds.ndjson", maps.filter(m => !m.repo_canonical).map(m => JSON.stringify(m)).join("\n") + "\n");
  const keys = Object.keys(entries[0] ?? {});
  output("manifest.tsv", [keys.join("\t"), ...entries.map(e => keys.map(k => String(Reflect.get(e, k)).replace(/[\t\r\n]/g, " ")).join("\t"))].join("\n") + "\n");
  const { sample, ...counts } = report;
  output("dry-run.json", JSON.stringify({ at: new Date().toISOString(), ...counts, validated, validation_baseline:baseline, source_errors: sources.errors }, null, 2) + "\n");
  const rejected = new Set(entries.filter(e => e.status === "not_transcript").map(e => JSON.stringify([e.machine,e.container,e.member_path])));
  output("classification.tsv", "session\treason\tmachine\tcontainer\tmember_path\n" + rows.map(r => { const c = rejected.has(JSON.stringify([r.machine,r.container,r.member_path])) ? {session:false,reason:"verified content lacks matching transcript identity"} : classify(r); return [c.session, c.reason, r.machine, r.container, r.member_path].join("\t"); }).join("\n") + "\n");
  writeOut(JSON.stringify({ sessions: new Set(entries.map(e => e.session_id)).size, copies: entries.length, import_rows: report.import_rows, needs_shipper_backfill: report.needs_shipper_backfill, blocked_live: report.blocked_live, validated }));
  if (report.needs_shipper_backfill || report.blocked_live) process.exitCode = 2;
}
