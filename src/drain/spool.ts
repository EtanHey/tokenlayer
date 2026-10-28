import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { join } from "node:path";
import { sha256Hex } from "../lib/hash";

export type SpoolBatch = { token: string; rows: unknown[] };

/**
 * Write-ahead spool for drained usage records. The usage queue is destructive on read, so every
 * popped page is fsynced here before any insert; a batch leaves the spool only after ClickHouse
 * accepted it. Each batch carries a fixed dedup token so a retry after an ambiguous failure is a no-op.
 */
export class Spool {
  readonly file: string;
  readonly rejectsFile: string;

  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.file = join(dir, "spool.ndjson");
    this.rejectsFile = join(dir, "rejects.ndjson");
  }

  batches(): SpoolBatch[] {
    if (!existsSync(this.file)) return [];
    const out: SpoolBatch[] = [];
    const torn: string[] = [];
    for (const line of readFileSync(this.file, "utf8").split("\n")) {
      if (!line) continue;
      try {
        const b = JSON.parse(line) as SpoolBatch;
        if (typeof b.token === "string" && Array.isArray(b.rows)) out.push(b);
        else torn.push(line);
      } catch {
        torn.push(line);
      }
    }
    if (torn.length) {
      for (const line of torn) this.reject({ reason: "torn spool line", line });
      this.rewrite(out);
    }
    return out;
  }

  pending(): number {
    return this.batches().length;
  }

  /** Durably append a batch; returns its dedup token. */
  append(rows: unknown[]): string {
    const payload = JSON.stringify(rows);
    const token = sha256Hex(`${Date.now()}:${process.pid}:${Math.random()}:${payload}`);
    const fd = openSync(this.file, "a", 0o600);
    try {
      writeSync(fd, `${JSON.stringify({ token, rows })}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return token;
  }

  /** Send batches oldest-first; stop at the first failure. Returns the number of batches sent. */
  async flush(send: (rows: unknown[], token: string) => Promise<void>): Promise<number> {
    const all = this.batches();
    let sent = 0;
    try {
      for (const b of all) {
        await send(b.rows, b.token);
        sent++;
      }
    } finally {
      if (sent > 0) this.rewrite(all.slice(sent));
    }
    return sent;
  }

  reject(entry: Record<string, unknown>): void {
    appendFileSync(this.rejectsFile, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, { mode: 0o600 });
  }

  private rewrite(batches: SpoolBatch[]): void {
    const tmp = `${this.file}.tmp`;
    const fd = openSync(tmp, "w", 0o600);
    try {
      writeSync(fd, batches.map((b) => `${JSON.stringify(b)}\n`).join(""));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, this.file);
  }
}
