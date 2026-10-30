import { readFileSync, writeFileSync } from "node:fs";
import type { ClickHouse } from "../lib/clickhouse";
import type { ExistingCount } from "./pipeline";
import { sanitizeOutput } from "../lib/egress";

/** Parse ClickHouse TabSeparatedWithNames without changing escaped paths or stream identities. */
export function parseExisting(text: string): ExistingCount[] {
  const [header, ...lines] = text.trimEnd().split(/\r?\n/);
  const keys = header.split("\t");
  if (!["machine", "session_id", "generation", "content_hash", "count"].every(k => keys.includes(k)) || !keys.some(k => k === "path" || k === "stream")) throw Error("invalid --existing export header");
  const escapes: Record<string, string> = { "\\": "\\", "'": "'", t: "\t", n: "\n", r: "\r", b: "\b", f: "\f", "0": "\0", a: "\x07", v: "\v" };
  const unescape = (value: string) => value.replace(/\\(.)/g, (_, c: string) => escapes[c] ?? c);
  return lines.filter(Boolean).map((line): ExistingCount => {
    const values = line.split("\t"), r = Object.fromEntries(keys.map((k, i) => [k, unescape(values[i] ?? "")]));
    if (values.length !== keys.length || !/^(m1|m4)$/.test(r.machine) || !r.session_id || !(r.path || r.stream) || !r.generation || !/^[a-f0-9]{64}$/.test(r.content_hash) || !/^\d+$/.test(r.count) || !Number.isSafeInteger(Number(r.count)) || Number(r.count) < 1) throw Error(sanitizeOutput(`invalid --existing export row: machine=${r.machine} path=${r.path || r.stream} generation=${r.generation}`));
    return [r.machine, r.session_id, r.path || r.stream, r.content_hash, Number(r.count)];
  });
}

export function readExisting(path: string | undefined): ExistingCount[] {
  if (!path) throw Error("requires --existing ClickHouse occurrence export; local live files are not coverage");
  return parseExisting(readFileSync(path, "utf8"));
}

/** Read only server metadata; never load credentials from session files or overwrite an output. */
export async function exportExisting(client: ClickHouse, out: string): Promise<void> {
  if (!/^[a-zA-Z_][a-zA-Z_0-9]*$/.test(client.config.database)) throw Error("invalid ClickHouse database identifier");
  const sql = readFileSync(new URL("./existing.sql", import.meta.url), "utf8").replaceAll("{database:Identifier}", `\`${client.config.database}\``);
  const text = await client.exec(sql);
  parseExisting(text); // Fail closed if a file's owner cannot be established; no placeholders.
  writeFileSync(out, text, { flag: "wx" });
}
