import {
  readFileSync,
  existsSync,
  writeFileSync,
  renameSync,
  openSync,
  closeSync,
  fsyncSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import type { ClickHouse } from "../lib/clickhouse";
class PermanentShippingFault extends Error {
  constructor(readonly code: string) { super(code); }
}
const hash = (line: Buffer | string) =>
  createHash("sha256").update(line).digest("hex");
/** Cursor advances only after acknowledgement; a persisted pending batch pins ambiguous retries. */
export async function shipEvents(
  ch: Pick<ClickHouse, "insert">,
  path = process.env.TOKENLAYER_FABLE_EVENTS ??
    join(homedir(), ".local/state/tokenlayer/fable/events.jsonl"),
) {
  if (!existsSync(path)) return;
  const cursorPath = path + ".cursor";
  const cursor: { offset: number; lineHash: string; pendingEnd?: number } =
    existsSync(cursorPath)
      ? JSON.parse(readFileSync(cursorPath, "utf8"))
      : { offset: 0, lineHash: "" };
  const data = readFileSync(path);
  if (cursor.offset > data.length || (cursor.pendingEnd ?? 0) > data.length)
    throw new PermanentShippingFault("log_truncated");
  if (cursor.offset) {
    const start = data.lastIndexOf("\n", cursor.offset - 2) + 1;
    if (hash(data.subarray(start, cursor.offset - 1)) !== cursor.lineHash)
      throw new PermanentShippingFault("cursor_mismatch");
  }
  const end = cursor.pendingEnd ?? data.lastIndexOf("\n") + 1;
  if (end <= cursor.offset) return;
  const persist = () => {
    writeFileSync(cursorPath + ".tmp", JSON.stringify(cursor), { mode: 0o600 });
    const fd = openSync(cursorPath + ".tmp", "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(cursorPath + ".tmp", cursorPath);
    const dir = openSync(dirname(cursorPath), "r");
    try {
      fsyncSync(dir);
    } finally {
      closeSync(dir);
    }
  };
  cursor.pendingEnd = end;
  persist();
  const lines = data
    .subarray(cursor.offset, end)
    .toString("utf8")
    .trimEnd()
    .split("\n");
  const tokens = lines.map(hash);
  const rows = lines.map((line, i) => {
    let e;
    try {
      e = JSON.parse(line);
      if (typeof e.at !== "string" || !Number.isFinite(Date.parse(e.at)) ||
          typeof e.op !== "string" || typeof e.stage !== "string") throw Error();
    } catch { throw new PermanentShippingFault("malformed_event"); }
    return {
      ts: e.at.replace("T", " ").replace("Z", ""),
      op: e.op,
      stage: e.stage,
      payload: line,
      event_id: tokens[i],
    };
  });
  await ch.insert(
    "fable_switch_events",
    rows,
    "fable-" + hash(tokens.join("\n")),
  );
  cursor.offset = end;
  cursor.lineHash = tokens.at(-1)!;
  delete cursor.pendingEnd;
  persist();
}
export async function shipBestEffort(
  ch: Pick<ClickHouse, "insert">,
  log: (message: string) => void,
  path?: string,
) {
  try {
    await shipEvents(ch, path);
  } catch (error) {
    log(error instanceof PermanentShippingFault
      ? `fable: event shipping permanent fault (${error.code}); operator repair required; durable batch retained`
      : "fable: event shipping unavailable; durable batch retained for retry");
  }
}
