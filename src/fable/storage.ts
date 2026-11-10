import {
  writeFileSync,
  renameSync,
  mkdirSync,
  openSync,
  closeSync,
  fsyncSync,
  appendFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { State } from "./core";
export const statePath = () =>
  process.env.TOKENLAYER_FABLE_STATE ??
  join(homedir(), ".config/tokenlayer/fable-switch.json");
export function save(s: State, path = statePath()) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = path + "." + process.pid + ".tmp";
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeFileSync(fd, JSON.stringify(s));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  const dir = openSync(dirname(path), "r");
  try {
    fsyncSync(dir);
  } finally {
    closeSync(dir);
  }
}
/** Kernel lock is shared with dashboard writers and released automatically on process death. */
export async function locked<T>(
  fn: () => Promise<T>,
  path = statePath(),
): Promise<T> {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const { dlopen, FFIType } = await import("bun:ffi");
  const lib = dlopen(
    process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6",
    { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } },
  );
  const fd = openSync(path + ".lock", "a", 0o600);
  try {
    for (let i = 0; lib.symbols.flock(fd, 6) !== 0; i++) {
      if (i >= 100) throw Error("controller busy");
      await Bun.sleep(100);
    }
    return await fn();
  } finally {
    lib.symbols.flock(fd, 8);
    closeSync(fd);
    lib.close();
  }
}
export function event(value: unknown) {
  const path =
    process.env.TOKENLAYER_FABLE_EVENTS ??
    join(homedir(), ".local/state/tokenlayer/fable/events.jsonl");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const fd = openSync(path, "a", 0o600);
  try {
    appendFileSync(fd, JSON.stringify(value) + "\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
