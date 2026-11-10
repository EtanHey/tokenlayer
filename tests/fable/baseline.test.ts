import { test, expect } from "bun:test";
import { migrate, digest } from "../../src/fable/baseline";
import { models, state, fakeHub } from "./fixtures";

test("legacy ID baseline and pending op migrate under attested inventory", async () => {
  const hub = fakeHub(),
    raw = {
      ...state(),
      schemaVersion: 1,
      baseline: { a: null, b: null },
      ops: { old: "pending" },
    };
  const authority = { identities: new Set(hub.obs.map(digest)), models };
  const migrated = await migrate(raw as never, hub, authority);
  expect(migrated.schemaVersion).toBe(2);
  expect(migrated.baseline.a.models).toEqual(models);
  expect(migrated.baseline.b.auth_index).toBe("b");
  expect(migrated.pending?.op).toBe("old");
  expect(migrated.pending?.plan.desired.b.excluded_models).toEqual([
    "claude-fable-*",
  ]);
  expect(migrated.applied).toBe("APPLYING");
  hub.obs[1].auth_index = "replacement";
  await expect(migrate(raw as never, hub, authority)).rejects.toThrow(
    "inventory",
  );
  hub.obs[1].auth_index = "b";
  hub.catalog = async () => [...models, "claude-fable-unattested"];
  await expect(migrate(raw as never, hub, authority)).rejects.toThrow(
    "catalog changed",
  );
  expect(hub.calls).toEqual([]);
});

test("legacy OFF import tolerates catalog drift without adoption", async () => {
  const hub = fakeHub(),
    raw = {
      ...state(),
      mode: "off",
      schemaVersion: 1,
      baseline: { a: null, b: null },
    };
  const authority = { identities: new Set(hub.obs.map(digest)), models };
  hub.catalog = async () => [...models.slice(0, 2), "claude-fable-added"];
  const s = await migrate(raw as never, hub, authority);
  expect(s.requested.mode).toBe("off");
  expect(s.baseline.a.models).toEqual(models);
  expect(hub.calls).toEqual([]);
});
