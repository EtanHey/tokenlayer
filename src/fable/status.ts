import { intent, plan, allowed, same, type State } from "./core";
import { migrate } from "./baseline";
import { observe, type ExecutorHub } from "./io";
import { offReadback } from "./off";

/** Persisted confirmation is historical; independently read actual routing. Does not write. */
export async function status(s: State, hub: ExecutorHub): Promise<State> {
  try {
    s = await migrate(s, hub);
    const obs = s.mode === "off" ? await offReadback(s, hub) : await observe(s, hub);
    const p = plan(s, obs);
    const confirmed = obs.every((c) => s.mode === "off" || (
      same(c.catalog!, allowed(s.baseline[c.id].models, p.desired[c.id])) &&
      (c.priority ?? null) === p.desired[c.id].priority
    ));
    s.applied = confirmed && !s.pending ? p.applied : s.pending ? "APPLYING" : "UNKNOWN";
    s.reason = confirmed ? p.reason : "routing not confirmed";
    s.policy = { desired: p.desired, exceptions: p.exceptions, reserve: p.reserve };
  } catch {
    s.applied = "UNKNOWN";
    s.reason = "readback unavailable or inventory changed";
  }
  s.requested = intent(s);
  return s;
}
