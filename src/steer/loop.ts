import { BACKOFF_CAP_MS, HubError } from "./client";
import type { TickResult } from "./steer";

interface LoopOptions {
  intervalMs: number;
  execute: () => Promise<TickResult>;
  stopping: () => boolean;
  once?: boolean;
  now?: () => number;
  random?: () => number;
  sleep: (ms: number) => Promise<void>;
  log: (message: string) => void;
}

export async function runLoop(opts: LoopOptions): Promise<number> {
  const now = opts.now ?? Date.now;
  let exitCode = 0;
  let failures = 0;
  let lastError = "";
  do {
    const started = now();
    let retryAfterMs = 0;
    try {
      const result = await opts.execute();
      exitCode = result.errors ? 1 : 0;
      retryAfterMs = result.retryAfterMs ?? 0;
    } catch (err) {
      exitCode = 1;
      retryAfterMs = err instanceof HubError ? err.retryAfterMs : 0;
      const message = err instanceof Error ? err.message : "tick failed";
      if (message !== lastError) opts.log(message);
      lastError = message;
    }
    if (exitCode) failures = Math.min(failures + 1, 30);
    else {
      if (failures) opts.log("recovered");
      failures = 0;
      lastError = "";
    }
    if (opts.once) break;
    // Failures wait from completion, even when the tick overruns its interval.
    const exponential = Math.min(BACKOFF_CAP_MS, opts.intervalMs * 2 ** failures);
    const jittered = exponential * (1 + (opts.random ?? Math.random)() * 0.25);
    const wait = failures
      ? Math.min(BACKOFF_CAP_MS, Math.max(retryAfterMs, jittered))
      : Math.max(0, opts.intervalMs - (now() - started));
    await opts.sleep(wait);
  } while (!opts.stopping());
  return exitCode;
}
