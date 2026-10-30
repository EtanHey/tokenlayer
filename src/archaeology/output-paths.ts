import { closeSync, lstatSync, openSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join, resolve, sep } from "node:path";

/** Resolve existing symlinks, including ancestors of a not-yet-created output. */
function realPath(path: string): string {
  const absolute = resolve(path);
  try { lstatSync(absolute); }
  catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    return join(realPath(dirname(absolute)), basename(absolute));
  }
  return realpathSync(absolute);
}

export function assertOutputsSeparate(outputs: string[], inputs: string[]): void {
  const sources = inputs.map(realPath);
  const identity = (path: string) => {
    try { const st = statSync(path, { bigint: true }); return `${st.dev}:${st.ino}`; }
    catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return null; throw error; }
  };
  const inodes = new Set(sources.map(identity).filter(value => value !== null));
  for (const output of outputs.map(realPath)) {
    const inode = identity(output);
    if ((inode !== null && inodes.has(inode)) || sources.some(input => output === input || output.startsWith(input.endsWith(sep) ? input : input + sep))) throw Error("output overlaps an input");
  }
  for (const output of outputs) assertSafeOutput(output);
}

/** Refuse links at the target and symlinked ancestors, even when unrelated to inputs. */
export function assertSafeOutput(path: string): void {
  const target = resolve(path);
  for (let current = target; ; current = dirname(current)) {
    try {
      const st = lstatSync(current);
      if (st.isSymbolicLink() || current === target && st.isFile() && st.nlink > 1) throw Error("output must not be symlinked or hardlinked");
    } catch (error) { if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error; }
    if (dirname(current) === current) break;
  }
}

/** Replace the directory entry; never open an existing target for writing. */
export function atomicOutput(path: string, value: string): void {
  assertSafeOutput(path);
  const temporary = join(dirname(path), `.${basename(path)}-${randomUUID()}`);
  const fd = openSync(temporary, "wx", 0o600);
  try { writeFileSync(fd, value); } finally { closeSync(fd); }
  assertSafeOutput(path);
  renameSync(temporary, path);
}
