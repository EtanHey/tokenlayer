import { ClickHouse } from "../../src/lib/clickhouse";
import { mock } from "bun:test";
import * as state from "../../src/ship/state";

// Synthetic loopback config only. Pause at the real insert boundary for the parent to SIGKILL.
const { config, options, phase, batch } = JSON.parse(process.argv[2]);
const saveState = state.saveState;
const pause = () => { console.log("CRASH_BOUNDARY"); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000); };
let saves = 0;
mock.module("../../src/ship/state", () => ({ ...state, saveState: (path: string, value: state.ShipState) => {
  const target = phase === "journal-before" ? path.endsWith(".generations") : path === options.statePath;
  if (target && ++saves === batch && phase === "journal-before") pause();
  saveState(path, value);
  if (target && saves === batch && phase === "checkpoint") pause();
} }));
const { shipOnce } = await import("../../src/ship/ship");
const client = new ClickHouse(config);
const insert = client.insert.bind(client);
let calls = 0;
client.insert = async (...args) => {
  if (++calls !== batch) return insert(...args);
  if (phase !== "before" && phase !== "after") return insert(...args);
  if (phase === "after") await insert(...args);
  console.log("CRASH_BOUNDARY");
  await Bun.sleep(60_000);
  throw new Error("parent failed to kill child");
};
await shipOnce({ ...options, clickhouse: client });
