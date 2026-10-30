// SPDX-License-Identifier: Apache-2.0
// Self-test: how many runs of each function the Functions emulator began in a window of emulators.log, and how many ran at once — functionRuns, caseFunctionRuns, FIRESTORE_TRIGGERS (SPEC §12).

/**
 * The lines are first made by firebase-tools' OWN RuntimeWorker printing
 * through the CLI's console logger (helpers/fn-runs-writer.mjs), plain, in
 * colour and with DEBUG, so the parser is held to what the emulator prints.
 * The rest is written lines whose shapes those runs pin: the lower bound
 * after a failure line, stray ends, exactness, which lines count, names, the
 * TypeErrors, and caseFunctionRuns over a stack's log (the mark's line, a
 * partial last line, the runs in flight before the window, `until`, null off
 * a local stack). FIRESTORE_TRIGGERS is pinned to functions/src/index.ts.
 * No stack, no browser.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FIRESTORE_TRIGGERS, caseFunctionRuns, functionRuns, logFile, logMark } from "../lib/logs.mjs";
import { E2E_DIR, E2E_TMP, OUT_DIR, REPO_ROOT, ensureDir } from "../lib/paths.mjs";

const WRITER = join(E2E_DIR, "selftest", "helpers", "fn-runs-writer.mjs");
const runId = `selftest-fnruns-${process.pid}`;
const bareRunId = `selftest-fnruns-bare-${process.pid}`;

const B = (id) => `i  functions: Beginning execution of "${id}"`;
const F = (id, ms = "12.5") => `i  functions: Finished "${id}" in ${ms}ms`;
const FAILED = "i  Request to function failed: Error: socket hang up";
const T60 = ["i  Your function timed out after ~60s. To configure this timeout, see", "      the emulator's documentation.", FAILED];
const CC = "us-central1-onCommentCreated";
const RT = "us-central1-recordThreadEvent";
const RC = "us-central1-recordCommentEvent";
const SESSION = "us-central1-session";
const lines = (...ls) => `${ls.flat().join("\n")}\n`;

let tmp;
let target;

before(() => {
  tmp = mkdtempSync(join(ensureDir(E2E_TMP, "E2E_TMP"), "selftest-function-runs-"));
  mkdirSync(join(OUT_DIR, runId, "logs"), { recursive: true });
  mkdirSync(join(OUT_DIR, bareRunId), { recursive: true });
  target = Object.freeze({ kind: "local", runId, capabilities: new Set(["local", "logs"]) });
});

after(() => {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(join(OUT_DIR, runId), { recursive: true, force: true });
  rmSync(join(OUT_DIR, bareRunId), { recursive: true, force: true });
});

/** The writer's stdout for `steps`, as emulators.log would hold it; null without firebase-tools. */
function writerLog(steps, env = {}) {
  const script = join(tmp, `script-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(script, JSON.stringify(steps));
  const out = join(tmp, `out-${Math.random().toString(36).slice(2)}.log`);
  const fd = openSync(out, "w");
  const base = { ...process.env };
  delete base.DEBUG;
  delete base.FORCE_COLOR;
  delete base.NO_COLOR;
  let r;
  try {
    r = spawnSync(process.execPath, [WRITER, script], { stdio: ["ignore", fd, "pipe"], env: { ...base, ...env }, timeout: 60_000 });
  } finally {
    closeSync(fd);
  }
  const err = String(r.stderr ?? "");
  if (r.status === 3 && /no firebase-tools/.test(err)) return null;
  assert.equal(r.status, 0, `the writer failed: ${err}`);
  assert.match(err, /^mode real\n[\s\S]*done\n$/, "the writer ran firebase-tools' own RuntimeWorker to the end");
  return readFileSync(out, "utf8");
}

const run = (id, trigger, extra = {}) => [{ op: "begin", id, trigger, ...extra }, { op: "arrived", id }];
const finish = (id) => [{ op: "answer", id }, { op: "ended", id }];

/** Two onCommentCreated runs at once beside an HTTP run, then HTTP runs one by one, a console line quoting a begin, a dropped run and a timed-out one. */
const STEPS = [
  ...run("A", CC),
  ...run("B", CC),
  ...run("H", SESSION),
  ...finish("A"),
  ...finish("B"),
  ...finish("H"),
  ...run("S1", SESSION),
  ...finish("S1"),
  ...run("S2", SESSION),
  ...finish("S2"),
  ...run("C", RC),
  { op: "console", id: "C", text: B(CC) },
  { op: "console", id: "C", text: `Beginning execution of "${CC}"` },
  ...finish("C"),
  ...run("D", CC),
  { op: "drop", id: "D" },
  { op: "ended", id: "D" },
  ...run("T", RT, { timeoutSeconds: 1 }),
  { op: "ended", id: "T" },
];
const EXPECTED = {
  runs: { onCommentCreated: 3, recordCommentEvent: 1, recordThreadEvent: 1, session: 3 },
  peak: { onCommentCreated: 2, recordCommentEvent: 1, recordThreadEvent: 1, session: 1 },
  peakTriggers: 2,
  peakOther: 1,
  peakAny: 3,
  open: {},
  stray: {},
  failed: 2,
  openAtStart: 0,
  exact: false,
};

test("firebase-tools' own RuntimeWorker, printing through the CLI's console logger, gives the lines functionRuns reads: overlap, one at a time, a console line, a dropped run and a timeout — plain, in colour and with DEBUG", (t) => {
  const plain = writerLog(STEPS);
  if (plain === null) return t.skip("firebase-tools is not installed (E2E_FIREBASE_BIN or firebase on PATH)");
  const ls = plain.split("\n");
  // The shapes, as the stack's emulators.log holds them.
  assert.deepEqual(ls.slice(0, 6), [B(CC), B(CC), B(SESSION), ls[3], ls[4], ls[5]]);
  assert.match(ls[3], /^i {2}functions: Finished "us-central1-onCommentCreated" in \d+\.\d+ms$/);
  assert.ok(ls.includes(`>  ${B(CC)}`), "a function's console line quoting a begin line is printed after `>  `");
  assert.equal(ls.filter((l) => l === FAILED).length, 2, "a dropped run and a timed-out run each end with one failure line, naming no function");
  assert.ok(ls.some((l) => /^i {2}Your function timed out after ~1s\./.test(l)));
  assert.equal(ls.filter((l) => l.startsWith("i  functions: Beginning execution of ")).length, ls.filter((l) => l.startsWith("i  functions: Finished ")).length + ls.filter((l) => l === FAILED).length, "every run ends with exactly one Finished or failure line");
  assert.deepEqual(functionRuns(plain, { openAtStart: 0 }), EXPECTED);
  // Up to the dropped run: nothing failed, so the peaks are exact.
  const clean = ls.slice(0, ls.indexOf(`${B(CC)}`, 8)).join("\n");
  const c = functionRuns(clean, { openAtStart: 0 });
  assert.equal(c.exact, true);
  assert.deepEqual([c.peak.onCommentCreated, c.peakTriggers, c.peakOther, c.peakAny, c.failed], [2, 2, 1, 3, 0]);

  const colour = writerLog(STEPS, { FORCE_COLOR: "1" });
  assert.ok(colour.includes("\u001b["), "FORCE_COLOR prints VT codes");
  assert.deepEqual(functionRuns(colour, { openAtStart: 0 }), EXPECTED, "VT codes are stripped");
  const debug = writerLog(STEPS, { DEBUG: "true" });
  assert.match(debug, /^i {2}functions: Beginning execution of "us-central1-onCommentCreated" \{"metadata":/m, "DEBUG appends the record's metadata");
  assert.deepEqual(functionRuns(debug, { openAtStart: 0 }), EXPECTED, "a DEBUG trailer counts the same");
});

test("a failure line names no function, so it ends one open run of EVERY function: no count is ever more than certainly ran at once", () => {
  // X1 and Y1 open; one of them failed; X2 begins. If X1 failed, X ran one at a time.
  const r = functionRuns(lines(B("us-central1-x"), B("us-central1-y"), FAILED, B("us-central1-x"), F("us-central1-x"), F("us-central1-y")), { triggers: ["x"], openAtStart: 0 });
  assert.equal(r.peak.x, 1, "X2 alone is certain");
  assert.equal(r.peak.y, 1);
  assert.equal(r.peakTriggers, 1);
  assert.equal(r.peakAny, 2);
  assert.equal(r.failed, 1);
  assert.deepEqual(r.stray, { y: 1 }, "Y's end found no run of Y still counted");
  assert.equal(r.exact, false);
  // The 60 s stop: the timed-out line itself ends nothing, the failure line does.
  const t60 = functionRuns(lines(B(CC), T60, B(CC), F(CC)), { openAtStart: 0 });
  assert.equal(t60.peak.onCommentCreated, 1);
  assert.equal(t60.failed, 1);
  // A failure with nothing open changes nothing but its count.
  const idle = functionRuns(lines(FAILED, B(CC), B(CC), F(CC), F(CC)), { openAtStart: 0 });
  assert.deepEqual([idle.peak.onCommentCreated, idle.failed, idle.exact], [2, 1, false]);
});

test("an end line with no open run of its function is stray (a run begun before the text); exact only with openAtStart 0, no failure and no stray", () => {
  const text = lines(F(CC), B(CC), B(SESSION), F(SESSION));
  const r = functionRuns(text, { openAtStart: 0 });
  assert.deepEqual(r.stray, { onCommentCreated: 1 });
  assert.deepEqual(r.runs, { onCommentCreated: 1, session: 1 });
  assert.deepEqual(r.open, { onCommentCreated: 1 }, "the stray end ended no run of the text's: its run has not been seen to end");
  assert.equal(r.exact, false);
  const clean = lines(B(CC), B(RT), F(RT), F(CC), B(CC), F(CC));
  assert.equal(functionRuns(clean, { openAtStart: 0 }).exact, true);
  assert.equal(functionRuns(clean).exact, false, "openAtStart unknown");
  assert.equal(functionRuns(clean).openAtStart, null);
  assert.equal(functionRuns(clean, { openAtStart: 2 }).exact, false, "runs in flight as the text began");
  const c = functionRuns(clean, { openAtStart: 0 });
  assert.deepEqual([c.peak.onCommentCreated, c.peak.recordThreadEvent, c.peakTriggers, c.peakOther, c.peakAny], [1, 1, 2, 0, 2]);
  // Still running at the end: open.
  assert.deepEqual(functionRuns(lines(B(CC), B(CC), F(CC)), { openAtStart: 0 }).open, { onCommentCreated: 1 });
});

test("only the emulator's own whole lines count: not a line that merely contains one, a warning, another label or a malformed end", () => {
  const noise = [
    `>  ${B(CC)}`,
    `>  {"msg":"${B(CC).replace(/"/g, '\\"')}"}`,
    `  ${B(CC)}`,
    `${B(CC)} and more`,
    `⚠  functions: Beginning execution of "${CC}"`,
    `i  hosting: Beginning execution of "${CC}"`,
    `i  functions: Beginning execution of ""`,
    `i  functions: Finished "${CC}" in abcms`,
    `i  functions: Finished "${CC}" in 12.5`,
    `>  ${FAILED}`,
    `⚠  Request to function failed: Error: socket hang up`,
  ];
  const r = functionRuns(lines(noise), { openAtStart: 0 });
  assert.deepEqual([r.runs, r.stray, r.failed, r.peakAny, r.exact], [{}, {}, 0, 0, true]);
  // CRLF, VT codes and a DEBUG trailer are the same line.
  const crlf = functionRuns(`${B(CC)}\r\n${B(CC)}\r\n${F(CC)}\r\n${F(CC)}\r\n`, { openAtStart: 0 });
  assert.deepEqual([crlf.peak.onCommentCreated, crlf.exact], [2, true]);
  const vt = (l) => l.replace(/^(i {2}functions:)/, "\u001b[36m\u001b[1m$1\u001b[22m\u001b[39m");
  assert.equal(functionRuns(lines(vt(B(CC)), vt(B(CC)), vt(F(CC)), vt(F(CC))), { openAtStart: 0 }).peak.onCommentCreated, 2);
  const trailer = ' {"metadata":{"emulator":{"name":"functions"},"function":{"name":"us-central1-onCommentCreated"},"message":"…"}}';
  assert.equal(functionRuns(lines(B(CC) + trailer, B(CC) + trailer, F(CC) + trailer, F(CC) + trailer), { openAtStart: 0 }).peak.onCommentCreated, 2);
  // A Finished with an exponent is a Finished.
  assert.equal(functionRuns(lines(B(CC), F(CC, "1.5e-7")), { openAtStart: 0 }).exact, true);
});

test("names: the region comes off, a grouped export keeps its dashes, and `triggers` decides what peakTriggers counts", () => {
  const r = functionRuns(lines(B("europe-west1-onCommentCreated"), B("us-central1-api-session"), B(SESSION), B("northamerica-northeast1-recordThreadEvent"), B("plainName")), { openAtStart: 0 });
  assert.deepEqual(r.runs, { "api-session": 1, onCommentCreated: 1, plainName: 1, recordThreadEvent: 1, session: 1 });
  assert.deepEqual(Object.keys(r.runs), ["api-session", "onCommentCreated", "plainName", "recordThreadEvent", "session"], "keys sorted");
  assert.deepEqual([r.peakTriggers, r.peakOther, r.peakAny], [2, 3, 5]);
  const http = functionRuns(lines(B(SESSION), B(SESSION), B(CC)), { triggers: new Set(["session"]), openAtStart: 0 });
  assert.deepEqual([http.peakTriggers, http.peakOther], [2, 1], "any iterable of names");
  assert.deepEqual(functionRuns(lines(B(CC)), { triggers: [] }).peakTriggers, 0);
});

test("TypeErrors before anything is read", () => {
  assert.throws(() => functionRuns(null), /functionRuns: text is emulators\.log's text/);
  assert.throws(() => functionRuns(Buffer.from("x")), TypeError);
  assert.throws(() => functionRuns("", { triggers: "onCommentCreated" }), /triggers is a list of function names/);
  assert.throws(() => functionRuns("", { triggers: [""] }), TypeError);
  assert.throws(() => functionRuns("", { triggers: [1] }), TypeError);
  assert.throws(() => functionRuns("", { triggers: null }), TypeError);
  for (const bad of [-1, 1.5, "0", Number.NaN]) assert.throws(() => functionRuns("", { openAtStart: bad }), /openAtStart is the number of runs in flight/);
  for (const bad of [-1, 1.5, "3"]) assert.throws(() => caseFunctionRuns(null, { target, since: bad }), /caseFunctionRuns: since is a byte offset/);
  assert.throws(() => caseFunctionRuns(null, { target, since: 10, until: 9 }), /caseFunctionRuns: until is a byte offset/);
  assert.throws(() => caseFunctionRuns(null, { target, since: 0, until: -1 }), TypeError);
  assert.throws(() => caseFunctionRuns(5), /caseFunctionRuns: ctx is a case's ctx/);
  assert.throws(() => caseFunctionRuns(null, { target: { kind: "production" }, since: 0, triggers: "x" }), /caseFunctionRuns: triggers/, "checked even where nothing would be read");
});

test("caseFunctionRuns reads a case's window of the stack's log: from the mark's line, whole lines only, with the runs in flight before it counted from the first line", () => {
  const file = logFile(runId);
  // Before the case: P is still running, Q ran and ended, R failed.
  writeFileSync(file, lines("i  functions: Loaded functions definitions from source: …", B(CC), B(SESSION), F(SESSION), B(RT), FAILED));
  // The mark lands inside a line being written: that line is the window's.
  appendFileSync(file, B(RC).slice(0, 20));
  const since = logMark({ target });
  appendFileSync(file, `${B(RC).slice(20)}\n`);
  const ctx = { target, logSince: since };
  // The window: W begins; an end comes (P's or W's: taken for W's, the bound); W2 begins; then the other two ends.
  appendFileSync(file, lines(B(CC), F(CC), B(CC), F(RC)));
  const untilMark = logMark({ target });
  appendFileSync(file, lines(F(CC), F(CC)));
  // A line still being written at the end is not read.
  appendFileSync(file, B(CC));
  const r = caseFunctionRuns(ctx);
  const start = since - 20;
  assert.equal(r.since, since);
  assert.equal(r.from, start, "from the start of the line holding the mark");
  assert.equal(r.to, logMark({ target }) - B(CC).length, "to the end of the last whole line");
  assert.equal(r.until, null);
  assert.equal(r.openAtStart, 1, "P was in flight: begun 3, finished 1, failed 1 before the window");
  assert.deepEqual(r.runs, { onCommentCreated: 2, recordCommentEvent: 1 }, "the mark's line counted once, the partial last line not at all");
  assert.equal(r.peak.onCommentCreated, 1, "P's end may have been W's: one at a time is all that is certain");
  assert.deepEqual(r.stray, { onCommentCreated: 1 }, "three ends for P and two runs of the window's: the last found none left");
  assert.deepEqual(r.open, {});
  assert.equal(r.exact, false);
  const u = caseFunctionRuns(ctx, { until: untilMark - 3 });
  assert.equal(u.to, untilMark - F(RC).length - 1, "until a mark mid-line: up to the last whole line before it");
  assert.deepEqual([u.runs, u.open, u.until], [{ onCommentCreated: 2, recordCommentEvent: 1 }, { onCommentCreated: 1, recordCommentEvent: 1 }, untilMark - 3]);
  const v = caseFunctionRuns(ctx, { until: untilMark });
  assert.deepEqual(v.open, { onCommentCreated: 1 }, "until a mark at a line's start: every line before it");
  // The same window, as functionRuns reads its text.
  const text = readFileSync(file).subarray(start, r.to).toString("utf8");
  assert.deepEqual({ ...r, since: undefined, until: undefined, from: undefined, to: undefined }, { ...functionRuns(text, { openAtStart: 1 }), since: undefined, until: undefined, from: undefined, to: undefined });
});

test("caseFunctionRuns is exact on a window that began with nothing in flight, takes another target and mark, and is null where there is nothing to read", () => {
  const file = logFile(runId);
  writeFileSync(file, lines(B(SESSION), B(CC), FAILED, F(SESSION)));
  // Before: 2 begun, 1 failed, 1 finished — nothing in flight, whichever failed.
  const since = logMark({ target });
  appendFileSync(file, lines(B(CC), B(CC), B(SESSION), F(CC), F(SESSION), F(CC)));
  const r = caseFunctionRuns({ target, logSince: since });
  assert.deepEqual([r.openAtStart, r.exact, r.peak.onCommentCreated, r.peakTriggers, r.peakOther, r.peakAny], [0, true, 2, 2, 1, 3]);
  // Explicit target and since; the capability list as an array; triggers.
  const arr = { kind: "local", runId, capabilities: ["logs"] };
  assert.deepEqual(caseFunctionRuns(null, { target: arr, since, triggers: ["session"] }).peakTriggers, 1);
  assert.equal(caseFunctionRuns(null, { target: arr, since: 0 }).exact, false, "from the first line: a failure in the window");
  // Null: nothing to read.
  assert.equal(caseFunctionRuns({ target, logSince: null }), null, "no mark (a target without the logs capability)");
  assert.equal(caseFunctionRuns({ target: { ...target, kind: "production" }, logSince: since }), null);
  assert.equal(caseFunctionRuns({ target: { kind: "local", runId, capabilities: new Set(["local"]) }, logSince: since }), null, "no logs capability");
  assert.equal(caseFunctionRuns({ target: { kind: "local", capabilities: new Set(["logs"]) }, logSince: 0 }), null, "no runId");
  assert.equal(caseFunctionRuns({ target: { ...target, runId: bareRunId }, logSince: 0 }), null, "no log");
  assert.equal(caseFunctionRuns({ target, logSince: logMark({ target }) + 1 }), null, "a mark past the log's end");
  assert.equal(caseFunctionRuns(null), null, "no ctx, no target");
  // A window with nothing in it.
  const empty = caseFunctionRuns({ target, logSince: logMark({ target }) });
  assert.deepEqual([empty.runs, empty.peakAny, empty.exact], [{}, 0, true]);
});

test("FIRESTORE_TRIGGERS is every Firestore trigger of functions/src/index.ts, and every other function there answers HTTP or runs on a schedule", () => {
  const src = readFileSync(join(REPO_ROOT, "functions", "src", "index.ts"), "utf8");
  const kinds = [...src.matchAll(/^export const (\w+) = (\w+)\(/gm)].map(([, name, kind]) => ({ name, kind }));
  assert.ok(kinds.length >= 30, `the exports were read (${kinds.length})`);
  const triggers = kinds.filter((k) => /^onDocument(Created|Written|Updated|Deleted)$/.test(k.kind)).map((k) => k.name).sort();
  assert.deepEqual([...FIRESTORE_TRIGGERS].sort(), triggers);
  // A schedule is not a trigger functionRuns counts: the Functions emulator
  // loads it and never runs it (lib/purge.ts is tested as a library instead).
  assert.deepEqual(kinds.filter((k) => k.kind === "onSchedule").map((k) => k.name), ["purgeExpiredTrash"], "the one scheduled function (ADR 0025)");
  assert.deepEqual(kinds.filter((k) => !triggers.includes(k.name) && k.kind !== "onRequest" && k.kind !== "onSchedule"), [], "a function of another kind (a database or auth trigger) needs FIRESTORE_TRIGGERS revisited");
  assert.ok(Object.isFrozen(FIRESTORE_TRIGGERS));
});

test("the README documents the exports", () => {
  const readme = readFileSync(join(E2E_DIR, "README.md"), "utf8");
  for (const s of [
    "functionRuns(text, {triggers = FIRESTORE_TRIGGERS, openAtStart = null} = {})",
    "caseFunctionRuns(ctx, {since = ctx.logSince, until = null, triggers = FIRESTORE_TRIGGERS, target = ctx.target} = {})",
    "`FIRESTORE_TRIGGERS`",
    "a LOWER bound",
  ]) assert.ok(readme.includes(s), `README: ${s}`);
});
