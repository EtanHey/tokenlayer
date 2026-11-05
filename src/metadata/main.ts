import { writeOut, writeErr } from "../lib/egress";
import { reason } from "./output";
import { project } from "./run";
if (import.meta.main) {
  const [manifest, out, ...rest] = process.argv.slice(2);
  if (!manifest || !out || rest.length) {
    writeErr("Usage: bun src/metadata/main.ts <pinned-input-manifest.json> <fresh-private-output-directory>");
    process.exitCode = 1;
  } else {
    try {
      const r = await project(manifest, out);
      writeOut(JSON.stringify({ status: r.status, complete: r.complete, records: r.records,
        projected: r.projected, uninspected: r.uninspected, candidates: r.candidates }));
      process.exitCode = r.complete ? 0 : 2;
    } catch (error) { writeErr(`REJECTED:${reason(error)}; no consumable output claimed`); process.exitCode = 1; }
  }
}
