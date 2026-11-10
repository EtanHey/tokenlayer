import { expect, test } from "bun:test";
import { execute } from "../../src/fable/io";
import { defaults, metadata, type Metadata } from "../../src/fable/core";
test("expansion barrier, committed then 500, restart, duplicate op", async () => {
  const s = { ...defaults(), baseline: { a: metadata({}), b: metadata({}) } };
  let actual: Record<string, Metadata> = {
    a: metadata({ excluded_models: ["claude-fable-*"] }),
    b: metadata({}),
  };
  const calls: string[] = [];
  let fail = false;
  const hub = {
    metadata: (id: string) => actual[id],
    catalog: async () => [],
    patch: async (id: string, x: unknown) => {
      calls.push(id);
      if (fail) throw Error("rejected");
      actual[id] = metadata({ excluded_models: x });
      throw Error("committed then 500");
    },
  };
  await expect(
    execute(
      s,
      { a: [], b: ["claude-fable-*"] },
      hub,
      "crash",
      () => {},
      () => {},
      async () => {
        throw Error("killed");
      },
    ),
  ).rejects.toThrow("killed");
  expect(actual.a.list ?? []).toEqual([]);
  expect(actual.b.list ?? []).toEqual([]);
  await execute(
    s,
    { a: [], b: ["claude-fable-*"] },
    hub,
    "crash",
    () => {},
    () => {},
  );
  expect(s.ops.crash).toBe("done");
  const n = calls.length;
  await execute(
    s,
    { a: [], b: ["claude-fable-*"] },
    hub,
    "crash",
    () => {},
    () => {},
  );
  expect(calls.length).toBe(n);
  fail = true;
  await expect(
    execute(
      s,
      { a: ["claude-fable-*"], b: [] },
      hub,
      "rejected",
      () => {},
      () => {},
    ),
  ).rejects.toThrow("unconfirmed");
  expect(actual.b.list).toEqual(["claude-fable-*"]);
});
