import { expect, test } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { applySchema } from "../../src/lib/schema";
import type { ClickHouse } from "../../src/lib/clickhouse";
import { shipperLagSQL } from "../../ratchet/live-sql";

// Storage-contract guard: replacement of the raw row must never own the lag's minimum.
// Real merge semantics are exercised by live-rows.it.test.ts, including OPTIMIZE on both tables.
test("lag reads an independent minimum that survives raw-row replacement", () => {
  const query = shipperLagSQL();
  expect(query).not.toMatch(/FROM tokenlayer\.session_events\b/);
  expect(query).toContain("FROM tokenlayer.session_first_ingest");
  const path = new URL("../../schema/010a_session_first_ingest.sql", import.meta.url);
  expect(existsSync(path)).toBe(true);
  const ddl = readFileSync(path, "utf8");
  expect(ddl).toContain("ENGINE = AggregatingMergeTree");
  expect(ddl).toContain("SimpleAggregateFunction(min, DateTime64(3, 'UTC'))");
  expect(ddl).toContain("TO tokenlayer.session_first_ingest");
  expect(ddl).toContain("min(ingested_at) AS first_ingested_at");
});


test("schema reaches legacy migration before binding the first-ingest view", async () => {
  let bound = false;
  const ch = {
    config: { database: "tokenlayer" },
    exec: async (sql: string) => {
      if (sql.startsWith("ALTER TABLE tokenlayer.session_events ADD COLUMN IF NOT EXISTS session_alias")) {
        throw new Error("migration-start");
      }
      if (sql.startsWith("CREATE MATERIALIZED VIEW IF NOT EXISTS tokenlayer.mv_session_first_ingest")) bound = true;
      return "";
    },
  } as unknown as ClickHouse;
  // Stop at migration entrance; no database is contacted. A pre-migration MV is the regression.
  await expect(applySchema(ch)).rejects.toThrow("migration-start");
  expect(bound).toBe(false);
});
