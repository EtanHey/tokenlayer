import { test, expect } from "bun:test";
import { clickhouseBinary, startLocalClickHouse } from "../../src/lib/local-clickhouse";

test.skipIf(!clickhouseBinary())("S-7 production local ClickHouse helper serves a real isolated request", async () => {
  const local=await startLocalClickHouse();
  try {expect(await local.client.exec("SELECT 1")).toBe("1\n");}
  finally {await local.stop();}
}, 40_000);
