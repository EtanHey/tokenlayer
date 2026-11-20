import { expect, test } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { shipperLagSQL } from "../../ratchet/live-sql";

// Storage-contract guard: replacement of the raw row must never own the lag's minimum.
// Real merge semantics are exercised by live-rows.it.test.ts, including OPTIMIZE on both tables.
test("lag reads an independent minimum that survives raw-row replacement", () => {
  const query = shipperLagSQL();
  expect(query).not.toMatch(/FROM tokenlayer\.session_events\b/);
  expect(query).toContain("FROM tokenlayer.session_first_ingest");
  const path = new URL("../../schema/004a_session_first_ingest.sql", import.meta.url);
  expect(existsSync(path)).toBe(true);
  const ddl = readFileSync(path, "utf8");
  expect(ddl).toContain("ENGINE = AggregatingMergeTree");
  expect(ddl).toContain("SimpleAggregateFunction(min, DateTime64(3, 'UTC'))");
  expect(ddl).toContain("TO tokenlayer.session_first_ingest");
  expect(ddl).toContain("min(ingested_at) AS first_ingested_at");
});
