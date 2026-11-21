import { ClickHouse, fixed } from "./clickhouse";
import { installErrorHandlers, writeOut } from "./egress";

const TABLES = ["credentials_snap", "r7_session_events_narrow", "r7_session_events_day"] as const;
type Dependency = { database: string; name: string; create_table_query: string };
type Table = { name: string; engine: string; total_rows: string | number | null };

/** Explicit maintenance step; never called by schema:apply. Uses its same fixed database and login. */
export async function dropScratch(ch: ClickHouse, apply = false): Promise<void> {
  fixed(ch);
  const list = () => ch.queryJSON<Table>(
    "SELECT name, engine, total_rows FROM system.tables WHERE database = 'tokenlayer' ORDER BY name");
  const print = (phase: string, tables: Table[]) => {
    writeOut(`${phase} tokenlayer tables (name, engine, total_rows)`);
    for (const table of tables) writeOut(JSON.stringify(table));
  };
  const before = await list();
  print("BEFORE", before);
  const present = new Set(before.map(table => table.name));
  // View dependencies are not reliably tracked by ClickHouse. Scan definitions across ALL databases.
  // Token boundaries also match quoted and database-qualified identifiers, without matching suffixes.
  const objects = await ch.queryJSON<Dependency>(
    "SELECT database, name, create_table_query FROM system.tables " +
    "WHERE NOT (database = 'tokenlayer' AND name IN ('credentials_snap', 'r7_session_events_narrow', 'r7_session_events_day'))");
  let dependent = false;
  for (const object of objects) for (const table of TABLES) {
    if (!new RegExp(`(^|[^a-z0-9_$])${table}([^a-z0-9_$]|$)`, "i").test(object.create_table_query)) continue;
    writeOut(`DEPENDENT ${object.database}.${object.name} reads ${table}`);
    dependent = true;
  }
  if (dependent) throw new Error("STOP: dependent objects exist; nothing dropped");
  for (const table of TABLES) {
    if (!present.has(table)) {
      writeOut(`${table} absent`);
      continue;
    }
    // Exact count, not system.tables.total_rows (which can be null or approximate).
    const count = (await ch.exec(`SELECT count() FROM tokenlayer.${table}`)).trim();
    if (!/^\d+$/.test(count)) throw new Error(`STOP: invalid row count for ${table}`);
    writeOut(`${table} rows=${count}`);
    // This is the first table checked: no DROP has been sent on refusal.
    if (table === "credentials_snap" && BigInt(count) !== 0n) {
      print("AFTER", await list());
      throw new Error(`STOP: credentials_snap rows=${count}; nothing dropped`);
    }
  }
  if (apply) {
    for (const table of TABLES) if (present.has(table)) await ch.exec(`DROP TABLE IF EXISTS tokenlayer.${table} SYNC`);
  } else {
    writeOut("DRY RUN: nothing dropped; use --apply to drop the three scratch tables");
  }
  print("AFTER", await list());
}

if (import.meta.main) {
  installErrorHandlers();
  const args = process.argv.slice(2);
  if (args.length > 1 || args.some(arg => arg !== "--apply")) {
    throw new Error("usage: bun run schema:drop-scratch [--apply]");
  }
  await dropScratch(ClickHouse.fromEnv(), args.includes("--apply"));
}
