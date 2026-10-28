import type { SteerHub } from "./steer";
import type { Credential } from "./types";

/** CLIProxyAPI v8 management API (internal/api/server_management_v8.go). */
export class HubClient implements SteerHub {
  private readonly base: string;

  constructor(
    baseUrl: string,
    private readonly mgmtKey: string,
    private readonly timeoutMs = 15_000,
  ) {
    this.base = `${baseUrl.replace(/\/+$/, "")}/v8/management`;
  }

  async list(): Promise<Credential[]> {
    const body = (await this.request("GET", "/credentials")) as { files?: Credential[] };
    return body.files ?? [];
  }

  /** Persists `priority` into the credential's auth JSON (PatchAuthFileFields → Manager.Modify → persist). */
  async setPriority(id: string, priority: number): Promise<void> {
    await this.request("PATCH", "/credentials/fields", { name: id, priority });
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.mgmtKey}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) {
      let detail = text;
      try {
        detail = (JSON.parse(text) as { error?: string }).error ?? text;
      } catch {}
      throw new Error(`${method} ${path} -> ${res.status}: ${detail.slice(0, 200)}`);
    }
    return text ? JSON.parse(text) : {};
  }
}
