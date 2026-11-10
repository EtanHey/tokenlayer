import { createHash } from "node:crypto";
import {
  defaults,
  intent,
  plan,
  same,
  type State,
  type Observation,
  type Baseline,
} from "./core";
import type { ExecutorHub } from "./io";
// Exact identity digests of the lead-attested original inventory; no email-only adoption.
const attested = new Set([
  "b7970328cbb391bb9725e122ca01ed5a45e879b42b8fa566bbe0047fd6446942",
  "79c99edc9285cc2364a56b154cf0a82eec375af05f240065e1e15abb07bf67f2",
]);
// Exact full catalog observed with the original attestation; supports migration from a partial split.
const attestedModels = [
  "claude-3-5-haiku-20241022",
  "claude-3-7-sonnet-20250219",
  "claude-fable-5",
  "claude-fable-5-1",
  "claude-fable-5-2",
  "claude-haiku-4-5-20251001",
  "claude-haiku-5-5",
  "claude-opus-4-1-20250805",
  "claude-opus-4-20250514",
  "claude-opus-4-5-20251101",
  "claude-opus-4-6",
  "claude-opus-4-7",
  "claude-opus-4-8",
  "claude-opus-5",
  "claude-opus-5-5",
  "claude-sonnet-4-20250514",
  "claude-sonnet-4-5-20250929",
  "claude-sonnet-4-6",
  "claude-sonnet-5",
  "claude-sonnet-5-5",
];
const digest = (c: Observation) =>
  createHash("sha256")
    .update(JSON.stringify([c.id, c.name, c.auth_index, c.email]))
    .digest("hex");
export function baseline(
  c: Observation,
  models: string[],
  provenance: string,
): Baseline {
  if (!c.name || !c.auth_index || !c.email || !models.length)
    throw Error("baseline identity required");
  return {
    id: c.id,
    name: c.name,
    auth_index: c.auth_index,
    email: c.email,
    models: [...models],
    excluded_models: null,
    priority: null,
    schemaVersion: 2,
    provenance,
  };
}
/** Caller holds the shared lock. Legacy pending operations are replanned, never replayed blind. */
export async function migrate(
  raw: Partial<State>,
  hub: ExecutorHub,
): Promise<State> {
  const s = { ...defaults(), ...raw } as State;
  if (raw.schemaVersion === 2 && Object.keys(s.baseline).length) return s;
  const obs = await hub.observations();
  if (obs.length !== 2 || obs.some((c) => !attested.has(digest(c))))
    throw Error("credential inventory changed; adopt baseline");
  const catalogs = await Promise.all(obs.map((c) => hub.catalog(c.id)));
  if (
    catalogs.some(
      (models) =>
        !models.length || models.some((m) => !attestedModels.includes(m)),
    )
  )
    throw Error("baseline catalog changed; adopt baseline");
  const final = await hub.observations();
  if (!same(obs.map(digest), final.map(digest)))
    throw Error("credential inventory changed; adopt baseline");
  s.baseline = Object.fromEntries(
    obs.map((c, i) => [
      c.id,
      baseline(
        c,
        attestedModels,
        "lead-attested 2026-11-10 (booleans: no excluded_models/excluded-models/priority keys; disabled false)",
      ),
    ]),
  );
  s.schemaVersion = 2;
  s.requested = intent(s);
  s.applied = "UNKNOWN";
  s.reason = "baseline imported; routing not confirmed";
  delete s.pending;
  const pending = Object.keys(s.ops).find((op) => s.ops[op] === "pending");
  if (pending) {
    s.pending = {
      op: pending,
      plan: plan(
        s,
        obs.map((c, i) => ({ ...c, catalog: catalogs[i] })),
      ),
    };
    s.applied = "APPLYING";
  }
  return s;
}
/** Explicit adoption resets only the named credential, then records its full API catalog. */
export async function adopt(s: State, hub: ExecutorHub, name: string) {
  const before = (await hub.observations()).find(
    (c) => c.id === name || c.name === name,
  );
  if (!before) throw Error("credential not found");
  await hub.patch(before.id, { excluded_models: null, priority: null });
  const models = await hub.catalog(before.id);
  const after = (await hub.observations()).find((c) => c.id === before.id);
  if (!after || digest(before) !== digest(after) || after.priority != null)
    throw Error("baseline adoption unconfirmed");
  for (const [id, b] of Object.entries(s.baseline))
    if (id !== before.id && b.email === before.email) delete s.baseline[id];
  s.baseline[before.id] = baseline(
    after,
    models,
    "explicit CLI baseline adoption",
  );
  s.schemaVersion = 2;
  s.applied = "UNKNOWN";
  s.reason = "baseline adopted; routing not confirmed";
  delete s.pending;
}
