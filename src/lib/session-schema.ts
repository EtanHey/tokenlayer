import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ClickHouse } from "./clickhouse";

const key = "machine, path, generation, byte_offset, content_hash";
const definition = () => readFileSync(join(import.meta.dir, "../../schema/004_session_events.sql"), "utf8");
const expectedTypes = () => [...definition().matchAll(/^    (\w+)\s+(\w+(?:\([^\n]*?\))?)/gm)]
  .filter((m) => m[1] !== "INDEX").map((m) => ({ name: m[1], type: m[2] }));
const expectedColumns = () => expectedTypes().map((c) => c.name);

export async function verifySessionSchema(ch: ClickHouse): Promise<void> {
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
  try { await verifySessionSchema(ch); return; } catch {}
  const columns = await ch.queryJSON<{ name: string }>(
    "SELECT name FROM system.columns WHERE database='tokenlayer' AND table='session_events'",
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
