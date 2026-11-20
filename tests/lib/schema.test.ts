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
