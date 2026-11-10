import type { State, Observation } from "./core";
export type ResetState = State & {
  resets?: Record<string, { left: number | null; confirmedByEtan: boolean; confirmedZero?: boolean }>;
  resetOps?: Record<
    string,
    {
      account: string;
      index?: string;
      hadCooldown?: boolean;
      recovery: "pending" | "failed" | "recovered" | "not_needed";
      hint: string;
    }
  >;
};
interface ResetHub {
  request(method: string, path: string, body?: unknown): Promise<unknown>;
  observations(): Promise<Observation[]>;
}
/** A press reports a human action already taken; this never presses Anthropic's reset. Caller holds shared lock. */
export async function resetPressed(
  s: ResetState,
  account: string,
  index: string,
  op: string,
  confirmed: boolean,
  hub: ResetHub,
  persist: () => void,
  emit: (e: unknown) => void,
  skipCount = false,
) {
  s.resets ??= {};
  s.resetOps ??= {};
  if (s.resetOps[op] && s.resetOps[op].account !== account)
    throw Error("operation account mismatch");
  if (s.resetOps[op]?.index && s.resetOps[op].index !== index)
    throw Error("operation credential mismatch");
  if (["recovered", "not_needed"].includes(s.resetOps[op]?.recovery)) return;
  if (!s.resetOps[op]) {
    if (!skipCount) {
      // An unconfirmed press cannot establish zero: auto waits until the count is confirmed.
      const prior = s.resets[account];
      s.resets[account] = {
        left:
          confirmed && prior?.confirmedByEtan && prior.left !== null
            ? Math.max(0, prior.left - 1)
            : null,
        confirmedByEtan: confirmed && !!prior?.confirmedByEtan,
        confirmedZero: prior?.confirmedZero ||
          (confirmed && prior?.confirmedByEtan && (prior.left === 1 || prior.left === 0)),
      };
    }
    const before = (await hub.observations()).find(
      (c) => c.email === account || c.id === account,
    );
    if (!before || !Array.isArray(before.cooldowns))
      throw Error("cooldown observation unavailable");
    s.resetOps[op] = {
      account,
      index,
      hadCooldown: before.cooldowns.length > 0,
      recovery: "pending",
      hint: "",
    };
    persist();
    emit({
      op,
      account,
      at: new Date().toISOString(),
      stage: "reset-consumed",
      count: skipCount ? "test-skipped" : (s.resets[account].left ?? "UNKNOWN"),
    });
  }
  try {
    await hub.request("POST", "/routing/cooldown/reset", { auth_index: index });
  } catch {
    /* response loss is ambiguous: read back */
  }
  let recovered = false;
  try {
    const c = (await hub.observations()).find(
      (c) => c.email === account || c.id === account,
    );
    recovered = !!c && Array.isArray(c.cooldowns) && c.cooldowns.length === 0;
  } catch {}
  s.resetOps[op].recovery = recovered
    ? s.resetOps[op].hadCooldown
      ? "recovered"
      : "not_needed"
    : "failed";
  s.resetOps[op].hint = recovered
    ? ""
    : "Retry recovery with the same operation id; reconcile UNKNOWN count with Etan.";
  persist();
  emit({
    op,
    at: new Date().toISOString(),
    stage: "reset-recovery",
    ...s.resetOps[op],
  });
}
