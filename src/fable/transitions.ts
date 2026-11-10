import {
  allowed,
  usable,
  type State,
  type Observation,
  type Fields,
} from "./core";

/** Restore a missing last route first, including when leaving an intentional cap wait. */
export function expansionOrder(
  s: State,
  obs: Observation[],
  desired: Record<string, Fields>,
) {
  const score = (id: string) => {
    const c = obs.find((c) => c.id === id)!;
    return allowed(s.baseline[id].models, desired[id]).filter(
      (m) =>
        !c.catalog?.includes(m) &&
        usable(s, { ...c, catalog: s.baseline[id].models }, m) &&
        !obs.some((other) => usable(s, other, m)),
    ).length;
  };
  return Object.keys(s.baseline).sort((a, b) => score(b) - score(a));
}
