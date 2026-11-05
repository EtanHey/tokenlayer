import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import type { ClickHouse } from "../lib/clickhouse";
import { verifySessionSchema } from "../lib/session-schema";

export class RestoreError extends Error {}
export type Selection = { machine?: string; path?: string; generation?: string };
type Identity = { machine: string; path: string; generation: string };
type Row = { offset: string; line_bytes: number; content_hash: string; raw_hex: string };
// Hex literals keep all user-supplied identifiers out of SQL syntax, including quotes/backslashes.
const literal = (s: string) => `unhex('${Buffer.from(s).toString("hex")}')`;
const digest = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const settings = "SETTINGS do_not_merge_across_partitions_select_final=0, max_result_bytes=67108864, result_overflow_mode='throw'";

/** Read one file generation, including its id-less lines. Never combine archive identities. */
export async function readSession(ch: ClickHouse, id: string, selection: Selection = {}) {
  await verifySessionSchema(ch);
  const filters = Object.entries(selection).map(([k, v]) => `${k}=${literal(v!)}`);
  const identities = await ch.queryJSON<Identity>(`SELECT DISTINCT machine, path, generation
    FROM tokenlayer.session_events FINAL
    WHERE (session_id=${literal(id)} OR session_alias=${literal(id)}) ${filters.map(f => `AND ${f}`).join(" ")}
    LIMIT 2 ${settings}`);
  if (!identities.length) throw new RestoreError("session not found for these selectors");
  if (identities.length !== 1) throw new RestoreError("ambiguous session: specify --machine, --path and --generation");
  const identity = identities[0];
  const where = Object.entries(identity).map(([k, v]) => `${k}=${literal(v)}`).join(" AND ");
  const rows = await ch.queryJSON<Row>(`SELECT toString(byte_offset) AS offset, line_bytes, content_hash, hex(raw) AS raw_hex
    FROM tokenlayer.session_events FINAL WHERE ${where} ORDER BY byte_offset, content_hash ${settings}`);
  if (!rows.length) throw new RestoreError("archive disappeared during read");
  const chunks: Buffer[] = [];
  let end = 0n;
  for (const row of rows) {
    if (!/^\d+$/.test(row.offset) || BigInt(row.offset) !== end) throw new RestoreError("archive has a gap, overlap or conflicting offset");
    if (!/^[a-f0-9]{64}$/i.test(row.content_hash)) throw new RestoreError("archive lacks a source-byte hash (legacy rows cannot prove exactness)");
    if (!/^(?:[a-f0-9]{2})+$/i.test(row.raw_hex)) throw new RestoreError("archive contains invalid byte encoding");
    const bytes = Buffer.from(row.raw_hex, "hex");
    if (bytes.length !== row.line_bytes || digest(bytes) !== row.content_hash.toLowerCase()) throw new RestoreError("archive byte length or hash mismatch");
    if (bytes.indexOf(10) !== bytes.length - 1) throw new RestoreError("archive row is not one complete LF-terminated line");
    chunks.push(bytes);
    end += BigInt(bytes.length);
  }
  const bytes = Buffer.concat(chunks);
  return { identity, bytes, rows: rows.length, sha256: digest(bytes) };
}

/** Check before writing unredacted archive data; repo destinations must be gitignored. */
function checkDestination(target: string): void {
  let ancestor = target;
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  ancestor = realpathSync(ancestor);
  const repo = Bun.spawnSync(["git", "-C", ancestor, "rev-parse", "--show-toplevel"], { stdout: "pipe", stderr: "pipe", env: { ...process.env, LC_ALL: "C" } });
  if (repo.exitCode === 0) {
    const ignored = Bun.spawnSync(["git", "-C", ancestor, "check-ignore", "-q", "--", target], { stdout: "ignore", stderr: "ignore" });
    if (ignored.exitCode !== 0) throw new RestoreError("restore destination inside a repo must be gitignored before writing");
  } else if (repo.exitCode !== 128 || !repo.stderr.toString().startsWith("fatal: not a git repository")) {
    throw new RestoreError("cannot verify destination gitignore status");
  }
}

/** Publish a private bundle only after complete validation. Existing restores are never overwritten. */
export async function restoreSession(ch: ClickHouse, id: string, options: Selection & { to?: string } = {}) {
  const { to, ...selection } = options;
  const archive = await readSession(ch, id, selection);
  const destination = resolve(to ?? join(homedir(), ".local/share/tokenlayer/restores"));
  checkDestination(join(destination, "restore-probe", "session.jsonl"));
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  // Resolve parent symlinks before the second check, so an alias cannot bypass repo protection.
  const parent = realpathSync(destination);
  checkDestination(join(parent, "restore-probe", "session.jsonl"));
  const directory = mkdtempSync(join(parent, "restore-"));
  const file = join(directory, "session.jsonl");
  const receipt = { directory, file, ...archive.identity, rows: archive.rows, bytes: archive.bytes.length,
    sha256: archive.sha256, scope: "archived-contiguous-prefix", sourceComplete: "unknown" };
  try {
    checkDestination(file);
    checkDestination(join(directory, "receipt.json"));
    writeFileSync(file, archive.bytes, { flag: "wx", mode: 0o600 });
    if (!readFileSync(file).equals(archive.bytes)) throw new RestoreError("restored file readback mismatch");
    writeFileSync(join(directory, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    return receipt;
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}
