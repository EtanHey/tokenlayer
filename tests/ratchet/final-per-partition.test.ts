import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FINAL_PER_PARTITION, LIVE_QUERY_SQL, liveRatioSQL } from "../../ratchet/live-sql";

const file = (path: string) => readFileSync(join(import.meta.dir, "../..", path), "utf8");

// session_events versions never span its monthly partitions (ratchet/live-sql.ts), so every FINAL reader that
// filters or scans by ts merges per partition: a plain FINAL reads and merges the whole table first.
describe("session_events FINAL readers merge per partition", () => {
  test("ch_live_query_p95_ms", () => expect(LIVE_QUERY_SQL).toContain(FINAL_PER_PARTITION));
  test.each(["cache_read_write_ratio_24h", "w1h_share_24h"])("%s", (id) => {
    expect(liveRatioSQL(id)).toEndWith(`FROM tokenlayer.session_events FINAL WHERE ts>now()-INTERVAL 1 DAY SETTINGS ${FINAL_PER_PARTITION}`);
  });
  test("v_session_events_context reads session_events FINAL per partition", () => {
    expect(file("schema/006_session_context.sql")).toMatch(/FROM tokenlayer\.session_events FINAL\s+SETTINGS do_not_merge_across_partitions_select_final=1\n/);
  });
  test("archaeology existing.sql carries the setting for both FINAL reads", () => {
    expect(file("src/archaeology/existing.sql")).toMatch(/\nSETTINGS do_not_merge_across_partitions_select_final=1\nFORMAT TabSeparatedWithNames\n$/);
  });
});
