import { lstatSync, realpathSync } from "node:fs";
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
  for (const output of outputs.map(realPath)) {
    if (sources.some(input => output === input || output.startsWith(input.endsWith(sep) ? input : input + sep))) throw Error("output overlaps an input");
  }
}
