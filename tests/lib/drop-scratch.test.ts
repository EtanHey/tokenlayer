import { expect, test } from "bun:test";
import { ClickHouse } from "../../src/lib/clickhouse";
import { dropScratch } from "../../src/lib/drop-scratch";

class ScratchClient extends ClickHouse {
  statements: string[] = [];
  dependencies: { database: string; name: string; create_table_query: string }[] = [];
  present = ["credentials_snap", "r7_session_events_narrow", "r7_session_events_day"];
  constructor(readonly count: string | Error) {
    super({ url: "http://unused", user: "default", password: "", database: "tokenlayer" });
  }
  override async queryJSON<T>(sql: string): Promise<T[]> {
    if (sql.includes("create_table_query")) return this.dependencies as T[];
    return this.present
      .map(name => ({ name, engine: "Memory", total_rows: 0 })) as T[];
  }
  override async exec(sql: string): Promise<string> {
    this.statements.push(sql);
    if (sql === "SELECT count() FROM tokenlayer.credentials_snap") {
      if (this.count instanceof Error) throw this.count;
      return this.count;
    }
    return "0";
  }
}

for (const count of ["", "abc", "1", new Error("count failed")]) {
  test(`unsafe count ${JSON.stringify(String(count))} refuses without DROP and exits nonzero`, async () => {
    const ch = new ScratchClient(count);
    await expect(dropScratch(ch, true)).rejects.toThrow();
    expect(ch.statements.some(sql => sql.startsWith("DROP"))).toBe(false);
    // Exercise the same fatal-error boundary as the CLI with only a fake connection.
    const script = `
      import { ClickHouse } from "./src/lib/clickhouse";
      import { dropScratch } from "./src/lib/drop-scratch";
      import { installErrorHandlers } from "./src/lib/egress";
      installErrorHandlers();
      ${ScratchClient.toString()}
      await dropScratch(new ScratchClient(${count instanceof Error ? 'new Error("count failed")' : JSON.stringify(count)}), true);
    `;
    const proc = Bun.spawn([process.execPath, "--eval", script], { cwd: import.meta.dir + "/../..", env: process.env,
      stdout: "pipe", stderr: "pipe" });
    const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text(), new Response(proc.stdout).text()]);
    expect(code).not.toBe(0);
    expect(stderr).toContain(count instanceof Error ? "count failed" : count === "1" ? "STOP" : "invalid row count");
  });
}

test("dependency guard recognizes qualified, quoted and unqualified table names in both modes", async () => {
  for (const table of ["credentials_snap", "r7_session_events_narrow", "r7_session_events_day"]) {
    for (const reference of [table, `tokenlayer.${table}`, `\`tokenlayer\`.\`${table}\``, table.toUpperCase()]) {
      for (const apply of [false, true]) {
        const ch = new ScratchClient("0");
        ch.dependencies = [{ database: "other_database", name: "dependent_view",
          create_table_query: `CREATE VIEW other_database.dependent_view AS SELECT * FROM ${reference}` }];
        await expect(dropScratch(ch, apply)).rejects.toThrow("dependent objects");
        expect(ch.statements).toEqual([]);
      }
    }
  }
});

test("apply sends DROP only for tables listed at the start; longer names are not dependencies", async () => {
  const ch = new ScratchClient("0");
  ch.present = ["r7_session_events_day"];
  ch.dependencies = [{ database: "other_database", name: "unrelated",
    create_table_query: "CREATE VIEW other_database.unrelated AS SELECT * FROM credentials_snap_backup" }];
  await dropScratch(ch, true);
  expect(ch.statements.filter(sql => sql.startsWith("DROP"))).toEqual([
    "DROP TABLE IF EXISTS tokenlayer.r7_session_events_day SYNC",
  ]);
});
