import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SCHEMA_DIR } from "../../src/lib/schema";
import { burnSQL } from "../../src/dashboard/server";

test("retired credentials_snap is absent from schema and quota readers use proxy_usage.ratelimit", () => {
  const schema = readdirSync(SCHEMA_DIR)
    .filter((file) => file.endsWith(".sql"))
    .map((file) => readFileSync(join(SCHEMA_DIR, file), "utf8"))
    .join("\n")
    .replace(/--[^\n]*/g, "");
  expect(schema).not.toMatch(/\bcredentials_snap\b/i);

  const compare = readFileSync(join(SCHEMA_DIR, "009_provider_usage_compare.sql"), "utf8");
  const claudePeaks = compare.split("), quota_peaks AS (")[1]?.split("UNION ALL")[0];
  expect(claudePeaks).toBeDefined();
  for (const query of [claudePeaks!, burnSQL]) {
    expect(query).toContain("FROM tokenlayer.proxy_usage");
    expect(query).toContain("provider = 'claude'");
    expect(query).toMatch(/ratelimit\[/);
    expect(query).toContain("anthropic-ratelimit-unified-7d-utilization");
    expect(query).not.toContain("credentials_snap");
  }
  expect(claudePeaks).toContain("anthropic-ratelimit-unified-5h-utilization");
  expect(burnSQL).toContain("anthropic-ratelimit-unified-7d_oi-utilization");
});

test("Cursor schema upgrade preserves explicit nullable types and is repeatable without archive rebuild", async () => {
  const { ClickHouse } = await import("../../src/lib/clickhouse");
  const { migrateSessionSchema, verifySessionSchema } = await import("../../src/lib/session-schema");
  const sql = readFileSync(join(SCHEMA_DIR, "004_session_events.sql"), "utf8");
  const columns = [...sql.matchAll(/^    (\w+)\s+(.+?),?$/gm)]
    .filter(m => m[1] !== "INDEX" && !m[2].includes("MATERIALIZED"))
    .map(m => ({ name: m[1], type: m[2].split(/\s+(?:CODEC|DEFAULT)/)[0].replace(/,$/, "") }));
  const names = ["model", "input_tokens", "output_tokens", "cache_read_tokens", "cache_creation_tokens", "reasoning_tokens"];
  for (const c of columns) if (names.includes(c.name)) {
    expect(c.type).toBe(c.name === "model" ? "LowCardinality(Nullable(String))" : "Nullable(UInt64)");
    c.type = c.name === "model" ? "LowCardinality(String)" : "UInt64";
  }
  class SchemaClient extends ClickHouse {
    statements: string[] = [];
    override async queryJSON<T>(query: string): Promise<T[]> {
      return (query.includes("system.tables") ? [{ sorting_key: "machine, path, generation, byte_offset, content_hash", engine: "ReplacingMergeTree" }] : columns) as T[];
    }
    override async exec(query: string) {
      this.statements.push(query);
      const match = /MODIFY COLUMN (\w+) (.+)$/.exec(query);
      if (match) columns.find(c => c.name === match[1])!.type = match[2];
      return "";
    }
  }
  const client = new SchemaClient({ url: "http://unused", user: "default", password: "", database: "tokenlayer" });
  await expect(verifySessionSchema(client)).rejects.toThrow("schema mismatch");
  await migrateSessionSchema(client);
  await verifySessionSchema(client);
  expect(client.statements.filter(s => s.includes("MODIFY COLUMN"))).toHaveLength(6);
  client.statements.length = 0;
  await migrateSessionSchema(client);
  expect(client.statements.some(s => /MODIFY COLUMN|INSERT INTO|EXCHANGE TABLES/.test(s))).toBe(false);
});
