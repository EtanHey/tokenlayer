import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, realpathSync, statSync, fsyncSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { context, obj, projectRecord } from "./project";
import { hash, records, RECORD_CAP } from "./stream";
import { Budget, ProjectionError, reason } from "./output";

const pin = (v: unknown) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const unresolved = (v: any): boolean => !!v && typeof v === "object" && (v.presence === "UNRESOLVED" || Object.values(v).some(unresolved));
const required = ["custodyMachine", "originMachine", "originProof", "containerDriveId", "containerHash",
  "memberPath", "memberHash", "physicalRepresentationHash"];
function readManifest(path: string) {
  if (statSync(path).size > RECORD_CAP) throw new ProjectionError("MANIFEST_SIZE_BOUND");
  const bytes = readFileSync(path);
  let m: any;
  try { m = JSON.parse(bytes.toString("utf8")); } catch { throw new ProjectionError("MANIFEST_INVALID"); }
  if (!m || m.version !== 1 || typeof m.scope !== "string" || !m.scope.trim() || !Array.isArray(m.sources) ||
    !m.sources.length || m.sources.length > 128) throw new ProjectionError("MANIFEST_SCOPE_INVALID");
  for (const s of m.sources) {
    if (!s || !s.path || !pin(s.inputSha256) || !["codex", "claude"].includes(s.provider) ||
      !["raw", "witness"].includes(s.format) || !["synthetic", "retained", "admitted", "witness"].includes(s.admission) ||
      required.some(k => typeof s[k] !== "string" || !s[k]) || !pin(s.physicalRepresentationHash) ||
      (s.memberHash !== "UNKNOWN" && !pin(s.memberHash)) ||
      (!["UNKNOWN", "NOT_APPLICABLE"].includes(s.containerHash) && !pin(s.containerHash)) ||
      (s.format === "raw" && s.admission !== "synthetic" && !pin(s.admissionEvidenceHash)) ||
      (s.format === "witness" && !pin(s.witnessReceiptHash))) throw new ProjectionError("SOURCE_PINS_INVALID");
    if (s.coordinatesPath && (!pin(s.coordinatesSha256) || s.format !== "raw")) throw new ProjectionError("COORDINATE_PIN_INVALID");
    if (s.format === "raw" && !s.coordinatesPath && (s.physicalRepresentationHash !== s.inputSha256 || s.memberHash !== s.inputSha256))
      throw new ProjectionError("RAW_MEMBER_ADAPTER_REQUIRED");
    if (s.upstreamUninspected !== undefined && (s.format === "raw" || !Array.isArray(s.upstreamUninspected) ||
      s.upstreamUninspected.some((r: any) => !Number.isSafeInteger(r.line) || r.line < 1 || !pin(r.sha256) ||
        !Number.isSafeInteger(r.bytes) || r.bytes < 1) || new Set(s.upstreamUninspected.map((r: any) => r.line)).size !== s.upstreamUninspected.length)) throw new ProjectionError("OMISSION_RECEIPT_INVALID");
  }
  return { m, manifestHash: hash(bytes) };
}
function privateOutput(path: string) {
  // Resolve existing parent first: symlink aliases must not bypass the repository check.
  const out = join(realpathSync(dirname(resolve(path))), resolve(path).split("/").at(-1)!);
  const root = Bun.spawnSync(["git", "-C", dirname(out), "rev-parse", "--show-toplevel"]);
  if (root.exitCode === 0) {
    const ignored = Bun.spawnSync(["git", "-C", root.stdout.toString().trim(), "check-ignore", "--quiet", out]);
    if (ignored.exitCode !== 0) throw new ProjectionError("OUTPUT_NOT_IGNORED");
  }
  mkdirSync(out, { mode: 0o700 }); // exclusive fresh directory; never overwrite a previous receipt
  return out;
}
export async function project(manifestPath: string, outputPath: string) {
  const { m, manifestHash } = readManifest(manifestPath);
  // Before creating outputs, observe the actual destination parent's filesystem.
  const maxRows = m.maxOutputRows ?? 10_000;
  new Budget(realpathSync(dirname(resolve(outputPath))), maxRows);
  const out = privateOutput(outputPath), budget = new Budget(out, maxRows);
  const opened: number[] = [];
  const output = (name: string) => { const fd = openSync(join(out, name), "wx", 0o600); opened.push(fd); return fd; };
  const metadata = output("metadata.ndjson"), candidates = output("candidates.ndjson");
  const metadataHash = createHash("sha256"), candidatesHash = createHash("sha256");
  const receipt: any = { version: 1, scope: m.scope, manifestHash, status: "IN_PROGRESS", complete: false,
    rawHistoryAcceptance: "HOLD", consumption: "NONE", limits: { maxOutputRows: maxRows,
      outputBytes: budget.bytes, scratchBytes: budget.scratchBytes, physicalReserveBytes: 20 * 1024 ** 3 },
    scratch: { synchronous: "OFF", batchRows: 256, committedBatches: 0 }, records: 0, projected: 0, uninspected: 0, candidates: 0,
    peakRetainedRecordBytes: 0, recordCapBytes: RECORD_CAP, sources: [], errors: [] };
  const dbPath = join(out, "candidate-index.sqlite");
  closeSync(openSync(dbPath, "wx", 0o600));
  const db = new Database(dbPath);
  db.exec("PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA cache_size=-1024; PRAGMA temp_store=FILE; CREATE TABLE refs (k TEXT PRIMARY KEY, first_coordinate TEXT)");
  db.exec(`PRAGMA max_page_count=${Math.floor(budget.scratchBytes / 4096)}; BEGIN`);
  let batchRows = 0;
  const commit = () => { budget.check(); db.exec("COMMIT"); receipt.scratch.committedBatches++; batchRows = 0; };
  const get = db.query("SELECT first_coordinate FROM refs WHERE k=?");
  const put = db.query("INSERT INTO refs VALUES (?,?)");
  let closeCoordinates = () => {};
  function emit(row: any) {
    if (receipt.records >= maxRows) throw new ProjectionError("OUTPUT_ROW_CAP");
    const bytes = JSON.stringify(row) + "\n"; budget.write(metadata, bytes); metadataHash.update(bytes); receipt.records++;
    if (++batchRows === 256) { commit(); db.exec("BEGIN"); }
  }
  try {
    for (const s of m.sources) {
      const provenance = Object.fromEntries(required.map(k => [k, s[k]]));
      const source: any = { inputSha256: s.inputSha256, provenance, format: s.format, admission: s.admission,
        admissionEvidenceHash: s.admissionEvidenceHash ?? "UNKNOWN", witnessReceiptHash: s.witnessReceiptHash ?? "NOT_APPLICABLE",
        unresolved: required.filter(k => s[k] === "UNKNOWN"), rows: 0, projected: 0, uninspected: 0 };
      if (s.format === "witness") source.unresolved.push("RAW_FIELDS_AND_COORDINATES_NOT_RECOVERABLE_FROM_EXTRACT");
      receipt.sources.push(source);
      const coordinateScan = { peak: 0, sha256: undefined as string | undefined, stable: undefined as boolean | undefined };
      const coordinateRecords = s.coordinatesPath ? records(s.coordinatesPath, coordinateScan) : undefined;
      closeCoordinates = () => { coordinateRecords?.return(undefined); };
      const earliestGap = Math.min(...(s.upstreamUninspected ?? []).map((r: any) => r.line));
      let previousLine = 0, previousOffset = 0, previousBytes = 0, previousTerminated = true;
      const c = context(), scan: { sha256?: string; stable?: boolean; peak: number } = { peak: 0 };
      for (const r of records(s.path, scan)) {
        if (receipt.records >= maxRows) throw new ProjectionError("OUTPUT_ROW_CAP");
        source.rows++;
        let o: any, status = r.raw ? "PROJECTED" : "UNINSPECTED_OVERSIZE";
        if (r.raw) {
          try { o = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(r.raw)); if (!o || typeof o !== "object" || Array.isArray(o)) status = "UNINSPECTED_NON_OBJECT"; }
          catch { status = "UNINSPECTED_INVALID_JSON"; }
        }
        const witness = s.format === "witness";
        if (witness && status === "PROJECTED" && (!Number.isSafeInteger(o.line) || o.line < 1)) {
          status = "UNINSPECTED_WITNESS_COORDINATE"; source.unresolved.push("COORDINATE_INTEGRITY_MISMATCH");
        }
        const coordinate: any = { inputSha256: s.inputSha256, decodedOffset: witness ? "UNKNOWN" : r.offset,
          originalLFLine: witness ? (Number.isSafeInteger(o?.line) ? o.line : "UNKNOWN") : r.line,
          outputOrdinal: receipt.records + 1, inputLFLine: r.line, inputDecodedOffset: r.offset,
          recordHash: witness ? "UNKNOWN" : r.sha256, inputRecordHash: r.sha256, inputRecordBytes: r.bytes,
          originalRecordBytes: witness ? "UNKNOWN" : r.bytes, terminated: r.terminated };
        if (coordinateRecords) {
          const mapped = coordinateRecords.next();
          let v: any;
          try { v = mapped.done || !mapped.value.raw ? {} : JSON.parse(mapped.value.raw.toString("utf8")); } catch { v = {}; }
          if (!Number.isSafeInteger(v.originalLFLine) || v.originalLFLine < 1 ||
            !Number.isSafeInteger(v.decodedOffset) || v.decodedOffset < v.originalLFLine - 1 ||
            !pin(v.recordHash) || v.recordHash !== r.sha256 || v.recordBytes !== r.bytes ||
            v.originalLFLine <= previousLine || (v.originalLFLine === 1 && v.decodedOffset !== 0) ||
            (previousLine > 0 && (!previousTerminated ||
              v.decodedOffset < previousOffset + previousBytes + v.originalLFLine - previousLine - 1 ||
              (v.originalLFLine === previousLine + 1 && v.decodedOffset !== previousOffset + previousBytes)))) {
            status = "UNINSPECTED_COORDINATE_MISMATCH";
            coordinate.originalLFLine = coordinate.decodedOffset = "UNKNOWN";
            source.unresolved.push("COORDINATE_INTEGRITY_MISMATCH");
          } else {
            if (v.originalLFLine > previousLine + 1) {
              c.continuity = "UNKNOWN_AFTER_UNINSPECTED_RECORD";
              source.unresolved.push("ORIGINAL_LF_GAPS_UNINSPECTED");
            }
            Object.assign(coordinate, { originalLFLine: v.originalLFLine, decodedOffset: v.decodedOffset });
            previousLine = v.originalLFLine; previousOffset = v.decodedOffset;
            previousBytes = r.bytes; previousTerminated = r.terminated;
          }
        }
        if (witness && status === "PROJECTED") {
          if (coordinate.originalLFLine <= previousLine || (s.upstreamUninspected ?? []).some((r: any) => r.line === coordinate.originalLFLine)) {
            source.unresolved.push("COORDINATE_INTEGRITY_MISMATCH"); status = "UNINSPECTED_COORDINATE_MISMATCH";
          }
          previousLine = coordinate.originalLFLine;
          if (coordinate.originalLFLine > earliestGap) c.continuity = "UNKNOWN_AFTER_UNINSPECTED_RECORD";
        }
        const gaps = required.filter(k => s[k] === "UNKNOWN");
        if (witness) gaps.push("RAW_FIELDS_AND_COORDINATES_NOT_RECOVERABLE_FROM_EXTRACT");
        if (c.continuity !== "OBSERVED") gaps.push("CONTEXT_CONTINUITY_UNKNOWN");
        const row: any = { status, provenance, coordinate, gaps };
        if (status === "PROJECTED") {
          Object.assign(row, projectRecord(obj(o), c, s.provider, witness, coordinate));
          if (unresolved(row)) {
            gaps.push("UNSUPPORTED_METADATA_VALUE");
            if (!source.unresolved.includes("UNSUPPORTED_METADATA_VALUE")) source.unresolved.push("UNSUPPORTED_METADATA_VALUE");
          }
          for (const ref of row.stableKeys) {
            const key = `${s.provider}:${ref.kind}:${ref.key}`, first: any = get.get(key);
            if (first) {
              const bytes = JSON.stringify({ status: "CANDIDATE_ONLY_NO_SUBTRACTION", ...ref,
                first: JSON.parse(first.first_coordinate), occurrence: coordinate }) + "\n";
              budget.write(candidates, bytes); candidatesHash.update(bytes); receipt.candidates++;
            } else { budget.check(); put.run(key, JSON.stringify(coordinate)); }
          }
          if ((!c.owner || c.owner.id.presence !== "value" || !c.owner.id.value) && !source.unresolved.includes("OWNING_HEADER_UNKNOWN")) source.unresolved.push("OWNING_HEADER_UNKNOWN");
          if (!c.owner || c.owner.id.presence !== "value" || !c.owner.id.value) gaps.push("OWNING_HEADER_UNKNOWN");
          source.projected++; receipt.projected++;
        } else { gaps.push(status); c.continuity = "UNKNOWN_AFTER_UNINSPECTED_RECORD"; source.uninspected++; receipt.uninspected++; }
        row.fullSourceContinuity = gaps.length || c.continuity !== "OBSERVED" ? "UNKNOWN" : "OBSERVED";
        emit(row);
      }
      if (coordinateRecords) {
        if (!coordinateRecords.next().done) {
          coordinateRecords.return(undefined);
          source.unresolved.push("COORDINATE_COUNT_MISMATCH");
        }
        if (coordinateScan.sha256 !== s.coordinatesSha256 || !coordinateScan.stable) source.unresolved.push("COORDINATE_PIN_OR_STABILITY_MISMATCH");
        source.coordinatesSha256 = coordinateScan.sha256 ?? "UNKNOWN";
      }
      receipt.peakRetainedRecordBytes = Math.max(receipt.peakRetainedRecordBytes, scan.peak, coordinateScan.peak);
      source.observedInputSha256 = scan.sha256;
      if (scan.sha256 !== s.inputSha256 || !scan.stable) source.unresolved.push("INPUT_PIN_OR_STABILITY_MISMATCH");
      for (const r of s.upstreamUninspected ?? []) {
        emit({ status: "UNINSPECTED_UPSTREAM_RECEIPT", provenance, coordinate: { originalLFLine: r.line,
          decodedOffset: "UNKNOWN", outputOrdinal: receipt.records + 1, recordHash: r.sha256,
          originalRecordBytes: r.bytes, witnessReceiptHash: s.witnessReceiptHash },
          gaps: ["UNINSPECTED_UPSTREAM_RECEIPT"], fullSourceContinuity: "UNKNOWN", basis: "UPSTREAM_HASHED_RECEIPT_ONLY" });
        source.uninspected++; receipt.uninspected++;
      }
      source.unresolved = [...new Set(source.unresolved)];
      source.continuity = source.unresolved.length || source.uninspected || c.continuity !== "OBSERVED" ? "UNKNOWN" : "OBSERVED";
      source.gapCoordinates = "metadata.ndjson:coordinate";
    }
    if (batchRows) commit(); else db.exec("COMMIT");
    receipt.status = receipt.uninspected || receipt.sources.some((s: any) => s.unresolved.length) ? "UNRESOLVED" : "SCOPED_PROJECTION_COMPLETE";
    receipt.complete = receipt.status === "SCOPED_PROJECTION_COMPLETE";
    const invalid = receipt.sources.some((s: any) => s.unresolved.some((x: string) => /MISMATCH/.test(x)));
    receipt.consumption = invalid ? "NONE" : receipt.complete ? "SCOPED_METADATA" : "PARTIAL_METADATA_ONLY";
    if (invalid) receipt.status = "INVALID_NON_CONSUMABLE";
  } catch (error) {
    receipt.status = "INVALID_NON_CONSUMABLE"; receipt.complete = false; receipt.consumption = "NONE"; receipt.errors.push(reason(error));
  } finally {
    closeCoordinates();
    receipt.outputs = { metadataSha256: metadataHash.digest("hex"), candidatesSha256: candidatesHash.digest("hex") };
    db.close();
    for (const fd of opened) { try { fsyncSync(fd); } finally { closeSync(fd); } }
    budget.manifest(receipt);
  }
  return receipt;
}
