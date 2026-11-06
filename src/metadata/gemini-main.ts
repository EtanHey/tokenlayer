import { writeErr, writeOut } from "../lib/egress";
import { reason, ProjectionError } from "./output";
import { exportGeminiJson } from "./gemini-export";
if(import.meta.main) {
  try {
    const [manifest,out,...extra]=process.argv.slice(2);
    if(!manifest || !out || extra.length) throw new ProjectionError("GEMINI_ARGUMENTS_INVALID");
    const r=exportGeminiJson(manifest,out);
    writeOut(JSON.stringify({status:r.status,exportComplete:r.exportComplete,complete:r.complete,consumption:r.consumption,records:r.records,rawHistoryAcceptance:r.rawHistoryAcceptance}));
    process.exitCode=2; // metadata only; no source/origin acceptance
  } catch(error) {writeErr(`REJECTED:${reason(error)}; no consumable output claimed`);process.exitCode=1;}
}
