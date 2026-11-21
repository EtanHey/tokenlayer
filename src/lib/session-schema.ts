import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fixed, type ClickHouse } from "./clickhouse";

const key = "machine, path, generation, byte_offset, content_hash";
const definition = () => readFileSync(join(import.meta.dir, "../../schema/004_session_events.sql"), "utf8");
const columnLines = () => [...definition().matchAll(/^    (\w+)\s+(\w+(?:\((?:[^()\n]|\([^()\n]*\))*\))?)(.*?),?$/gm)].filter((m) => m[1] !== "INDEX");
/** Stored columns: what ship writes and what a rebuild copies. MATERIALIZED columns are derived from raw by the server. */
const expectedTypes = () => columnLines().filter((m) => !/\bMATERIALIZED\b/.test(m[3]))
  .map((m) => ({ name: m[1], type: m[2] }));
/** R7: facts the views read, extracted from raw at insert. Adding one is metadata only; old parts compute it on read. */
export const materializedColumns = () => columnLines().filter((m) => /\bMATERIALIZED\b/.test(m[3]))
  .map((m) => ({ name: m[1], definition: m[0].trim().replace(/,$/, "") }));
const expectedColumns = () => expectedTypes().map((c) => c.name);

export async function verifySessionSchema(ch: ClickHouse): Promise<void> {
  fixed(ch);
  const tables = await ch.queryJSON<{ sorting_key: string; engine: string }>(
    "SELECT sorting_key, engine FROM system.tables WHERE database='tokenlayer' AND name='session_events'",
  );
  const columns = await ch.queryJSON<{ name: string; type: string }>(
    "SELECT name, type FROM system.columns WHERE database='tokenlayer' AND table='session_events'",
  );
  if (tables[0]?.sorting_key !== key || tables[0]?.engine !== "ReplacingMergeTree" ||
      expectedTypes().some(({ name, type }) => columns.find((c) => c.name === name)?.type.replace(/\s/g, "") !== type.replace(/\s/g, ""))) {
    throw new Error("session_events schema mismatch; stop shippers and run bun run schema:apply");
  }
}

/** Run with shippers stopped. EXCHANGE is atomic; the old table remains as an archive. */
export async function migrateSessionSchema(ch: ClickHouse): Promise<void> {
  fixed(ch);
  // Additive F-1 upgrade: existing rows keep an empty alias without rebuilding the archive.
  await ch.exec("ALTER TABLE tokenlayer.session_events ADD COLUMN IF NOT EXISTS session_alias String CODEC(ZSTD(3))");
  await ch.exec("ALTER TABLE tokenlayer.session_events ADD COLUMN IF NOT EXISTS credits Nullable(Float64) DEFAULT NULL");
  // Cursor native transcripts have no model/usage evidence. Preserve NULL rather than zero.
  // Guard repeat applications; type-conversion cost must be checked at rollout.
  const nullable = expectedTypes().filter(c => ["model", "input_tokens", "output_tokens", "cache_read_tokens", "cache_creation_tokens", "reasoning_tokens"].includes(c.name));
  const installed = await ch.queryJSON<{ name: string; type: string }>("SELECT name, type FROM system.columns WHERE database='tokenlayer' AND table='session_events'");
  for (const { name, type } of nullable) {
    const old = installed.find(c => c.name === name)?.type;
    if (old === (name === "model" ? "LowCardinality(String)" : "UInt64")) await ch.exec(`ALTER TABLE tokenlayer.session_events MODIFY COLUMN ${name} ${type}`);
  }
  let current = true;
  try { await verifySessionSchema(ch); } catch { current = false; }
  if (current) {
    // Metadata only, so an ALTER failure here must surface, never fall through to the rebuild below.
    for (const { definition } of materializedColumns()) {
      await ch.exec(`ALTER TABLE tokenlayer.session_events ADD COLUMN IF NOT EXISTS ${definition}`);
    }
    return;
  }
  const columns = await ch.queryJSON<{ name: string }>(
    "SELECT name FROM system.columns WHERE database='tokenlayer' AND table='session_events' AND default_kind != 'MATERIALIZED'",
  );
  const names = new Set(columns.map((c) => c.name));
  const archive = await ch.queryJSON<{ name: string }>("SELECT name FROM system.tables WHERE database='tokenlayer' AND name IN ('session_events_pre_content_hash','session_events_hash_next')");
  if (archive.length) throw new Error(`${archive[0].name} already exists; inspect migration before retry`);
  const [space] = await ch.queryJSON<{ bytes: string; free: string }>(
    "SELECT (SELECT sum(bytes_on_disk) FROM system.parts WHERE database='tokenlayer' AND startsWith(table,'session_events') AND active) AS bytes, (SELECT min(free_space) FROM system.disks) AS free",
  );
  if (!space || BigInt(space.free) < 2n * BigInt(space.bytes)) throw new Error("session migration requires free disk >= 2x active session table bytes");
  await ch.exec(definition().replace("tokenlayer.session_events", "tokenlayer.session_events_hash_next").replace(/;\s*$/, ""));
  const targets = expectedColumns().filter((n) => names.has(n) || ["generation", "message_id", "content_hash"].includes(n));
  // Harness corrections are versions, not identity; retain distinct stored-content variants.
  const stored = [...names].filter((n) => n !== "ingested_at" && n !== "harness").map((n) => `\`${n.replaceAll("`", "``")}\``);
  const legacyHash = `concat('legacy:', lower(hex(SHA256(toJSONString(tuple(${stored.join(",")}))))))`;
  // Versionless legacy parts have no ingestion order after copying. Apply their FINAL harness winner
  // to every stored-content variant instead of letting unordered SELECT streams pick a stale label.
  const oldKey = ["machine", "path", ...(names.has("generation") ? ["generation"] : []), "byte_offset"].join(",");
  const source = names.has("harness")
    ? `FROM tokenlayer.session_events ANY LEFT JOIN (SELECT ${oldKey}, harness AS winner_harness FROM tokenlayer.session_events FINAL) AS winners USING (${oldKey})`
    : "FROM tokenlayer.session_events";
  await ch.exec(`INSERT INTO tokenlayer.session_events_hash_next (${targets.join(",")}) SELECT ${targets.map((n) =>
    n === "harness" && names.has(n) ? "winner_harness" : names.has(n) ? n : n === "generation" ? "'legacy'" : n === "content_hash" ? legacyHash : "''").join(",")} ${source}`);
  await ch.exec("EXCHANGE TABLES tokenlayer.session_events AND tokenlayer.session_events_hash_next");
  await ch.exec("RENAME TABLE tokenlayer.session_events_hash_next TO tokenlayer.session_events_pre_content_hash");
  await verifySessionSchema(ch);
}
