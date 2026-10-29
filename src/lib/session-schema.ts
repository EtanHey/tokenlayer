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
  const archive = await ch.queryJSON("SELECT name FROM system.tables WHERE database='tokenlayer' AND name='session_events_pre_content_hash'");
  if (archive.length) throw new Error("session_events_pre_content_hash already exists; inspect migration before retry");
  await ch.exec(definition().replace("tokenlayer.session_events", "tokenlayer.session_events_hash_next").replace(/;\s*$/, ""));
  // Repeating a failed copy may add physical duplicates; the replacement key collapses them under FINAL.
  const targets = expectedColumns().filter((n) => names.has(n) || ["generation", "message_id", "content_hash"].includes(n));
  // Historical source bytes are unavailable; domain-separate receipts of stored columns except ingestion time.
  const stored = [...names].filter((n) => n !== "ingested_at").map((n) => `\`${n.replaceAll("`", "``")}\``);
  const legacyHash = `concat('legacy:', lower(hex(SHA256(toJSONString(tuple(${stored.join(",")}))))))`;
  await ch.exec(`INSERT INTO tokenlayer.session_events_hash_next (${targets.join(",")}) SELECT ${targets.map((n) =>
    names.has(n) ? n : n === "generation" ? "'legacy'" : n === "content_hash" ? legacyHash : "''").join(",")} FROM tokenlayer.session_events`);
  await ch.exec("EXCHANGE TABLES tokenlayer.session_events AND tokenlayer.session_events_hash_next");
  await ch.exec("RENAME TABLE tokenlayer.session_events_hash_next TO tokenlayer.session_events_pre_content_hash");
  await verifySessionSchema(ch);
}
