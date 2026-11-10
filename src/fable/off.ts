import { inventory, type State, type Observation } from "./core";
import { expansionOrder } from "./transitions";
import { migrate } from "./baseline";
import type { ExecutorHub } from "./io";
import { save, event } from "./storage";

/** OFF checks current catalogs, never the historical adoption snapshot. */
export async function offReadback(
  s: State,
  hub: ExecutorHub,
): Promise<Observation[]> {
  if (!inventory(s, await hub.observations()))
    throw Error("credential inventory changed");
  const catalogs: Record<string, string[]> = {};
  for (const id of Object.keys(s.baseline))
    catalogs[id] = await hub.catalog(id);
  const registry = await hub.registry();
  const obs = await hub.observations();
  if (!inventory(s, obs)) throw Error("credential inventory changed");
  const current = [
    ...new Set([...registry, ...Object.values(catalogs).flat()]),
  ];
  if (
    !registry.length ||
    obs.some(
      (c) =>
        !catalogs[c.id].length ||
        Object.hasOwn(c, "priority") ||
        current.some((m) => !catalogs[c.id].includes(m)),
    )
  )
    throw Error("OFF readback unconfirmed");
  return obs.map((c) => ({ ...c, catalog: catalogs[c.id] }));
}

/** Caller holds the lock. Save intent before the first network await, including during legacy import. */
export async function restoreOff(
  s: State,
  hub: ExecutorHub,
  op: string,
  persist = (s: State) => save(s),
  emit = event,
) {
  s.mode = "off";
  s.requested = { ...s.requested, mode: "off" };
  s.applied = "APPLYING";
  s.reason = "OFF requested; restoring normal routing";
  persist(s);
  try {
    Object.assign(s, await migrate(s, hub));
    const before = await hub.observations();
    if (!inventory(s, before)) throw Error("credential inventory changed");
    const desired = Object.fromEntries(
      Object.keys(s.baseline).map((id) => [
        id,
        { excluded_models: null, priority: null },
      ]),
    );
    s.pending = {
      op,
      plan: { desired, applied: "OFF", reason: "off", exceptions: {} },
    };
    s.ops[op] = "pending";
    persist(s);
    const obs: Observation[] = [];
    for (const c of before) {
      // A failed catalog read must not prevent an OFF restore attempt.
      let catalog: string[] = [];
      try {
        catalog = await hub.catalog(c.id);
      } catch {
        /* Verify after restoration. */
      }
      obs.push({ ...c, catalog });
    }
    // Null both rules even when effective catalogs already look complete: latent rules can exist.
    for (const id of expansionOrder(s, obs, desired)) {
      if (!inventory(s, await hub.observations()))
        throw Error("credential inventory changed");
      emit({
        op,
        id,
        stage: "off",
        status: "intent",
        fields: desired[id],
        at: new Date().toISOString(),
      });
      try {
        await hub.patch(id, desired[id]);
      } catch {
        /* Ambiguous writes require readback below. */
      }
    }
    await offReadback(s, hub);
    s.policy = { desired, exceptions: {} };
    s.applied = "OFF";
    s.reason = "off";
    delete s.pending;
    for (const key of Object.keys(s.ops))
      if (s.ops[key] === "pending") delete s.ops[key];
    s.ops[op] = "done";
    const done = Object.keys(s.ops).filter((key) => s.ops[key] === "done");
    for (const key of done.slice(0, -200)) delete s.ops[key];
    emit({
      op,
      stage: "off",
      status: "readback",
      at: new Date().toISOString(),
    });
    persist(s);
  } catch (error) {
    s.applied = "UNKNOWN";
    s.reason =
      error instanceof Error ? error.message : "OFF readback unconfirmed";
    persist(s);
    throw error;
  }
}
