import { hash } from "./stream";
type Obj = Record<string, any>;
export const obj = (x: unknown): Obj => x !== null && typeof x === "object" && !Array.isArray(x) ? x : {};
const own = (o: Obj, k: string) => Object.hasOwn(o, k);
const unknown = (): Obj => ({ presence: "absent" });
export function field(o: Obj, k: string): Obj {
  if (!own(o, k)) return unknown();
  const v = o[k];
  if (v === null) return { presence: "null", value: null };
  if (["string", "number", "boolean"].includes(typeof v) && String(v).length <= 16384)
    return { presence: v === 0 ? "zero" : "value", value: v };
  return { presence: "UNRESOLVED", valueHash: hash(JSON.stringify(v)) };
}
const counterNames = ["input_tokens", "cached_input_tokens", "cache_write_input_tokens", "output_tokens",
  "reasoning_output_tokens", "total_tokens", "cache_read_input_tokens", "cache_creation_input_tokens", "cache_creation"];
function numericTree(v: any, depth = 0, key = ""): boolean {
  return depth <= 8 && (v === null || (typeof v === "number" && Number.isSafeInteger(v)) ||
    (typeof v === "string" && ["service_tier", "inference_geo", "speed"].includes(key) && v.length <= 16384) ||
    (typeof v === "object" && !Array.isArray(v) && Object.entries(v).every(([k, x]) => numericTree(x, depth + 1, k))));
}
/** Preserve native objects, never derive totals/deltas or add subset counters. */
export function usage(o: Obj, key: string, expected = counterNames): Obj {
  if (!own(o, key) || o[key] === null) return field(o, key);
  const value = o[key];
  if (!numericTree(value) || typeof value !== "object") return { presence: "UNRESOLVED", valueHash: hash(JSON.stringify(value)) };
  const fields: Obj = Object.create(null);
  for (const k of new Set([...expected, ...Object.keys(value)])) {
    fields[k] = typeof value[k] === "object" && value[k] !== null ? usage(value, k, k === "cache_creation" ? ["ephemeral_5m_input_tokens", "ephemeral_1h_input_tokens"] : []) : field(value, k);
  }
  return { presence: "value", value, fields };
}
const pick = (o: Obj, keys: string[]) => Object.fromEntries(keys.map(k => [k, field(o, k)]));
export type Context = { owner?: Obj; task?: Obj; turn?: Obj; response?: Obj; model?: Obj; continuity: string };
export const context = (): Context => ({ continuity: "OBSERVED" });
export function projectRecord(o: Obj, c: Context, provider: string, witness: boolean, coordinate: Obj) {
  const p = witness ? o : obj(o.payload), msg = obj(o.message);
  const type = o.type, event = witness ? o.event : p.type;
  const header = type === "session_meta" ? {
    id: field(p, witness ? "declared_session" : own(p, "id") ? "id" : "session_id"), forkParent: field(p, "forked_from_id"),
    birth: field(p, witness ? "meta_timestamp" : "timestamp"),
    metadata: pick(p, ["cwd", "originator", "source", "cli_version", "model", "service_tier", "id", "session_id", "forkedFromId"]), coordinate,
  } : undefined;
  if (!c.owner && provider === "codex" && coordinate.originalLFLine === 1 && header)
    c.owner = { ...header, basis: "original_line_1_header" };
  if (!c.owner && provider === "claude" && typeof o.sessionId === "string" && o.sessionId.length &&
    ["user", "assistant", "system", "progress", "queue-operation"].includes(type))
    c.owner = { id: field(o, "sessionId"), forkParent: field(o, "parentSessionId"), birth: field(o, "timestamp"),
      basis: "first_session_record", coordinate };
  let embeddedHeader;
  if (header && c.owner?.coordinate !== coordinate) embeddedHeader = header;
  if (event === "task_started") { c.task = field(p, "turn_id"); c.response = undefined; }
  if (type === "turn_context") { c.turn = field(p, "turn_id"); c.model = pick(p, ["model", "cwd", "service_tier", "effort"]); }
  if (type === "response_item" && (["function_call", "custom_tool_call"].includes(event) || p.role === "assistant")) {
    // The source packet carries the previous response item's id/call_id on token_count rows.
    c.response = own(p, witness ? "item_id" : "id") && p[witness ? "item_id" : "id"] !== null
      ? { ...field(p, witness ? "item_id" : "id"), basis: "preceding_response_item_id", coordinate }
      : own(p, "call_id") && p.call_id !== null ? { ...field(p, "call_id"), basis: "preceding_call_id", coordinate } : undefined;
  }
  const info = obj(p.info);
  const counterSource = witness ? o : info;
  const nativeUsage = {
    last_token_usage: usage(counterSource, "last_token_usage"),
    total_token_usage: usage(counterSource, "total_token_usage"),
    claude_usage: usage(msg, "usage"), payload_usage: usage(p, "usage"),
  };
  const refs = { ...pick(p, ["response_id", "message_id", "call_id", "turn_id", "task_id"]),
    item_id: field(p, witness ? "item_id" : "id"), message: field(msg, "id"), turn_attribution: field(obj(p.turn_attribution), "turn_id"),
    uuid: field(o, "uuid"), parentUuid: field(o, "parentUuid"), requestId: field(o, "requestId") };
  const responseRef = witness ? field(o, "response_ref") : c.response ?? unknown();
  const stableKeys = Object.entries({ ...refs, ...(witness ? { response_ref: responseRef } : {}) }).flatMap(([kind, v]) =>
    v.presence === "value" && typeof v.value === "string" && v.value.length ? [{ kind, key: hash(`${provider}:${kind}:${v.value}`) }] : []);
  return { type: field(o, "type"), event: witness ? field(o, "event") : field(p, "type"),
    clocks: { ...pick(o, ["timestamp", "created_at", "updated_at"]), payload: pick(p, ["timestamp", "created_at"]),
      witness: witness ? field(o, "ts") : unknown() },
    context: { owner: c.owner ?? { status: "UNKNOWN" }, task: witness ? field(o, "active_turn") : c.task ?? unknown(),
      turn: c.turn ?? unknown(), model: c.model ?? {}, continuity: c.continuity }, embeddedHeader,
    metadata: { outer: pick(o, ["sessionId", "cwd", "version", "entrypoint", "model", "service_tier"]),
      payload: pick(p, ["cwd", "model", "originator", "source", "service_tier"]),
      counter: pick(info, ["model", "service_tier", "model_context_window", "reset", "baseline", "delta_basis", "reset_reason"]), message: pick(msg, ["model", "role", "service_tier"]) },
    refs, responseRef, stableKeys, usage: nativeUsage, basis: "UNKNOWN", deltaBasis: "UNKNOWN",
    presenceBasis: witness ? "EXTRACT_ONLY_RAW_PRESENCE_UNRESOLVED" : "EXACT_ADMITTED_RECORD",
  };
}
