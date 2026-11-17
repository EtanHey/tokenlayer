import { SESSION_RETENTION_DAYS } from "./session-retention";
import { writeOut, installErrorHandlers } from './egress';
import { repoFunctionsSQL } from "./repo";
import { migrateSessionSchema } from "./session-schema";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fixed, type ClickHouse } from "./clickhouse";

export const SCHEMA_DIR = join(import.meta.dir, "..", "..", "schema");

/** ClickHouse prints INTERVAL as toIntervalDay and adds predicate parentheses. */
function canonicalTTL(sql: string): string {
  return sql.replace(/INTERVAL\s+(\d+)\s+DAY/gi, "toIntervalDay($1)")
    .replace(/\bDELETE\s+WHERE\b/g, "WHERE")
    .replace(/[\s`()]/g, "");
}

/** Guard migration 011 using live metadata, rather than reissuing MODIFY TTL on deploy. */
async function retentionStatementApplied(ch: ClickHouse, statement: string): Promise<boolean> {
  const table = statement.match(/^ALTER TABLE tokenlayer\.(session_events|proxy_usage) /)?.[1];
  if (!table) return false;
  const [row] = await ch.queryJSON<{ create_table_query: string }>(
    `SELECT create_table_query FROM system.tables WHERE database = 'tokenlayer' AND name = '${table}'`,
  );
  if (!row) return false;
  const settings = row.create_table_query.match(/\bSETTINGS\s+([\s\S]*)$/)?.[1] ?? "";
  const requestedSettings = statement.match(/MODIFY SETTING (.*)$/)?.[1];
  if (requestedSettings) return requestedSettings.split(",").every(setting =>
    settings.split(",").some(actual => actual.trim() === setting.trim()));
  const ttl = statement.match(/MODIFY TTL ([\s\S]*?) SETTINGS /)?.[1];
  const installedTTL = row.create_table_query.match(/\bTTL ([\s\S]*?)\s+SETTINGS /)?.[1];
  return !!ttl && !!installedTTL && canonicalTTL(ttl) === canonicalTTL(installedTTL);
}

/** Apply schema/*.sql in name order. Files contain idempotent CREATE/ALTER statements and shared retention placeholders. */
export async function applySchema(ch: ClickHouse, dir = SCHEMA_DIR): Promise<string[]> {
  fixed(ch);
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const f of files) {
    // Views must bind to the migrated column list, including on legacy upgrades.
    if (f === "005_views.sql") await migrateSessionSchema(ch);
    if (f === "006_session_context.sql") for (const sql of repoFunctionsSQL()) await ch.exec(sql);
    const sql = readFileSync(join(dir, f), "utf8")
      .replaceAll("{{SESSION_RETENTION_DAYS}}", String(SESSION_RETENTION_DAYS))
      .split("\n")
      .filter((l) => !l.trim().startsWith("--"))
      .join("\n")
      .trim()
      .replace(/;\s*$/, "");
    for (const statement of sql.split(";").map((s) => s.trim()).filter(Boolean)) {
      if (f === "011_session_retention.sql" && await retentionStatementApplied(ch, statement)) continue;
      await ch.exec(statement);
    }
  }
  await migrateSessionSchema(ch);
  return files;
}

if (import.meta.main) {
  installErrorHandlers();
  const { ClickHouse } = await import("./clickhouse");
  const applied = await applySchema(ClickHouse.fromEnv());
  writeOut(`applied ${applied.length} schema files: ${applied.join(", ")}`);
}
