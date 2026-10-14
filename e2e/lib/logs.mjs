// SPDX-License-Identifier: Apache-2.0
// Reading a stack's captured logs from a mark onward, with the patience the emulator needs (SPEC §12).

/**
 * The Functions emulator's log flushes late: an `[email] skipped …` line has
 * shown up more than 30 s after the request that caused it. So a wait for a
 * line polls for at least 45 s by default, and an assertion that a line did
 * NOT appear must settle for as long before it can pass.
 *
 * Every read is relative to a MARK (a byte offset taken before the action), so
 * a line written by an earlier test can never satisfy a later one.
 *
 * Log names under e2e/.out/<runId>/logs/:
 *   emulators.log  firebase emulators:start stdout+stderr (function console lines)
 *   mailpit.log    Mailpit
 *   shim.log       the Resend shim's stdout;  shim.jsonl  one line per request
 *   build.log      tree build steps
 *   database-debug.log  the Database emulator's own output, each line led by
 *                  its record's ISO time (debuglogs.mjs drainDatabaseLog: the
 *                  watchdog copies new records in every 15 s, stopStack the
 *                  rest), so a wait on it (`name: "database-debug.log"`) sees
 *                  a line up to a watchdog poll late
 *
 * The Functions emulator's runs (functionRuns, caseFunctionRuns): its own
 * process logs, in emulators.log, `i  functions: Beginning execution of
 * "<region>-<name>"` as it hands a request to a worker, and `i  functions:
 * Finished "<region>-<name>" in <ms>ms` as that answer ends, or `i  Request to
 * function failed: <error>` (no name) when the worker never answered
 * (firebase-tools functionsRuntimeWorker.js RuntimeWorker.request). A Firestore
 * trigger arrives the same way and answers once its code has returned. The
 * lines carry no time and no document, and one process prints them, so their
 * ORDER is the order of those events: two runs overlapped when the second
 * began before the first's end line.
 */

import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { assertPath, logsDir } from "./paths.mjs";

export const MIN_LOG_WAIT_MS = 45_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The path of a named log for a run. */
export function logFile(runId, name = "emulators") {
  return assertPath(join(logsDir(runId), name.includes(".") ? name : `${name}.log`), "logFile");
}

/** Resolve `file` from explicit options or the loaded target. */
function resolveFile(opts) {
  if (opts.file) return assertPath(opts.file, "log file");
  const runId = opts.runId ?? opts.target?.runId ?? process.env.E2E_RUN_ID;
  if (!runId) throw new Error("waitForLog: pass {file}, {runId} or {target}");
  return logFile(runId, opts.name ?? "emulators");
}

/** The current end of a log, to pass as `since`. */
export function logMark(fileOrOpts) {
  const file = typeof fileOrOpts === "string" ? assertPath(fileOrOpts, "log file") : resolveFile(fileOrOpts ?? {});
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

/** Text of a log from byte `since` to its current end. */
export function readLog(file, since = 0) {
  assertPath(file, "log file");
  if (!existsSync(file)) return "";
  const size = statSync(file).size;
  const start = typeof since === "number" ? since : since?.offset ?? 0;
  if (size <= start) return "";
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    return buf.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

export function tailLog(file, lines = 40) {
  const text = readLog(file, Math.max(0, (existsSync(file) ? statSync(file).size : 0) - 64 * 1024));
  return text.split("\n").slice(-lines).join("\n");
}

function toRegExp(pattern) {
  if (pattern instanceof RegExp) return new RegExp(pattern.source, pattern.flags.replace("g", ""));
  return new RegExp(String(pattern).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
}

/**
 * Wait until a line matching `pattern` appears after `since`.
 * @param {RegExp|string} pattern
 * @param {{file?:string, runId?:string, target?:object, name?:string, since?:number, timeout?:number, pollMs?:number}} [opts]
 * @returns {Promise<{line:string, match:RegExpMatchArray, offset:number, waitedMs:number}>}
 */
export async function waitForLog(pattern, opts = {}) {
  const file = resolveFile(opts);
  const since = typeof opts.since === "number" ? opts.since : opts.since?.offset ?? 0;
  const timeout = opts.timeout ?? 60_000;
  const pollMs = opts.pollMs ?? 250;
  const re = toRegExp(pattern);
  const start = Date.now();
  for (;;) {
    const text = readLog(file, since);
    let offset = since;
    for (const line of text.split("\n")) {
      const match = line.match(re);
      if (match) return { line, match, offset, waitedMs: Date.now() - start };
      offset += Buffer.byteLength(line, "utf8") + 1;
    }
    if (Date.now() - start >= timeout) {
      const err = new Error(
        `no line matching ${re} in ${file} after ${timeout} ms (since byte ${since})\n--- tail ---\n${tailLog(file, 30)}`,
      );
      err.code = "E2E_LOG_TIMEOUT";
      throw err;
    }
    await sleep(pollMs);
  }
}

/**
 * Assert a line does NOT appear after `since`, waiting `settle` ms first.
 * Refuses a settle shorter than MIN_LOG_WAIT_MS unless `allowShort` is set,
 * because a short settle passes on a line that is merely late.
 */
export async function expectNoLog(pattern, opts = {}) {
  const settle = opts.settle ?? MIN_LOG_WAIT_MS;
  if (settle < MIN_LOG_WAIT_MS && !opts.allowShort) {
    throw new Error(`expectNoLog: a settle of ${settle} ms cannot prove absence (min ${MIN_LOG_WAIT_MS})`);
  }
  try {
    const hit = await waitForLog(pattern, { ...opts, timeout: settle });
    const err = new Error(`unexpected log line: ${hit.line}`);
    err.code = "E2E_LOG_PRESENT";
    throw err;
  } catch (err) {
    if (err.code === "E2E_LOG_TIMEOUT") return { absent: true };
    throw err;
  }
}

/** Every line matching after `since`, without waiting. */
export function grepLog(pattern, opts = {}) {
  const file = resolveFile(opts);
  const re = toRegExp(pattern);
  return readLog(file, opts.since ?? 0).split("\n").filter((l) => re.test(l));
}

// --- The Functions emulator's runs ----------------------------------------------------------------

/**
 * The product's Firestore triggers (functions/src/index.ts, each built with
 * onDocumentCreated or onDocumentWritten): functionRuns' default `triggers`.
 * selftest/function-runs.test.mjs pins it to the source.
 */
export const FIRESTORE_TRIGGERS = Object.freeze(["onCommentCreated", "recordCommentEvent", "recordThreadEvent", "recordVersionEvent"]);

/**
 * With DEBUG set, the CLI's console logger appends the record's metadata to
 * every line (` {"metadata":{…}}`, logger.js useConsoleLoggers); stacks never
 * set it, and a line with it counts the same.
 */
const DEBUG_TRAILER = String.raw`(?: \{"metadata":.*\})?`;
/** The emulator's line as it hands a run to a worker (RuntimeWorker.request, logInfo). */
const RUN_BEGIN_RE = new RegExp(String.raw`^i {2}functions: Beginning execution of "([^"]+)"${DEBUG_TRAILER}$`);
/** The emulator's line as that run's answer ends (its onFinish, logInfo). */
const RUN_FINISH_RE = new RegExp(String.raw`^i {2}functions: Finished "([^"]+)" in \d+(?:\.\d+)?(?:e[+-]?\d+)?ms${DEBUG_TRAILER}$`);
/** The emulator's line when the worker never answered (its proxy's "error": a kill, or the timeout's destroy): it names no function. */
const RUN_FAILED_RE = /^i {2}Request to function failed: /;
/** A trigger id is `<region>-<name>` (functionsEmulatorShared.js `${region}-${name}`); a grouped export's name keeps its dashes. */
const REGION_ID_RE = /^[a-z]+-[a-z]+\d+-(.+)$/;
/** How much of the log a scan reads at once. */
const RUN_SCAN_CHUNK = 4 * 1024 * 1024;

/** The function's name in a trigger id: the region taken off ("us-central1-onCommentCreated" → "onCommentCreated"). */
const functionName = (id) => REGION_ID_RE.exec(id)?.[1] ?? id;

/** One line of emulators.log as a run's begin, finish or failure, or null. */
function runLine(raw) {
  const c = raw.charCodeAt(0);
  if (c !== 105 /* i */ && c !== 27 /* ESC */) return null;
  let line = c === 27 || raw.includes("\u001b") ? stripVTControlCharacters(raw) : raw;
  if (line.endsWith("\r")) line = line.slice(0, -1);
  let m = RUN_BEGIN_RE.exec(line);
  if (m) return { kind: "begin", name: functionName(m[1]) };
  m = RUN_FINISH_RE.exec(line);
  if (m) return { kind: "finish", name: functionName(m[1]) };
  if (RUN_FAILED_RE.test(line)) return { kind: "failed", name: null };
  return null;
}

/** `triggers` as a Set, or a TypeError naming `who`. */
function triggerSet(triggers, who) {
  const list = typeof triggers === "string" || triggers == null || typeof triggers[Symbol.iterator] !== "function" ? null : [...triggers];
  if (!list || list.some((t) => typeof t !== "string" || t.length === 0)) {
    throw new TypeError(`${who}: triggers is a list of function names (e.g. FIRESTORE_TRIGGERS), got ${typeof triggers === "string" ? JSON.stringify(triggers) : String(triggers)}`);
  }
  return new Set(list);
}

const sortedObject = (map) => Object.fromEntries([...map].filter(([, v]) => v > 0).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

/**
 * How many runs of each function the Functions emulator began in `text`
 * (whole lines of emulators.log, from a mark), and how many of them ran at
 * once, per function, over the Firestore triggers, and over everything else.
 *
 * Read in log order, which is the order the emulator's one process met each
 * run's begin and end: a run is running from its `Beginning execution of`
 * line to its `Finished` line. Every count is a LOWER bound, never more than
 * really ran at once:
 *   - a `Finished "<f>"` line ends one of the text's open runs of f, oldest
 *     or not (they are alike), or is `stray` when none is open: a run begun
 *     before the text. With such a run still open as the text began, its end
 *     may have been taken for a later run's, which then counts as ended early;
 *   - a `Request to function failed` line ends a run it does not name, so it
 *     ends one open run of EVERY function (`failed` counts them).
 * `exact` is true when neither could happen: `openAtStart` (the runs in
 * flight as the text began, which caseFunctionRuns counts from the log's
 * first line) is 0, no line failed and none was stray. Then every peak is
 * what ran at once. Lines of the stack's other callers (another case, another
 * spec on a shared stack) are runs too: the log names no document.
 *
 * Only whole lines of the emulator's own shapes count (VT codes stripped, a
 * DEBUG trailer allowed): a line that merely contains one, such as a
 * function's console line quoting it, does not.
 *
 * @param {string} text
 * @param {{triggers?: Iterable<string>, openAtStart?: number|null}} [opts]
 * @returns {{runs: Record<string, number>, peak: Record<string, number>, peakTriggers: number, peakOther: number, peakAny: number, open: Record<string, number>, stray: Record<string, number>, failed: number, openAtStart: number|null, exact: boolean}}
 *   runs/peak: per function name (the region taken off) with a run begun in
 *   the text; open: runs not seen to end; stray: end lines of runs begun
 *   before the text; keys sorted, a 0 left out.
 */
export function functionRuns(text, { triggers = FIRESTORE_TRIGGERS, openAtStart = null } = {}) {
  if (typeof text !== "string") throw new TypeError(`functionRuns: text is emulators.log's text (a string), got ${typeof text}`);
  const trig = triggerSet(triggers, "functionRuns");
  if (openAtStart !== null && (!Number.isInteger(openAtStart) || openAtStart < 0)) {
    throw new TypeError(`functionRuns: openAtStart is the number of runs in flight as the text began (a whole number), or null when unknown, got ${JSON.stringify(openAtStart) ?? String(openAtStart)}`);
  }
  const runs = new Map();
  const peak = new Map();
  const live = new Map();
  const stray = new Map();
  let failed = 0;
  let nTriggers = 0;
  let nOther = 0;
  let peakTriggers = 0;
  let peakOther = 0;
  let peakAny = 0;
  const end = (name) => {
    live.set(name, live.get(name) - 1);
    if (trig.has(name)) nTriggers -= 1;
    else nOther -= 1;
  };
  for (const raw of text.split("\n")) {
    const r = runLine(raw);
    if (!r) continue;
    if (r.kind === "begin") {
      runs.set(r.name, (runs.get(r.name) ?? 0) + 1);
      const now = (live.get(r.name) ?? 0) + 1;
      live.set(r.name, now);
      peak.set(r.name, Math.max(peak.get(r.name) ?? 0, now));
      if (trig.has(r.name)) nTriggers += 1;
      else nOther += 1;
      peakTriggers = Math.max(peakTriggers, nTriggers);
      peakOther = Math.max(peakOther, nOther);
      peakAny = Math.max(peakAny, nTriggers + nOther);
    } else if (r.kind === "finish") {
      if ((live.get(r.name) ?? 0) > 0) end(r.name);
      else stray.set(r.name, (stray.get(r.name) ?? 0) + 1);
    } else {
      failed += 1;
      for (const [name, k] of live) if (k > 0) end(name);
    }
  }
  return {
    runs: sortedObject(runs),
    peak: sortedObject(peak),
    peakTriggers,
    peakOther,
    peakAny,
    open: sortedObject(live),
    stray: sortedObject(stray),
    failed,
    openAtStart,
    exact: openAtStart === 0 && failed === 0 && stray.size === 0,
  };
}

/** The byte where the line holding byte `offset` starts (`offset` itself after a newline, or 0). */
function lineStart(fd, offset) {
  const buf = Buffer.allocUnsafe(64 * 1024);
  let end = offset;
  while (end > 0) {
    const from = Math.max(0, end - buf.length);
    const n = readSync(fd, buf, 0, end - from, from);
    const nl = buf.subarray(0, n).lastIndexOf(10);
    if (nl >= 0) return from + nl + 1;
    end = from;
  }
  return 0;
}

/** Each whole line of bytes [from, to) to `each` (without its newline); returns the byte after the last one (a partial last line is left unread). */
function scanLines(fd, from, to, each) {
  const buf = Buffer.allocUnsafe(RUN_SCAN_CHUNK);
  let pos = from;
  let done = from;
  let carry = null;
  while (pos < to) {
    const n = readSync(fd, buf, 0, Math.min(buf.length, to - pos), pos);
    if (n <= 0) break;
    pos += n;
    const chunk = carry ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n);
    const nl = chunk.lastIndexOf(10);
    if (nl < 0) {
      carry = Buffer.from(chunk);
      continue;
    }
    for (const line of chunk.toString("utf8", 0, nl).split("\n")) each(line);
    done = pos - (chunk.length - nl - 1);
    carry = nl + 1 < chunk.length ? Buffer.from(chunk.subarray(nl + 1)) : null;
  }
  return done;
}

const hasCapability = (t, c) => (t?.capabilities instanceof Set ? t.capabilities.has(c) : Array.isArray(t?.capabilities) && t.capabilities.includes(c));

/**
 * functionRuns over a case's own window of the stack's emulators.log: from
 * the line holding byte `since` (default ctx.logSince, the case's start) to
 * the last whole line before `until` (default: the log's end now), with
 * `openAtStart` counted from the log's first line (runs begun before the
 * window less those finished or failed: each run ends with exactly one of
 * the two lines), so `exact` can be true.
 *
 * Null when there is nothing to read: `since` null (a target without the
 * "logs" capability), a target that is not a local stack (or has no runId or
 * no "logs"), no log, or a `since` past its end (another log than the mark's).
 * Read it when the runs it counts are over (after the server settle): a run
 * still going is in `open`.
 *
 * @param {object|null} ctx  a case's ctx (its target and logSince), or null with {target, since}
 * @param {{since?: number|null, until?: number|null, triggers?: Iterable<string>, target?: object|null}} [opts]
 * @returns {null | (ReturnType<typeof functionRuns> & {since: number, until: number|null, from: number, to: number})}
 *   from/to: the bytes read (whole lines).
 */
export function caseFunctionRuns(ctx, { since = ctx?.logSince ?? null, until = null, triggers = FIRESTORE_TRIGGERS, target = ctx?.target ?? null } = {}) {
  if (ctx != null && typeof ctx !== "object") throw new TypeError(`caseFunctionRuns: ctx is a case's ctx, or null with {target, since}, got ${typeof ctx}`);
  if (since !== null && (!Number.isInteger(since) || since < 0)) {
    throw new TypeError(`caseFunctionRuns: since is a byte offset into the emulators log (a logMark), 0 or more, or null, got ${JSON.stringify(since) ?? String(since)}`);
  }
  if (until !== null && (!Number.isInteger(until) || until < 0 || (since !== null && until < since))) {
    throw new TypeError(`caseFunctionRuns: until is a byte offset into the emulators log (a logMark) no earlier than since, or null for its end, got ${JSON.stringify(until) ?? String(until)}`);
  }
  triggerSet(triggers, "caseFunctionRuns");
  if (since === null || target?.kind !== "local" || !target.runId || !hasCapability(target, "logs")) return null;
  let fd;
  try {
    const file = logFile(target.runId);
    if (!existsSync(file)) return null;
    fd = openSync(file, "r");
    const size = statSync(file).size;
    if (since > size) return null;
    const from = lineStart(fd, since);
    let before = 0;
    scanLines(fd, 0, from, (line) => {
      const r = runLine(line);
      if (r) before += r.kind === "begin" ? 1 : -1;
    });
    const lines = [];
    const to = scanLines(fd, from, Math.min(until ?? size, size), (line) => lines.push(line));
    lines.push("");
    const r = functionRuns(lines.join("\n"), { triggers, openAtStart: before >= 0 ? before : null });
    return { ...r, since, until, from, to };
  } catch (err) {
    if (err instanceof TypeError) throw err;
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
