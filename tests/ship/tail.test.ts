import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCompleteLines } from "../../src/ship/tail";

let dir: string;
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), "tokenlayer-tail-"))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("returns complete lines with exact byte offsets and leaves a partial last line unread", () => {
  const f = join(dir, "a.jsonl");
  writeFileSync(f, '{"a":"é"}\n{"b":2}\n{"partial"');
  const r = readCompleteLines(f, 0, 1024);
  expect(r.lines.map((l) => [l.offset, l.text])).toEqual([
    [0, '{"a":"é"}'],
    [11, '{"b":2}'],
  ]);
  expect(r.nextOffset).toBe(19);
  expect(r.raw.toString("utf8")).toBe('{"a":"é"}\n{"b":2}\n');
});

test("resumes from an offset and respects the byte budget on line boundaries", () => {
  const f = join(dir, "b.jsonl");
  writeFileSync(f, "1111\n2222\n3333\n");
  const first = readCompleteLines(f, 0, 7);
  expect(first.lines.map((l) => l.text)).toEqual(["1111"]);
  const rest = readCompleteLines(f, first.nextOffset, 1024);
  expect(rest.lines.map((l) => [l.offset, l.text])).toEqual([
    [5, "2222"],
    [10, "3333"],
  ]);
  expect(rest.nextOffset).toBe(15);
});

test("a single line longer than the budget is still read whole", () => {
  const f = join(dir, "c.jsonl");
  const big = "x".repeat(5000);
  writeFileSync(f, `${big}\nnext\n`);
  const r = readCompleteLines(f, 0, 100);
  expect(r.lines[0].text.length).toBe(5000);
  expect(r.nextOffset).toBe(r.lines.at(-1)!.offset + r.lines.at(-1)!.bytes);
});

test("blank lines advance the offset but are not emitted", () => {
  const f = join(dir, "d.jsonl");
  writeFileSync(f, "a\n\nb\n");
  const r = readCompleteLines(f, 0, 1024);
  expect(r.lines.map((l) => [l.offset, l.text])).toEqual([
    [0, "a"],
    [3, "b"],
  ]);
  expect(r.nextOffset).toBe(5);
});
