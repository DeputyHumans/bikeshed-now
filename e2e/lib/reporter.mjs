// SPDX-License-Identifier: Apache-2.0
// A node:test reporter writing one JSONL result per case, with its stable id, N, status and evidence dir (SPEC §12).

/**
 * Used by run.mjs as a second reporter:
 *   --test-reporter=./e2e/lib/reporter.mjs --test-reporter-destination=<runDir>/invocations/<invId>/results-<tier>.jsonl
 *
 * One line per test case (suites and the per-file wrapper are left out):
 *   {id, file, name, path, n, trial, suite, runId, status, todo, outcome,
 *    skipReason, inconclusive, durationMs, error, evidenceDir, at}
 *
 *   id      `<file relative to the repo>::<name path joined by " > ">`, stable
 *           across runs, which is what `report compare` joins on
 *   status  pass | fail | skip | todo | inconclusive | not-reproduced
 *   outcome for a todo (a known defect): failed-as-expected or
 *           passed-unexpectedly — the second is how a fixed defect shows up;
 *           "not-reproduced" for a not-reproduced case
 *   inconclusive  the reason, for a case scenario() ended with
 *           ctx.inconclusive(): a skip whose reason starts "INCONCLUSIVE:",
 *           or a diagnostic `outcome=inconclusive:<reason>`. Never a pass.
 *
 * NOT REPRODUCED (the plan's class U): a known defect's case that ended with
 * ctx.notReproduced(reason) — its trial never reached the defect's window (a
 * natural race that did not race), so it says neither that the defect is
 * there nor that it is fixed. node:test sees a skip whose reason is
 * formatNotReproduced(defect, reason), `NOT REPRODUCED (known defect "S4"):
 * <reason>`, and a diagnostic `outcome=not-reproduced:{"defect","reason"}`;
 * either makes the record `status: "not-reproduced"`, `outcome:
 * "not-reproduced"`, with two keys only such a record has: `defect` (the
 * scenario's, or null when the text named none) and `notReproduced` (the
 * reason). `todo` and `skipReason` are null. Never a pass, never a fail;
 * node --test exits as for a skip.
 *
 * A FAILED case is "fail" even if it also carries a skip directive.
 *
 * node:test emits a case's diagnostics AFTER its pass/fail event, at the same
 * nesting, so each case is held until the next event of its file and an
 * `evidence=<dir>` diagnostic (from scenario()) is attached to it.
 *
 * A FILE THAT FAILS AS A WHOLE. Under process isolation node:test runs each
 * spec file as a test of its own, named after the file, and that wrapper
 * fails with no case to show for it when:
 *   - the file's --test-timeout fires (Node 22 bounds the FILE with it: the
 *     case running then, and every case after it, never report);
 *   - the file's process fails outside any case: an import or top-level
 *     throw, a failing top-level before()/after() hook (reported under the
 *     file's name too), a crash.
 * Such cases used to vanish: the summary counted what had reported ("7 cases
 * … 0 fail") while node --test exited 1. So the reporter keeps every
 * top-level case the file DECLARED (`test:enqueue`) and every one that
 * STARTED (`test:dequeue`), and when the file fails it turns each one that
 * never reported into a FAIL record whose error has code E2E_FILE_CANCELLED
 * (CANCELLED_CODE) and the message
 *   "cancelled: file timeout (<node's message>) while this case ran"
 *   "cancelled: file timeout (<node's message>) before this case started"
 * ("cancelled: the spec file failed (…)" for any failure but the timeout),
 * with `cancelled: {reason: "file-timeout"|"file-failed", started, by}`. The
 * subtests the running case had already reported keep their path under it.
 * When every declared case did report, the failure is one FAIL record of its
 * own, `<file>::(file)` (FILE_RECORD_NAME), with `fileFailure: {failureType,
 * by, cancelledCases}` and in `detail` the tail of the file's stderr and its
 * diagnostics that belong to no case, redacted (http.mjs) and capped. A case
 * that --test-name-pattern filtered out is never enqueued, so never one of
 * these. The wrapper names the file as it was given and the cases by the
 * path its process loaded (through a symlink they differ), so both are keyed
 * by realpath (fileKey). Records are written as before; only these are new.
 */

import { realpathSync } from "node:fs";
import { relative, resolve } from "node:path";
import { REPO_ROOT } from "./paths.mjs";
import { LEAK_RE, redactString } from "./http.mjs";

const N_RE = /\[N=(\d+)\]/;
const TRIAL_RE = /\s#(\d+)$/;

/** The name of the record a whole-file failure gets when no case of it was left unreported. */
export const FILE_RECORD_NAME = "(file)";
/** The error code of a case its file's failure cancelled, and of a whole-file failure's record. */
export const CANCELLED_CODE = "E2E_FILE_CANCELLED";
/** At most this many lines of a failed file's stderr and stray diagnostics in its record's `detail`, each at most DETAIL_MAX_CHARS. */
export const DETAIL_MAX_LINES = 30;
export const DETAIL_MAX_CHARS = 500;

function serializeError(e) {
  if (!e) return null;
  const cause = e.cause && typeof e.cause === "object" ? e.cause : null;
  const real = cause ?? e;
  const out = {
    message: String(real.message ?? e.message ?? e).slice(0, 4000),
    code: real.code ?? e.code ?? null,
    failureType: e.failureType ?? null,
  };
  if (real.operator) out.operator = real.operator;
  if (real.stack) out.stack = String(real.stack).split("\n").slice(0, 15).join("\n");
  return out;
}

export function relFile(file) {
  if (!file) return null;
  const r = relative(REPO_ROOT, file);
  return r.startsWith("..") ? file : r;
}

/** Build one record from a test:pass/test:fail event and its name path. */
export const INCONCLUSIVE_PREFIX = "INCONCLUSIVE:";

/** The status and outcome of a known defect's case that ended with ctx.notReproduced() (the plan's class U). */
export const NOT_REPRODUCED = "not-reproduced";
/** How the skip reason of such a case starts. */
export const NOT_REPRODUCED_PREFIX = "NOT REPRODUCED";
const NOT_REPRODUCED_RE = /^NOT REPRODUCED(?: \(known defect ("(?:[^"\\]|\\.)*")\))?:\s*([\s\S]*)$/;

/**
 * The skip reason scenario() gives a not-reproduced case: `NOT REPRODUCED
 * (known defect "S4"): <reason>` (the defect JSON-quoted, so any name reads
 * back), or `NOT REPRODUCED: <reason>` when `defect` is null.
 * @param {string|null} defect
 * @param {string} reason
 * @returns {string}
 */
export function formatNotReproduced(defect, reason) {
  const why = String(reason ?? "").replace(/\s+/g, " ").trim() || "no reason given";
  return defect == null ? `${NOT_REPRODUCED_PREFIX}: ${why}` : `${NOT_REPRODUCED_PREFIX} (known defect ${JSON.stringify(String(defect))}): ${why}`;
}

/**
 * formatNotReproduced read back: `{defect, reason}` (defect null when the
 * text names none), or null for any other text (a skip, an INCONCLUSIVE).
 * @param {unknown} text
 * @returns {{defect: string|null, reason: string}|null}
 */
export function parseNotReproduced(text) {
  if (typeof text !== "string") return null;
  const m = NOT_REPRODUCED_RE.exec(text);
  if (!m) return null;
  let defect = null;
  if (m[1] != null) {
    try {
      defect = JSON.parse(m[1]);
    } catch {
      return null;
    }
  }
  return { defect, reason: m[2].trim() || "no reason given" };
}

/** The diagnostic's payload, `{"defect","reason"}` as JSON, read back as parseNotReproduced's shape, or null. */
function notReproducedPayload(json) {
  try {
    const v = JSON.parse(json);
    if (!v || typeof v !== "object" || typeof v.reason !== "string") return null;
    return { defect: typeof v.defect === "string" ? v.defect : null, reason: v.reason.trim() || "no reason given" };
  } catch {
    return null;
  }
}

export function recordFor(type, data, path, env = process.env) {
  const file = relFile(data.file);
  const name = data.name;
  const n = N_RE.exec(name);
  const trial = TRIAL_RE.exec(name);
  const skip = data.skip !== undefined && data.skip !== false;
  const todo = data.todo !== undefined && data.todo !== false;
  const failed = type === "test:fail";
  const skipText = skip ? (typeof data.skip === "string" ? data.skip : "skipped") : null;
  const inconclusive = skip && !failed && skipText.startsWith(INCONCLUSIVE_PREFIX) ? skipText.slice(INCONCLUSIVE_PREFIX.length).trim() : null;
  const notReproduced = skip && !failed && !todo && inconclusive == null ? parseNotReproduced(skipText) : null;
  let status = failed ? "fail" : "pass";
  if (todo) status = "todo";
  else if (inconclusive != null) status = "inconclusive";
  else if (notReproduced) status = NOT_REPRODUCED;
  else if (skip && !failed) status = "skip";
  const rec = {
    id: `${file ?? "?"}::${path.join(" > ")}`,
    file,
    name,
    path,
    n: n ? Number(n[1]) : null,
    trial: trial ? Number(trial[1]) : 1,
    suite: env.E2E_SUITE ?? null,
    runId: env.E2E_RUN_ID ?? null,
    status,
    todo: todo ? (typeof data.todo === "string" ? data.todo : true) : null,
    outcome: todo ? (type === "test:fail" ? "failed-as-expected" : "passed-unexpectedly") : notReproduced ? NOT_REPRODUCED : null,
    skipReason: status === "skip" ? skipText : null,
    inconclusive,
    durationMs: data.details?.duration_ms ?? null,
    error: type === "test:fail" ? serializeError(data.details?.error) : null,
    evidenceDir: null,
    at: new Date().toISOString(),
  };
  // Only a not-reproduced record has these keys: every other record keeps its old shape.
  if (notReproduced) Object.assign(rec, { defect: notReproduced.defect, notReproduced: notReproduced.reason });
  return rec;
}

/** Make `rec` a not-reproduced record (the diagnostic arrived; its skip text may have said otherwise). */
function markNotReproduced(rec, nr) {
  rec.status = NOT_REPRODUCED;
  rec.outcome = NOT_REPRODUCED;
  rec.todo = null;
  rec.skipReason = null;
  rec.inconclusive = null;
  rec.defect = nr.defect ?? rec.defect ?? null;
  rec.notReproduced = nr.reason;
}

const realpaths = new Map();
/**
 * One spec file's key, whatever spelling an event uses: node names the
 * per-file wrapper after the path as it was GIVEN (relative, or through a
 * symlink such as /var → /private/var), and the cases after the path the
 * file process loaded, so both go through realpath (cached; a path that does
 * not resolve keys as itself).
 */
export function fileKey(file) {
  if (typeof file !== "string" || file === "") return file ?? null;
  let key = realpaths.get(file);
  if (key === undefined) {
    try {
      key = realpathSync(resolve(file));
    } catch {
      key = resolve(file);
    }
    realpaths.set(file, key);
  }
  return key;
}

/**
 * Whether an event is about the spec FILE rather than a case in it: the
 * per-file wrapper node:test makes under process isolation (named after the
 * file as it was given, so relative, absolute or through a symlink), or the
 * file's own root test (a top-level hook's failure), named after its path.
 */
export function isFileEvent(data) {
  const file = data?.file;
  if (!file || data.nesting !== 0 || typeof data.name !== "string" || data.name === "") return false;
  if (data.name === file) return true;
  // A case is never named like an existing path to its own spec file; only then is it resolved.
  if (!data.name.includes("/") && !data.name.endsWith(".mjs") && !data.name.endsWith(".js")) return false;
  return fileKey(data.name) === fileKey(file);
}

/** One line of a failed file's `detail`: redacted, capped, withheld when a credential shape survives. */
function detailLine(text) {
  const line = redactString(String(text).replace(/\s+$/, "")).slice(0, DETAIL_MAX_CHARS);
  return LEAK_RE.test(line) ? "‹line withheld: a credential shape survived redaction›" : line;
}

/** The message of a whole-file failure's record: node's own, then the detail lines that say most. */
function fileFailureMessage(by, detail) {
  const said = detail.filter((l) => l.trim() && !/^\s+at /.test(l) && !/^Node\.js v\d/.test(l) && !/^\s*\^+\s*$/.test(l)).slice(-6);
  return `the spec file failed outside any case: ${by}${said.length ? ` — ${said.map((l) => l.trim()).join(" | ")}` : ""}`;
}

/**
 * Name paths for one top-level case and its subtests. They complete
 * children first, so walk the group backwards: each one's parent is then the
 * most recent case seen one level up. (`test:start` is not forwarded from
 * the per-file child processes, so it cannot be used for this.)
 */
function resolvePaths(group) {
  const stack = [];
  for (let i = group.length - 1; i >= 0; i -= 1) {
    const { rec, nesting } = group[i];
    stack.length = nesting;
    stack[nesting] = rec.name;
    rec.path = stack.slice(0, nesting + 1).map((s) => s ?? "?");
    rec.id = `${rec.file ?? "?"}::${rec.path.join(" > ")}`;
  }
}

const bump = (map, key, by = 1) => map.set(key, (map.get(key) ?? 0) + by);

export default async function* reporter(source) {
  // Both maps are keyed by fileKey(): the wrapper and the cases may spell the file differently.
  const groups = new Map(); // file -> [{rec, nesting, suite}] since the last top-level case
  // file -> what the file declared, started and reported at the top level, and its stray output
  const files = new Map();
  const state = (key) => {
    let st = files.get(key);
    if (!st) {
      st = { file: null, order: [], enqueued: new Map(), started: new Map(), reported: new Map(), detail: [], failures: [], cancelledAny: false };
      files.set(key, st);
    }
    return st;
  };
  const note = (key, text) => {
    const st = state(key);
    for (const l of String(text).split("\n")) if (l.trim()) st.detail.push(detailLine(l));
    if (st.detail.length > DETAIL_MAX_LINES) st.detail.splice(0, st.detail.length - DETAIL_MAX_LINES);
  };
  const emit = function* (key) {
    const group = groups.get(key);
    if (!group || group.length === 0) return;
    groups.delete(key);
    resolvePaths(group);
    for (const { rec, suite } of group) if (!suite) yield `${JSON.stringify(rec)}\n`;
  };

  /** The file failed as a whole: a FAIL record for each declared top-level case that never reported. */
  const fileFailed = function* (key, data) {
    const st = state(key);
    st.file ??= data.file;
    const err = data.details?.error ?? null;
    const real = err?.cause && typeof err.cause === "object" ? err.cause : err;
    const failureType = err?.failureType ?? null;
    const by = String(real?.message ?? err?.message ?? "the file's test failed").slice(0, 1000);
    const timeout = failureType === "testTimeoutFailure";
    const started = [];
    const waiting = [];
    for (const name of st.order) {
      const missing = (st.enqueued.get(name) ?? 0) - (st.reported.get(name) ?? 0);
      if (missing <= 0) continue;
      const running = Math.min(Math.max((st.started.get(name) ?? 0) - (st.reported.get(name) ?? 0), 0), missing);
      for (let i = 0; i < missing; i += 1) {
        const wasStarted = i < running;
        const message = `cancelled: ${timeout ? "file timeout" : "the spec file failed"} (${by}) ${wasStarted ? "while this case ran" : "before this case started"}`;
        const rec = recordFor("test:fail", { file: st.file, name, nesting: 0, details: { error: { message, code: CANCELLED_CODE, failureType } } }, [name]);
        rec.cancelled = { reason: timeout ? "file-timeout" : "file-failed", started: wasStarted, by };
        (wasStarted ? started : waiting).push(rec);
      }
      bump(st.reported, name, missing);
    }
    if (started.length + waiting.length === 0) {
      st.failures.push({ failureType, by });
      return;
    }
    st.cancelledAny = true;
    const group = groups.get(key);
    if (group?.length && group[group.length - 1].nesting > 0) {
      // The running case's own subtests reported; it is their parent.
      for (const rec of started) group.push({ rec, nesting: 0, suite: false });
      yield* emit(key);
    } else {
      yield* emit(key);
      for (const rec of started) yield `${JSON.stringify(rec)}\n`;
    }
    for (const rec of waiting) yield `${JSON.stringify(rec)}\n`;
  };

  for await (const event of source) {
    const { type, data = {} } = event;
    const file = data.file ?? null;
    const key = fileKey(file);
    if (type === "test:enqueue" || type === "test:dequeue") {
      if (file && data.nesting === 0 && typeof data.name === "string" && !isFileEvent(data)) {
        const st = state(key);
        st.file ??= file;
        if (type === "test:enqueue") {
          if (!st.enqueued.has(data.name)) st.order.push(data.name);
          bump(st.enqueued, data.name);
        } else {
          bump(st.started, data.name);
        }
      }
      continue;
    }
    if (type === "test:stderr") {
      if (file) note(key, data.message ?? "");
      continue;
    }
    if (type === "test:diagnostic") {
      const group = file ? groups.get(key) : null;
      const msg = String(data.message ?? "");
      const ev = /^evidence=(.+)$/.exec(msg);
      const inc = /^outcome=inconclusive:(.*)$/.exec(msg);
      const nrm = /^outcome=not-reproduced:(.*)$/.exec(msg);
      if (group && (ev || inc || nrm)) {
        const owner = [...group].reverse().find((g) => g.nesting === data.nesting) ?? group[group.length - 1];
        if (ev) owner.rec.evidenceDir = relFile(ev[1]);
        if (inc && owner.rec.status !== "fail" && owner.rec.status !== "todo") {
          owner.rec.status = "inconclusive";
          owner.rec.inconclusive = inc[1].trim() || owner.rec.inconclusive || "no reason given";
          owner.rec.skipReason = null;
        }
        const nr = nrm ? notReproducedPayload(nrm[1]) : null;
        if (nr && owner.rec.status !== "fail" && owner.rec.status !== "todo" && owner.rec.status !== "inconclusive") markNotReproduced(owner.rec, nr);
      } else if (file && data.nesting === 0 && !ev && !inc && !nrm) {
        note(key, msg);
      }
      continue;
    }
    if (type === "test:pass" || type === "test:fail") {
      if (isFileEvent(data)) {
        // The per-file wrapper (or the file's root): never a case of its own.
        if (type === "test:fail") yield* fileFailed(key, data);
        continue;
      }
      // A top-level case's diagnostics follow it; a new event means the
      // previous top-level case of this file is complete.
      const group = groups.get(key);
      if (group?.length && group[group.length - 1].nesting === 0) yield* emit(key);
      const rec = recordFor(type, data, [data.name]);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ rec, nesting: data.nesting ?? 0, suite: data.details?.type === "suite" });
      if (file && (data.nesting ?? 0) === 0) {
        const st = state(key);
        st.file ??= file;
        bump(st.reported, data.name);
      }
      continue;
    }
    if (type === "test:summary" && file) yield* emit(key);
  }
  for (const key of [...groups.keys()]) yield* emit(key);
  // A failure of the file that cancelled no case: one record of its own.
  for (const st of files.values()) {
    if (st.failures.length === 0) continue;
    const by = st.failures.map((f) => f.by).join("; ");
    const failureType = st.failures[0].failureType;
    const rec = recordFor("test:fail", { file: st.file, name: FILE_RECORD_NAME, nesting: 0, details: { error: { message: fileFailureMessage(by, st.detail), code: CANCELLED_CODE, failureType } } }, [FILE_RECORD_NAME]);
    rec.fileFailure = { failureType, by, cancelledCases: st.cancelledAny };
    rec.detail = [...st.detail];
    yield `${JSON.stringify(rec)}\n`;
  }
}
