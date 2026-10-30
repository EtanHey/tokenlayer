import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema } from "../../src/lib/schema";
import { shipOnce, type ShipOptions } from "../../src/ship/ship";
import { loadState } from "../../src/ship/state";
import { clickhouseBinary, startLocalClickHouse, type LocalClickHouse } from "../../src/lib/local-clickhouse";

export function propertyCount(env: Record<string, string | undefined> = process.env): number {
  const value = env.TOKENLAYER_PROPERTY_N ?? "40";
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error("TOKENLAYER_PROPERTY_N must be a positive integer");
  }
  return Number(value);
}

/** Independent synthetic trials get reproducible PRNG streams and bounded server/process load. */
async function trials(count: number, seed: number, run: (index: number, random: () => number) => Promise<void>) {
  let next = 0;
  const results = await Promise.allSettled(Array.from({ length: 4 }, async () => {
    while (next < count) {
      const index = next++;
      let state = seed ^ Math.imul(index + 1, 0x9e3779b1);
      const random = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state >>> 0; };
      await run(index, random);
    }
  }));
  // Drain every lane before test cleanup stops the shared synthetic server.
  for (const result of results) if (result.status === "rejected") throw result.reason;
}

export function registerRewriteTests(mode: "normal" | "property"): void {
  const count = propertyCount();
  describe.skipIf(!clickhouseBinary())(`ship → real local ClickHouse: rewrites, rotation, replays (${mode})`, () => {
    let ch: LocalClickHouse;
    let dir: string;

    beforeAll(async () => {
      ch = await startLocalClickHouse();
      await applySchema(ch.client);
      dir = mkdtempSync(join(tmpdir(), "tokenlayer-ship-it2-"));
    }, 40_000);
    afterAll(async () => {
      await ch?.stop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    });

    /** Each test gets its own machine name and root, so assertions never see another test's rows. */
    const setup = (machine: string, batchBytes?: number) => {
      const root = join(dir, machine);
      mkdirSync(join(root, "p"), { recursive: true });
      const o: ShipOptions = {
        machine,
        roots: [{ kind: "claude", dir: root }],
        clickhouse: ch.client,
        statePath: join(dir, `${machine}.state.json`),
        rateBytesPerSec: 0,
        batchBytes,
      };
      return { file: join(root, "p", "s.jsonl"), o };
    };
    const line = (text: string, extra: Record<string, unknown> = {}) =>
      JSON.stringify({ type: "user", sessionId: "s", timestamp: new Date().toISOString(), message: { role: "user", content: text }, ...extra });
    const finalRows = (machine: string) =>
      ch.client.queryJSON<{ generation: string; byte_offset: string; harness: string; content: string }>(
        `SELECT generation, byte_offset, harness, JSONExtractString(raw, 'message', 'content') AS content
         FROM tokenlayer.session_events FINAL WHERE machine = '${machine}' ORDER BY ingested_at, byte_offset`,
      );

    const killAt = async (o: ShipOptions, phase: string, batch: number) => {
      const { clickhouse, ...options } = o;
      const child = Bun.spawn([process.execPath, join(import.meta.dir, "../support/ship-crash-child.ts"),
        JSON.stringify({ config: clickhouse.config, options, phase, batch })], { stdout: "pipe", stderr: "pipe" });
      const reader = child.stdout.getReader();
      const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
      try {
        let output = "";
        while (!output.includes("CRASH_BOUNDARY")) {
          const chunk = await reader.read();
          if (chunk.done) throw new Error(`crash boundary not reached: ${await new Response(child.stderr).text()}`);
          output += new TextDecoder().decode(chunk.value);
        }
        child.kill("SIGKILL");
        await child.exited;
        expect(child.signalCode).toBe("SIGKILL");
      } finally {
        clearTimeout(timer);
        child.kill("SIGKILL");
        await child.exited;
        reader.releaseLock();
      }
    };

    const crashTrial = async (name: string, lost: boolean, phases: string[], rewriteAt = 1, width = 8, killBatch = 1) => {
      const { file, o } = setup(name, 1);
      const snapshot = () => ch.client.queryJSON<{ generation: string; byte_offset: string; raw: string; harness: string }>(
        `SELECT generation, byte_offset, raw, harness FROM tokenlayer.session_events FINAL
         WHERE machine = '${name}' ORDER BY generation, byte_offset`);
      const source = (middle: string) => ["common", "original-middle", "tail"].map((s, i) =>
        line(i === rewriteAt ? middle : s, { timestamp: "2026-10-28T08:00:00Z" })).join("\n") + "\n";
      writeFileSync(file, `${line("old")}\n${line("old-tail")}\n`);
      await shipOnce(o);
      const old = await snapshot();
      const original = source("a".repeat(width));
      writeFileSync(file, original);
      if (lost) {
        await shipOnce(o);
        rmSync(o.statePath);
      } else {
        // Last insert acknowledged, checkpoint still belongs to the previous generation.
        await killAt({ ...o, batchBytes: 1024 * 1024 }, "after", 1);
      }
      const protectedPrefix = loadState(`${o.statePath}.generations`).files[file];
      const archived = await snapshot();
      expect(archived).toHaveLength(5);
      for (const phase of phases) {
        await killAt(o, phase, killBatch);
        const current = await snapshot();
        for (const row of archived) expect(current).toContainEqual(row);
        const journal = loadState(`${o.statePath}.generations`).files[file];
        expect([journal.offset, journal.fingerprint]).toEqual([protectedPrefix.offset, protectedPrefix.fingerprint]);
      }
      const replacement = source("b".repeat(width));
      expect(Buffer.byteLength(replacement)).toBe(Buffer.byteLength(original));
      writeFileSync(file, replacement);
      const result = await shipOnce(o);
      const rows = await snapshot();
      for (const row of archived) expect(rows).toContainEqual(row);
      expect(result.resets).toBe(1);
      expect(rows.filter((r) => r.generation === old[0].generation)).toEqual(old);
      expect(rows.filter((r) => r.generation === protectedPrefix.generation)).toHaveLength(3);
      expect(rows).toHaveLength(8);
      expect(loadState(o.statePath).files[file].generation).not.toBe(protectedPrefix.generation);
      expect((await shipOnce(o)).lines).toBe(0);
    };

    if (mode === "normal") {
      for (const lost of [false, true]) for (const phase of ["before", "after"]) {
        test(`interrupted recovery preserves archives: ${lost ? "lost" : "stale"} checkpoint, ${phase} insert`, async () => {
          await crashTrial(`it-crash-${lost}-${phase}`, lost, [phase]);
        }, 60_000);
      }

    }

    test(`${count} seeded random kill/rewrite trials preserve every archived generation through repeated crashes`, async () => {
      await trials(count, 0x56914481, async (i, random) => {
        const phases = Array.from({ length: 2 + random() % 2 }, () => random() % 2 ? "before" : "after");
        await crashTrial(`it-property-${i}`, Boolean(random() % 2), phases, 1 + random() % 2, 8 + random() % 200, 1 + random() % 2);
      });
    }, 600_000);

    test(`${count} random operation sequences keep every acknowledged row unchanged in FINAL`, async () => {
      let kills = 0, comparisons = 0, completed = 0;
      const boundaries = ["journal-before", "before", "after", "checkpoint"];
      await trials(count, 0x1a55afee, async (trial, random) => {
        const { file, o } = setup(`it-immutable-${trial}`, 128 + random() % 2048);
        o.saveEveryMs = -1;
        const source = (revision = 0) => Array.from({ length: 3 + random() % 4 }, (_, i) => line(`r${revision}-${i}-${"x".repeat(random() % 30)}`,
          { entrypoint: "cli", timestamp: "2026-10-28T08:00:00Z" })).join("\n") + "\n";
        writeFileSync(file, source());
        writeFileSync(`${file}.parked`, source());
        const acknowledged = new Set<string>();
        const check = async () => {
          const rows = await ch.client.queryJSON<Record<string, unknown>>(
            `SELECT * EXCEPT ingested_at FROM tokenlayer.session_events FINAL WHERE machine = '${o.machine}'`);
          const current = new Set(rows.map((row) => JSON.stringify(row)));
          for (const row of acknowledged) { expect(current.has(row)).toBe(true); comparisons++; }
          for (const row of current) acknowledged.add(row);
        };
        const ship = async () => { await shipOnce(o); await check(); };
        await ship();
        const operations = ["rotate", "reuse", "reuse", "head", "middle", "tail", "lose", ...boundaries];
        for (let i = operations.length - 1; i > 0; i--) {
          const j = random() % (i + 1);
          [operations[i], operations[j]] = [operations[j], operations[i]];
        }
        for (const [revision, op] of operations.entries()) {
          if (op === "rotate") {
            renameSync(file, `${file}.old-${revision}`);
            writeFileSync(file, source(revision));
          } else if (op === "reuse") {
            const inode = statSync(`${file}.parked`).ino;
            renameSync(file, `${file}.swap`);
            renameSync(`${file}.parked`, file);
            renameSync(`${file}.swap`, `${file}.parked`);
            expect(statSync(file).ino).toBe(inode);
          } else if (op === "lose") {
            rmSync(o.statePath, { force: true });
            if (random() % 2) rmSync(`${o.statePath}.generations`, { force: true });
          } else if (boundaries.includes(op)) {
            appendFileSync(file, line(`crash-${revision}`, { entrypoint: "cli", timestamp: "2026-10-28T08:00:00Z" }) + "\n");
            await killAt(o, op, 1);
            kills++;
            await check();
          } else {
            const lines = readFileSync(file, "utf8").trimEnd().split("\n");
            const index = op === "head" ? 0 : op === "tail" ? lines.length - 1 : Math.floor(lines.length / 2);
            lines[index] = line(`rewrite-${revision}-${"y".repeat(random() % 40)}`, { entrypoint: "cli", timestamp: "2026-10-28T08:00:00Z" });
            writeFileSync(file, lines.join("\n") + "\n");
          }
          await ship();
        }
        if (++completed % 25 === 0) console.log(`immutable property: ${completed}/${count} sequences, ${kills} SIGKILLs, ${comparisons} row comparisons`);
      });
      expect(completed).toBe(count);
      expect(kills).toBe(4 * count);
    }, 1_800_000);

    if (mode === "normal") {
      test("checkpoint loss after a rewrite preserves both archived generations", async () => {
        const { file, o } = setup("it-recovery");
        writeFileSync(file, `${line("old")}\n${line("old-tail")}\n`);
        await shipOnce(o);
        const archived = await finalRows(o.machine);
        writeFileSync(file, `${line("new")}\n`);
        await shipOnce(o);
        const revised = await finalRows(o.machine);
        rmSync(o.statePath);
        await shipOnce(o);
        const rows = await finalRows(o.machine);
        expect(rows.filter((r) => r.generation === archived[0].generation)).toEqual(archived);
        expect(rows).toHaveLength(3);
        expect(rows.find((r) => r.content === "new")?.generation).toBe(revised.find((r) => r.content === "new")?.generation);
      });

      test("late harness detection after a rewrite keeps its revision", async () => {
        const { file, o } = setup("it-revision-harness");
        writeFileSync(file, `${line("old")}\n`);
        await shipOnce(o);
        const [archived] = await finalRows(o.machine);
        writeFileSync(file, `${line("new")}\n`);
        await shipOnce(o);
        const revision = (await finalRows(o.machine)).find((r) => r.content === "new")!.generation;
        appendFileSync(file, `${line("sdk", { entrypoint: "sdk-ts" })}\n`);
        await shipOnce(o);
        const rows = await finalRows(o.machine);
        expect(rows.filter((r) => r.generation === archived.generation)).toEqual([archived]);
        expect(rows.filter((r) => r.generation === revision).map((r) => [r.content, r.harness])).toEqual([["new", "t3"], ["sdk", "t3"]]);
      });

      test("a rewrite before insert acknowledgement cannot certify unshipped bytes", async () => {
        const { file, o } = setup("it-ack-rewrite");
        const old = `${line("old")}\n`;
        const replacement = old.replace('"old"', '"new"');
        writeFileSync(file, old);
        const insert = ch.client.insert.bind(ch.client);
        o.clickhouse = Object.create(ch.client);
        let rewrite = true;
        o.clickhouse.insert = async (...args) => {
          await insert(...args);
          if (rewrite) { rewrite = false; writeFileSync(file, replacement); }
        };
        await shipOnce(o);
        const result = await shipOnce(o);
        expect(result).toMatchObject({ lines: 1, resets: 1 });
        const rows = await finalRows(o.machine);
        expect(rows.map((r) => r.content).sort()).toEqual(["new", "old"]);
        expect(new Set(rows.map((r) => r.generation)).size).toBe(2);
      });

      test("a late harness decision replaces the first chunk even when its byte range is unchanged", async () => {
        const { file, o } = setup("it-late", 1);
        writeFileSync(file, `${JSON.stringify({ type: "queue-operation", sessionId: "s", timestamp: new Date().toISOString() })}\n`);
        await shipOnce(o);
        appendFileSync(file, `${line("two", { entrypoint: "sdk-ts" })}\n`);
        await shipOnce(o);
        expect((await finalRows("it-late")).map((r) => [Number(r.byte_offset), r.harness])).toEqual([
          [0, "t3"],
          [expect.any(Number), "t3"],
        ]);
      });

      test("a same-inode equal-size rewrite is shipped, and the earlier generation is kept", async () => {
        const { file, o } = setup("it-rewrite", 1);
        writeFileSync(file, `${line("old")}\n${line("two")}\n`);
        await shipOnce(o);
        writeFileSync(file, `${line("new")}\n${line("two")}\n`);
        const r = await shipOnce(o);
        expect(r.resets).toBe(1);
        const rows = await finalRows("it-rewrite");
        expect(rows.map((x) => x.content).sort()).toEqual(["new", "old", "two", "two"]);
        expect(new Set(rows.map((x) => x.generation)).size).toBe(2);
      });

      test("rotation to a backup name keeps the archived history of the old file", async () => {
        const { file, o } = setup("it-rotate");
        writeFileSync(file, `${line("old")}\n`);
        await shipOnce(o);
        renameSync(file, `${file}.bak`);
        writeFileSync(file, `${line("new")}\n`);
        await shipOnce(o);
        expect((await finalRows("it-rotate")).map((x) => x.content).sort()).toEqual(["new", "old"]);
      });

      test("returning a previously rewritten inode cannot overwrite its original archive", async () => {
        const { file, o } = setup("it-returning-inode");
        const source = (head: string) => [head, "tail"].map((s) => line(s, { timestamp: "2026-10-28T08:00:00Z" })).join("\n") + "\n";
        writeFileSync(file, source("old"));
        const inode = statSync(file).ino;
        await shipOnce(o);
        const archived = await finalRows(o.machine);
        writeFileSync(file, source("new"));
        await shipOnce(o);
        renameSync(file, `${file}.parked`);
        writeFileSync(file, source("other"));
        await shipOnce(o);
        renameSync(file, `${file}.replacement`);
        renameSync(`${file}.parked`, file);
        expect(statSync(file).ino).toBe(inode);
        await shipOnce(o);
        const rows = await finalRows(o.machine);
        for (const row of archived) expect(rows).toContainEqual(row);
        // Hashes protect both contents under the deliberately reused generation/offset.
        expect(rows.filter((r) => r.generation === archived[0].generation && Number(r.byte_offset) === 0)
          .map((r) => r.content).sort()).toEqual(["new", "old"]);
      });

      test("the documented activity query counts a replay with shifted chunk boundaries once", async () => {
        const { file, o } = setup("it-activity");
        const assistant = (i: number) =>
          JSON.stringify({
            type: "assistant",
            sessionId: "s",
            cwd: "/Users/u/Gits/golems",
            timestamp: new Date().toISOString(),
            message: { id: `msg_${i}`, role: "assistant", model: "claude-opus-5-5", usage: { input_tokens: 1, output_tokens: 10 } },
          });
        await ch.client.exec("SYSTEM STOP MERGES tokenlayer.session_events");
        try {
          writeFileSync(file, `${assistant(1)}\n`);
          await shipOnce(o);
          rmSync(o.statePath);
          appendFileSync(file, `${assistant(2)}\n`);
          await shipOnce(o);
          const [{ physical }] = await ch.client.queryJSON<{ physical: string }>(
            "SELECT count() AS physical FROM tokenlayer.session_events WHERE machine = 'it-activity'",
          );
          expect(Number(physical)).toBe(3);

          const doc = await Bun.file(join(import.meta.dir, "..", "..", "docs", "telemetry.md")).text();
          const activity = [...doc.matchAll(/```sql\n([\s\S]*?)```/g)].map((m) => m[1]).find((q) => q.includes("tokenlayer.v_session_events_context"));
          expect(activity).toBeDefined();
          const [agg] = await ch.client.queryJSON<{ events: string; output: string }>(
            `SELECT sum(events) AS events, sum(output_tokens) AS output FROM (${activity}) WHERE machine = 'it-activity'`,
          );
          expect([Number(agg.events), Number(agg.output)]).toEqual([2, 20]);
        } finally {
          await ch.client.exec("SYSTEM START MERGES tokenlayer.session_events");
        }
      });
    }
  });

}
