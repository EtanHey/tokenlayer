import { lstatSync, realpathSync, statSync } from "node:fs";
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
}
