import { writeErr, writeOut } from "../lib/egress";
import { reason, ProjectionError } from "./output";
import { exportGeminiJson } from "./gemini-export";
if(import.meta.main) {
  let committed=false, warned=false;
  const deliveryFailed=()=>{
    process.exitCode=committed?2:1;
    if(!warned) {
      warned=true;
      try {writeErr(committed?"COMMITTED:SUMMARY_DELIVERY_FAILED; validate the final manifest":"REJECTED:SUMMARY_DELIVERY_FAILED");} catch {} // delivery cannot undo the publication result
    }
  };
  process.stdout.on("error",deliveryFailed);
  process.stderr.on("error",()=>{process.exitCode=committed?2:1;});
  try {
    const [manifest,out,...extra]=process.argv.slice(2);
    if(!manifest || !out || extra.length) throw new ProjectionError("GEMINI_ARGUMENTS_INVALID");
    const r=exportGeminiJson(manifest,out);
    committed=true;process.exitCode=2; // metadata committed; no source/origin acceptance
    writeOut(JSON.stringify({status:r.status,exportComplete:r.exportComplete,complete:r.complete,consumption:r.consumption,records:r.records,rawHistoryAcceptance:r.rawHistoryAcceptance}));
  } catch(error) {
    if(committed) deliveryFailed();
    else {process.exitCode=1;try {writeErr(`REJECTED:${reason(error)}; no consumable output claimed`);} catch {}}
  }
}
