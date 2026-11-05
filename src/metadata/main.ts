import { project } from "./run";
if (import.meta.main) {
  const [manifest, out, ...rest] = process.argv.slice(2);
  if (!manifest || !out || rest.length) {
    console.error("Usage: bun src/metadata/main.ts <pinned-input-manifest.json> <fresh-private-output-directory>");
    process.exitCode = 1;
  } else {
    try {
      const r = await project(manifest, out);
      console.log(JSON.stringify({ status: r.status, complete: r.complete, records: r.records,
        projected: r.projected, uninspected: r.uninspected, candidates: r.candidates }));
      process.exitCode = r.complete ? 0 : 2;
    } catch { console.error("UNRESOLVED: invalid scope/pins or unsafe output; no completion claimed"); process.exitCode = 1; }
  }
}
