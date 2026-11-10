import {
  allowed,
  inventory,
  same,
  plan,
  intent,
  usable,
  type State,
  type Observation,
  type Plan,
  type Fields,
} from "./core";
import { save, event } from "./storage";
export { save, event, statePath, locked } from "./storage";
export class Hub {
  constructor(
    readonly url: string,
    private key: string,
  ) {}
  async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    let r: Response;
    try {
      r = await fetch(this.url + "/v8/management" + path, {
        method,
        headers: {
          Authorization: "Bearer " + this.key,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw Error("hub transport failure");
    }
    if (!r.ok) throw Error("hub HTTP " + r.status);
    return r.json();
  }
  async observations(): Promise<Observation[]> {
    return (
      await this.request<{ files: Observation[] }>("GET", "/credentials")
    ).files.filter(
      (c: Observation) =>
        (c.provider ?? c.type) === "claude" && c.account_type === "oauth",
    );
  }
  async catalog(id: string): Promise<string[]> {
    const r = await this.request<{ models: { id: string }[] }>(
      "GET",
      "/credentials/models?name=" + encodeURIComponent(id),
    );
    const models = r.models?.map((m: { id: string }) => m.id);
    if (
      !Array.isArray(models) ||
      !models.length ||
      models.some((m) => typeof m !== "string")
    )
      throw Error("catalog unreadable or empty");
    return [...new Set<string>(models)].sort();
  }
  async patch(id: string, fields: Partial<Fields>) {
    await this.request("PATCH", "/credentials/fields", { name: id, ...fields });
  }
}
export interface ExecutorHub {
  observations(): Promise<Observation[]>;
  catalog(id: string): Promise<string[]>;
  patch(id: string, fields: Partial<Fields>): Promise<void>;
}
/** Inventory is checked around catalog reads; the final observation happens after their last await. */
export async function observe(
  s: State,
  hub: ExecutorHub,
): Promise<Observation[]> {
  if (!inventory(s, await hub.observations()))
    throw Error("credential inventory changed");
  const catalogs: Record<string, string[]> = {};
  for (const id of Object.keys(s.baseline)) {
    catalogs[id] = await hub.catalog(id);
    if (
      !catalogs[id].length ||
      catalogs[id].some((m) => !s.baseline[id].models.includes(m))
    )
      throw Error("catalog unreadable or changed; adopt baseline");
  }
  const obs = await hub.observations();
  if (!inventory(s, obs)) throw Error("credential inventory changed");
  return obs.map((c) => ({ ...c, catalog: catalogs[c.id] }));
}
/** Single writer owns these fields. Effective catalogs cannot prove absence of latent wildcard rules. */
export async function execute(
  s: State,
  proposed: Plan,
  hub: ExecutorHub,
  op: string,
  persist = (s: State) => save(s),
  emit = event,
  proof?: { target: string; fields: Fields },
) {
  s.requested = intent(s);
  const ids = Object.keys(s.baseline);
  const expected = (id: string, fields: Fields) =>
    allowed(s.baseline[id].models, fields);
  const matches = (p: Plan, obs: Observation[]) =>
    ids.every((id) => {
      const c = obs.find((c) => c.id === id)!;
      return (
        same(c.catalog!, expected(id, p.desired[id])) &&
        (c.priority ?? null) === p.desired[id].priority
      );
    });
  try {
    let obs = await observe(s, hub);
    if (
      Object.keys(proposed.desired).length !== ids.length ||
      ids.some((id) => !proposed.desired[id])
    )
      throw Error("desired inventory changed");
    // Never reuse a caller's stale decision for a production policy write.
    const decide = (observations: Observation[]): Plan => {
      if (!proof) return plan(s, observations);
      const c = observations.find((c) => c.id === proof.target);
      if (!c || c.email === s.fableAccount || c.id === s.fableAccount)
        throw Error("proof target must be non-Fable credential");
      // Proof hook is deliberately one-credential-only and never reports ON/OFF.
      return {
        desired: Object.fromEntries(
          observations.map((c) => [
            c.id,
            c.id === proof.target
              ? proof.fields
              : {
                  excluded_models: s.baseline[c.id].models.filter(
                    (m) => !c.catalog!.includes(m),
                  ),
                  priority: c.priority ?? null,
                },
          ]),
        ),
        applied: "UNKNOWN",
        reason: "single-credential executor proof",
        exceptions: {},
      };
    };
    let p = decide(obs);
    if (
      matches(p, obs) &&
      !s.pending &&
      !Object.values(s.ops).includes("pending")
    ) {
      s.policy = {
        desired: p.desired,
        exceptions: p.exceptions,
        reserve: p.reserve,
      };
      s.applied = p.applied;
      s.reason = p.reason;
      persist(s);
      return;
    }
    s.applied = "APPLYING";
    s.reason = "routing change in progress";
    s.ops[op] = "pending";
    s.pending = { op, plan: p };
    persist(s);
    const apply = async (
      id: string,
      fields: Partial<Fields>,
      stage: string,
      target: string[],
    ) => {
      if (proof && id !== proof.target)
        throw Error("proof write outside target refused");
      emit({
        op,
        id,
        stage,
        at: new Date().toISOString(),
        status: "intent",
        fields,
      });
      let ambiguous = false;
      try {
        await hub.patch(id, fields);
      } catch {
        ambiguous = true;
      }
      obs = await observe(s, hub);
      const c = obs.find((c) => c.id === id)!;
      if (
        !same(c.catalog!, target) ||
        ("priority" in fields && (c.priority ?? null) !== fields.priority)
      )
        throw Error("write unconfirmed; catalog or priority mismatch");
      emit({
        op,
        id,
        stage,
        at: new Date().toISOString(),
        status: "readback",
        ambiguous,
        catalog: c.catalog,
        priority: c.priority ?? null,
      });
      persist(s);
    };
    // Phase 1: remove obsolete exclusions everywhere. Retain only concrete restrictions still desired.
    for (const id of ids) {
      const current = obs.find((c) => c.id === id)!.catalog!;
      const wanted = expected(id, p.desired[id]);
      const expanded = [...new Set([...current, ...wanted])];
      if (!same(current, expanded)) {
        const excluded = s.baseline[id].models.filter(
          (m) => !expanded.includes(m),
        );
        await apply(
          id,
          { excluded_models: excluded.length ? excluded : null },
          "expand",
          expanded,
        );
      }
    }
    // Phase 2: priority changes cannot remove a route.
    for (const id of ids) {
      const c = obs.find((c) => c.id === id)!;
      if ((c.priority ?? null) !== p.desired[id].priority)
        await apply(
          id,
          { priority: p.desired[id].priority },
          "priority",
          c.catalog!,
        );
    }
    // Phases 3/4: every restriction gets a fresh decision after the final readback/await.
    for (const id of ids) {
      obs = await observe(s, hub);
      p = decide(obs);
      s.pending!.plan = p;
      const current = obs.find((c) => c.id === id)!.catalog!;
      const target = expected(id, p.desired[id]);
      // Health can change after expansion. A new expansion restarts the barrier next tick.
      if (
        ids.some((key) =>
          expected(key, p.desired[key]).some(
            (m) => !obs.find((c) => c.id === key)!.catalog!.includes(m),
          ),
        )
      )
        throw Error("policy changed; expansion required");
      const removed = current.filter((m) => !target.includes(m));
      const time = Date.now();
      for (const model of removed) {
        if (
          usable(
            s,
            obs.find((c) => c.id === id)!,
            model,
            time,
          ) &&
          !p.exceptions[model] &&
          !obs.some((c) => c.id !== id && usable(s, c, model, time))
        )
          throw Error("last usable route; restriction refused");
      }
      if (removed.length) await apply(id, p.desired[id], "restrict", target);
    }
    obs = await observe(s, hub);
    p = decide(obs);
    if (!matches(p, obs)) throw Error("policy changed; retry required");
    s.policy = {
      desired: p.desired,
      exceptions: p.exceptions,
      reserve: p.reserve,
    };
    s.applied = p.applied;
    s.reason = p.reason;
    s.ops[op] = "done";
    delete s.pending;
    for (const key of Object.keys(s.ops))
      if (s.ops[key] === "pending") delete s.ops[key];
    const finished = Object.keys(s.ops).filter((k) => s.ops[k] === "done");
    for (const key of finished.slice(0, -200)) delete s.ops[key];
    persist(s);
  } catch (error) {
    s.applied = "UNKNOWN";
    s.reason = error instanceof Error ? error.message : "readback unavailable";
    persist(s);
    throw error;
  }
}
