import { ClickHouse, type ClickHouseConfig } from "./clickhouse";

/**
 * Fetch errors raised before the request left this machine: the name did not resolve, or nothing
 * accepted the TCP connection. ClickHouse never saw the request, so retrying is safe for any statement.
 * A reset or timeout can come after the server read the request, so those are not retried here.
 */
const UNSENT_CODES = new Set(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED"]);

/** The store could not be reached after every retry; nothing was sent. */
export class StoreUnreachableError extends Error {
  constructor(readonly code: string, message: string, readonly attempts: number) {
    super(message);
    this.name = "StoreUnreachableError";
  }
}

/** Backoff before each retry of an unsent request: a DNS or connect blip after wake usually clears in seconds. */
export const DEFAULT_UNSENT_RETRY_MS: readonly number[] = [1_000, 3_000, 10_000];

/**
 * The ship's client: a Mac reaches the hub over the tailnet, so it retries requests that never left the
 * machine. Kept out of `ClickHouse` so the drain, which runs beside its store on the hub, does not bundle it.
 */
export class RetryingClickHouse extends ClickHouse {
  constructor(config: ClickHouseConfig, readonly unsentRetryMs: readonly number[] = DEFAULT_UNSENT_RETRY_MS) {
    super(config);
  }

  static override fromEnv(env: Record<string, string | undefined> = process.env): RetryingClickHouse {
    return new RetryingClickHouse(ClickHouse.fromEnv(env).config);
  }

  protected override async post(...args: Parameters<ClickHouse["post"]>): Promise<string> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await super.post(...args);
      } catch (err) {
        const code = (err as { code?: unknown }).code;
        if (typeof code !== "string" || !UNSENT_CODES.has(code)) throw err;
        if (attempt >= this.unsentRetryMs.length) throw new StoreUnreachableError(code, (err as Error).message, attempt + 1);
        await Bun.sleep(this.unsentRetryMs[attempt]!);
      }
    }
  }
}
