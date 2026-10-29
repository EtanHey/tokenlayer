import { writeOut, installErrorHandlers } from './egress';
import { migrateSessionSchema } from "./session-schema";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ClickHouse } from "./clickhouse";

export const SCHEMA_DIR = join(import.meta.dir, "..", "..", "schema");

/** Apply schema/*.sql in name order. Files contain idempotent statements (CREATE ... IF NOT EXISTS). */
export async function applySchema(ch: ClickHouse, dir = SCHEMA_DIR): Promise<string[]> {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const f of files) {
    // Views must bind to the migrated column list, including on legacy upgrades.
    if (f === "005_views.sql") await migrateSessionSchema(ch);
    const sql = readFileSync(join(dir, f), "utf8")
      .split("\n")
      .filter((l) => !l.trim().startsWith("--"))
      .join("\n")
      .trim()
      .replace(/;\s*$/, "");
    for (const statement of sql.split(";").map((s) => s.trim()).filter(Boolean)) await ch.exec(statement);
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
