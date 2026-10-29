import { ClickHouse } from "../../src/lib/clickhouse";
import { shipOnce } from "../../src/ship/ship";

// Synthetic loopback config only. Pause at the real insert boundary for the parent to SIGKILL.
const { config, options, phase, batch } = JSON.parse(process.argv[2]);
const client = new ClickHouse(config);
const insert = client.insert.bind(client);
let calls = 0;
client.insert = async (...args) => {
  if (++calls !== batch) return insert(...args);
  if (phase === "after") await insert(...args);
  console.log("CRASH_BOUNDARY");
  await Bun.sleep(60_000);
  throw new Error("parent failed to kill child");
};
await shipOnce({ ...options, clickhouse: client });
