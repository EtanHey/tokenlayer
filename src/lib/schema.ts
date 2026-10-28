import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ClickHouse } from "./clickhouse";

export const SCHEMA_DIR = join(import.meta.dir, "..", "..", "schema");

/** Apply schema/*.sql in name order. Every file is one idempotent statement (CREATE ... IF NOT EXISTS). */
export async function applySchema(ch: ClickHouse, dir = SCHEMA_DIR): Promise<string[]> {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const f of files) {
    const sql = readFileSync(join(dir, f), "utf8")
      .split("\n")
      .filter((l) => !l.trim().startsWith("--"))
      .join("\n")
      .trim()
      .replace(/;\s*$/, "");
    await ch.exec(sql);
  }
  return files;
}

if (import.meta.main) {
  const { ClickHouse } = await import("./clickhouse");
  const applied = await applySchema(ClickHouse.fromEnv());
  console.log(`applied ${applied.length} schema files: ${applied.join(", ")}`);
}
