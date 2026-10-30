import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dryRun, manifest, sha256, type Inventory } from "../../src/archaeology/pipeline";
import { readExisting } from "../../src/archaeology/main";

const scratch = () => { mkdirSync(".local", { recursive: true }); return realpathSync(mkdtempSync(".local/archaeology-blockers-")); };
const row = (member_path: string, bytes: Buffer, overrides: Partial<Inventory> = {}): Inventory => ({ machine: "m4", source_kind: "live", container: "", member_path, session_id: "session", harness: "claude", bytes: String(bytes.length), lines: "1", first_ts: "2026-01-01", last_ts: "2026-01-01", cwd: "/Users/etanheyman/Gits/example", sha256: sha256(bytes), mtime: "", ...overrides });
const read = (bytes: Buffer) => async () => (async function* () { yield bytes; })();

test("SHOULD-2 CLI requires a server export before writing output", () => {
  const dir = scratch(), input = join(dir, "inventory.tsv");
  writeFileSync(input, Object.keys(row("session.jsonl", Buffer.from("{}\n"))).join("\t") + "\n");
  const result = Bun.spawnSync([process.execPath, "src/archaeology/main.ts", "--inventory", input, "--out", join(dir, "out")], { env: { ...process.env, USER: "fixture" } });
  expect(result.exitCode).not.toBe(0); expect(result.stderr.toString()).toContain("--existing"); expect(existsSync(join(dir,"out"))).toBe(false);
});

test("SHOULD-2 server counts take the maximum across paths and generations, never their sum", async () => {
  const dir=scratch(), path=join(dir,"existing.tsv"), line=Buffer.from('{"sessionId":"session","type":"user"}\n'), bytes=Buffer.concat([line,line]);
  const header="machine\tsession_id\tpath\tgeneration\tcontent_hash\tcount\n";
  writeFileSync(path, ""); expect(()=>readExisting(path)).toThrow("header");
  writeFileSync(path,header); expect(readExisting(path)).toEqual([]);
  writeFileSync(path,header+["m4\tsession\told.jsonl\tg1", "m4\tsession\told.jsonl\tg2", "m4\tsession\tother.jsonl\tg1"].map(prefix=>`${prefix}\t${sha256(line)}\t1\n`).join(""));
  const result=await dryRun(manifest([row("archive.jsonl",bytes,{source_kind:"archive_dir"})],[]),{existing:readExisting(path),read:read(bytes)});
  expect(result.import_rows).toBe(1); expect(result.skip_live).toBe(1);
});

test("NIT-1 live roots use the physical machine and conflicting cwd provenance needs fetch", async () => {
  const bytes = Buffer.from('{"sessionId":"session","type":"user"}\n');
  const entries = manifest([row("/m4-live/session.jsonl", bytes, { cwd: "/Users/happycampr/Gits/example" })], [], { m4: ["/m4-live"], m1: [] });
  expect(entries[0].source_kind).toBe("live");
  let reads = 0;
  const result = await dryRun(entries, { read: async () => { reads++; return read(bytes)(); } });
  expect(result.needs_fetch).toBe(1); expect(result.import_rows).toBe(0); expect(reads).toBe(0);
});

for (const tool of ["disk-plan", "repo-evidence"]) test(`NIT-7 ${tool} refuses input aliases through symlinks and directory descendants`, () => {
  const dir = scratch(), input = join(dir, "input.json"), alias = join(dir, "alias.json"), source = join(dir, "source"), link = join(dir, "source-link");
  const original = JSON.stringify({ import_bytes: 0, groups: {} });
  writeFileSync(input, original); symlinkSync(input, alias); mkdirSync(source); symlinkSync(source, link);
  for (const out of [input, alias, join(link, "new", "output.json")]) {
    const args = tool === "disk-plan" ? ["--report", out.includes("output.json") ? source : input, "--m1-free-gib", "100"] : ["--inventory", out.includes("output.json") ? source : input, "--lookups", join(dir, "lookups.json")];
    const result = Bun.spawnSync([process.execPath, `src/archaeology/${tool}.ts`, ...args, "--out", out], { env: { ...process.env, USER: "fixture" } });
    expect(result.exitCode).not.toBe(0); expect(result.stderr.toString()).toContain("output overlaps an input"); expect(readFileSync(input, "utf8")).toBe(original);
  }
});
