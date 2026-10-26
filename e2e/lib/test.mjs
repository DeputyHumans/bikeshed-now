// SPDX-License-Identifier: Apache-2.0
// scenario(): one declaration → one node:test case per N and trial, with tier skips, known-defect todos, INCONCLUSIVE and evidence (SPEC §12).

/**
 *   scenario("C1 disjoint-paragraph typing", {
 *     tiers: ["local", "prod"],   // where it may run; elsewhere it is SKIPPED with the reason
 *     effects: ["email:POST /access"], // an email effect is skipped on prod, reason "sends email: POST /access"
 *     needs: ["mailpit"],         // target capabilities; missing → skipped, with the reason;
 *                                 // "!<capability>": one the target must NOT have (present → skipped)
 *     n: [2, 5, 10, 20],          // one case per N, named "… [N=5]"; E2E_N (run.mjs --n) selects
 *     trials: {2: 10, 5: 5},      // a number, per N, or "plan" (PLAN_TRIALS: 10/5/3/3 for N = 2/5/10/20);
 *                                 // omitted, a scenario with `n` in specs/concurrency/ gets "plan", any
 *                                 // other 1; E2E_TRIALS (run.mjs --trials k) makes it k for every N;
 *                                 // with more than one, trial k is named "… [N=5] #k"
 *     defect: "S3",               // a KNOWN defect: see below
 *     timeoutMs: 120_000,         // else E2E_CASE_TIMEOUT_MS (run.mjs: the tier default)
 *     inconclusiveOnStackTimeout: true, // the stack's own non-answer ends it INCONCLUSIVE (below)
 *     inconclusiveOnPageStall: true,    // …and so does a wait that ran out while a page saw the stack stall (pageStall)
 *     inconclusiveOnFunctionKill: true, // …or while the emulator killed functions under load (functionKill)
 *     inconclusiveOnCaseTimeout: true,  // …and the case's own timeout is such a wait (caseBudget)
 *     inconclusiveOnRequestStall: true, // …and the case's own requests Hosting cut off are evidence too (pageStall's requests)
 *     inconclusiveOnHttpStall: true,    // …and a budget that ran out while the stack answered the case's own requests slowly (httpStall)
 *   }, async (ctx) => { … });
 *
 * ctx: {target, n, trial, name, t (the node:test context), users (a lazily
 * created BrowserPool), usersSoFar (the users made so far, or []; never
 * makes a pool), http(opts) and mcp(opts) (clients from http.mjs and
 * mcp.mjs, logging into this test's evidence), ev (Evidence), step(text),
 * inconclusive(reason), oracle(fn), logSince (the stack's emulators.log
 * size in bytes as the case began, a logMark; null on a target without the
 * "logs" capability), requests() (the case's own Node requests, as http.mjs
 * logged them into its evidence: rows, never throws; requests({pending:
 * true}) adds those still in flight), budgetEndsAt (the
 * Date.now() time the case's budget runs out, set by caseBudget as the body
 * starts; null for a case without one)}.
 *
 * Outcomes:
 *   PASS / FAIL    as node:test says.
 *   INCONCLUSIVE   the body called ctx.inconclusive(reason): a precondition of
 *                  the measurement did not hold (spread over the limit, no
 *                  overlap, a peer never "Shared"). Never PASS, never FAIL;
 *                  reported as a skip whose reason starts "INCONCLUSIVE:" plus
 *                  a diagnostic `outcome=inconclusive:<reason>`, and run.mjs
 *                  exits 3 when any case ends this way. With
 *                  `inconclusiveOnStackTimeout: true` (or a body wrapped in
 *                  onAnsweringStack), so does a failure that is the stack not
 *                  answering a request (stackDidNotAnswer): Hosting's 504 at
 *                  its 60 s cut-off, the http client's own deadline, or the
 *                  Admin SDK's gRPC DEADLINE_EXCEEDED on a Firestore call.
 *                  With `inconclusiveOnPageStall: true` as well (or
 *                  onAnsweringStack(fn, {also: pageStall})), so does a wait
 *                  that ran out, or a precondition, while a page of the case
 *                  saw the stack stall in that wait's window: a 504 at the
 *                  cut-off, or its Firestore client losing the emulator.
 *                  With `inconclusiveOnFunctionKill: true` (or
 *                  onAnsweringStack(fn, {also: functionKill})), so does a
 *                  wait that ran out while, since the case began, the
 *                  emulator killed a function for a transaction lock
 *                  timeout, or stopped one at its 60 s limit while Hosting
 *                  answered 504: what was waited for may be what a killed
 *                  function never did.
 *                  With `inconclusiveOnCaseTimeout: true` (it implies
 *                  inconclusiveOnPageStall), the body runs against a budget
 *                  that ends before the case's timeout (caseBudget), and
 *                  running out of it is a wait those judges read, its window
 *                  the whole case. node:test's own timeout is never judged.
 *                  With `inconclusiveOnRequestStall: true` (it implies
 *                  inconclusiveOnPageStall), pageStall counts the case's
 *                  OWN requests too (ctx.requests(): http.mjs, mcp.mjs, a
 *                  session's): one answered Hosting's cut-off 504 in the
 *                  wait's window is the same evidence as a page's.
 *                  With `inconclusiveOnHttpStall: true` (it implies
 *                  inconclusiveOnCaseTimeout), a budget that ran out while
 *                  the stack took 30 s or more to answer at least one of
 *                  the case's OWN requests (ctx.requests({pending: true}),
 *                  one still in flight included) is judged too (httpStall):
 *                  a slow answer is still an answer, so it may explain the
 *                  case running out of time, and nothing else.
 *                  untilLanded(ctx, what, send, effect) sends a call again
 *                  when the stack did not answer it (unanswered), looking
 *                  for its effect first, and ends the case INCONCLUSIVE
 *                  itself, whatever the options, when that keeps happening
 *                  (seed.mjs publish / publishMcp and grant.mjs setVisibility
 *                  take it as `patient`). With `stopAt: "budget"` it sends
 *                  again only while one more send and its look still end
 *                  inside the case's budget, so a stack that keeps not
 *                  answering ends the case through it, never mid-look as
 *                  the budget running out.
 *   TODO         a `defect:` case. It is NOT declared todo up front: only the
 *                  defect's own oracle failing — an AssertionError from the
 *                  body, or an error ctx.oracle() wrapped (E2E_DEFECT_ORACLE)
 *                  — is marked TODO ("failed as expected"). An isolation
 *                  breach, a sync timeout, a guard refusal, a precondition
 *                  (E2E_PRECONDITION) or any other error FAILS the case as it
 *                  would without the tag. A defect case that passes is marked
 *                  TODO too, so it shows up as "passed unexpectedly".
 *   NOT REPRODUCED a `defect:` case whose body called ctx.notReproduced(reason):
 *                  its trial never reached the defect's window (a natural
 *                  race that did not race), so it measured neither the
 *                  defect nor its absence — the plan's class U, "listed,
 *                  never counted as a pass". Reported as a skip whose reason
 *                  is reporter.mjs formatNotReproduced(defect, reason) plus a
 *                  diagnostic `outcome=not-reproduced:{"defect","reason"}`
 *                  (the reporter's status "not-reproduced"); its evidence
 *                  (steps, HTTP, the reason in error.txt) is written, its
 *                  pages are not captured. Not exit 3: run.mjs exits as for a
 *                  TODO, and report.mjs counts each scenario's trials as
 *                  "<defect> seen in s of K trials" (defectRates). A breach
 *                  still FAILS it; no stack judge (stackDidNotAnswer,
 *                  pageStall, functionKill, httpStall, a spec's `also`) ever
 *                  reads it, and ctx.oracle() passes it through untouched.
 *                  In a case that declares no `defect`, ctx.notReproduced
 *                  throws a TypeError, which FAILS it.
 *
 * After the body: any browser isolation breach fails the case, whatever the
 * body did. The Firestore SDK's own network test (browser.mjs isSdkProbe) is
 * blocked but is no breach: pass, fail or timeout, the case notes it as an
 * environment signal (a step, `sdk-probes.json`, and one findings.jsonl row,
 * kind "sdk-probe", class "E"). Every document the case made unlisted or public through
 * grant.mjs's setVisibility (or trackWindow) is made private again, pass,
 * fail or timeout; one that will not close FAILS a case that otherwise passed
 * (E2E_WINDOW_OPEN) and is recorded in findings.jsonl. On failure, every open
 * user page is captured (console, requests,
 * DOM, screenshot), the buffered steps and HTTP log are written, and the
 * evidence directory is reported as a diagnostic `evidence=<dir>` the reporter
 * attaches to the case. On an INCONCLUSIVE too (captureUsers): every user's
 * console and requests at once, and its DOM excerpt and screenshot while
 * the capture's time lasts (INCONCLUSIVE_CAPTURE_MS, and never later than
 * CAPTURE_RESERVE_MS before the case's timeout, so that a page that does
 * not answer never turns the INCONCLUSIVE into node:test's timeout).
 *
 * A TIMEOUT is reported by node:test the moment it fires, while the body keeps
 * running. So the case listens on t.signal: on abort it names its evidence
 * directory at once (the only moment a diagnostic still reaches the case),
 * writes the error, captures every user, and closes the pool so whatever the
 * body is still awaiting in a browser rejects. Nothing the late body does
 * afterwards reaches the report or the next case: HTTP rows go to the sink in
 * this case's AsyncLocalStorage context, never to a process-wide one.
 * The pool is always closed.
 */

import { test } from "node:test";
import { AssertionError } from "node:assert";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BrowserPool, poolWaitMs } from "./browser.mjs";
import { GIB, LIVE_RESERVE_MIN_N, admitLive } from "./load.mjs";
import { PLAN_TRIALS, caseTimeoutDefault, isConcurrencySpec } from "./budget.mjs";
import { Evidence, redactString } from "./evidence.mjs";
import { evidenceRoot } from "./invocation.mjs";
import { logFile, logMark, readLog } from "./logs.mjs";
import { REPO_ROOT, SPECS_DIR } from "./paths.mjs";
import { formatNotReproduced } from "./reporter.mjs";
import { loadTarget } from "./target.mjs";
import { CoverageBoundary, recycleRtdbCoverage } from "./rtdb-coverage.mjs";
import { recycleFirestoreCoverage } from "./firestore-coverage.mjs";

const coverageBoundary = new CoverageBoundary();

async function optional(rel) {
  try {
    return await import(rel);
  } catch (err) {
    if (err.code === "ERR_MODULE_NOT_FOUND" && String(err.message).includes(rel.replace("./", "/"))) return null;
    throw err;
  }
}
const httpMod = await optional("./http.mjs");
const mcpMod = await optional("./mcp.mjs");
const grantMod = await optional("./grant.mjs");

let cached;
/** The target from E2E_TARGET, or null when there is none (a listing, a self-test). */
export function currentTarget() {
  if (cached !== undefined) return cached;
  cached = process.env.E2E_TARGET ? loadTarget(process.env.E2E_TARGET) : null;
  return cached;
}

/** For self-tests: use this target instead of E2E_TARGET. */
export function setTarget(target) {
  cached = target;
}

/** The N values run.mjs --n selected (E2E_N), or null for "all". */
export function selectedN(env = process.env) {
  if (!env.E2E_N) return null;
  return env.E2E_N.split(",").map((s) => Number(s.trim())).filter(Number.isFinite);
}

/** The plan's trials per N for the concurrency scenarios: K = 10/5/3/3 for N = 2/5/10/20 (an N not listed: 1); defined in budget.mjs, whose scan counts them. */
export { PLAN_TRIALS };
/** The env var run.mjs --trials sets: every scenario then runs that many trials per N. */
export const TRIALS_ENV = "E2E_TRIALS";

/** E2E_TRIALS as a whole number from 1 to 999, or null when unset; anything else throws. */
export function trialsOverride(env = process.env) {
  const raw = env[TRIALS_ENV];
  if (raw === undefined || raw === null || raw === "") return null;
  if (!/^[1-9]\d{0,2}$/.test(String(raw))) throw new TypeError(`${TRIALS_ENV} is a whole number of trials from 1 to 999, got ${JSON.stringify(raw)}`);
  return Number(raw);
}

function trialsFor(trials, n) {
  if (trials === "plan") return PLAN_TRIALS[n] ?? 1;
  if (typeof trials === "number") return trials;
  if (trials && typeof trials === "object") return Number(trials[n] ?? trials.default ?? 1);
  return 1;
}

/** How many trials a scenario runs at N: the E2E_TRIALS override, else its `trials` (a number, per N, or "plan"). */
export function trialsPerN(trials, n, { override = trialsOverride() } = {}) {
  return override ?? trialsFor(trials, n);
}

/** Is this spec file one of the concurrency tier's (under e2e/specs/concurrency/), or is the run that tier? The one predicate, budget.mjs's, which fileBudget counts by too. */
export { isConcurrencySpec };

/**
 * The `trials` a scenario declaration runs with: its own when given, else
 * "plan" (PLAN_TRIALS) for a scenario with `n` in a concurrency spec, else 1.
 */
export function scenarioTrials(opts = {}, file = null, env = process.env) {
  if (opts.trials !== undefined && opts.trials !== null) {
    const t = opts.trials;
    const ok = t === "plan" || (Number.isInteger(t) && t >= 1) || (t && typeof t === "object" && !Array.isArray(t) && Object.values(t).every((v) => Number.isInteger(v) && v >= 0));
    if (!ok) throw new TypeError(`scenario trials is a whole number, {N: k}, or "plan", got ${JSON.stringify(t)}`);
    return t;
  }
  return opts.n != null && isConcurrencySpec(file, env) ? "plan" : 1;
}

function emailEffects(effects) {
  return effects
    .map((e) => String(e))
    .filter((e) => e === "email" || e.startsWith("email:"))
    .map((e) => (e === "email" ? "email" : e.slice("email:".length).trim()));
}

/**
 * A `needs` list split by what it asks: `want` the capabilities the target
 * must have, `refuse` those it must NOT have (written `!<capability>`, as
 * `"!measurement-id"` or `"!patch:a19-analytics-live"`). A `!` that names no
 * capability, or a doubled `!!`, throws at declaration rather than skipping
 * or running by accident.
 */
export function splitNeeds(needs = []) {
  if (!Array.isArray(needs)) throw new TypeError(`scenario needs: a list of capabilities, got ${JSON.stringify(needs)}`);
  const want = [];
  const refuse = [];
  for (const need of needs) {
    if (typeof need !== "string") throw new TypeError(`scenario needs: each entry is a capability name, got ${JSON.stringify(need)}`);
    if (!need.startsWith("!")) {
      want.push(need);
      continue;
    }
    const name = need.slice(1).trim();
    if (!name || name.startsWith("!")) throw new TypeError(`scenario needs: ${JSON.stringify(need)} names no capability (write "!<capability>")`);
    refuse.push(name);
  }
  return { want, refuse };
}

/** Why this case is skipped on this target, or null to run it. */
export function skipReason(target, { tiers = ["local", "prod"], effects = [], needs = [], n = null, selected = selectedN() } = {}) {
  const { want, refuse } = splitNeeds(needs);
  if (!target) return "no target (E2E_TARGET is not set)";
  if (!tiers.includes(target.kind)) return `tier: runs on ${tiers.join("/")}, not ${target.kind}`;
  if (target.kind === "prod") {
    const mail = emailEffects(effects);
    if (mail.length) return `sends email: ${mail.join(", ")}`;
  }
  const missing = want.filter((c) => !target.capabilities?.has(c));
  if (missing.length) return `needs ${missing.join(", ")} (the ${target.kind} target lacks it)`;
  const present = refuse.filter((c) => target.capabilities?.has(c));
  if (present.length) return `needs no ${present.join(", ")} (the ${target.kind} target has it)`;
  if (n != null && selected && !selected.includes(n)) return `N=${n} not selected (--n ${selected.join(",")})`;
  return null;
}

/** The spec file that called scenario(), from the stack (relative to the repo). */
function callerFile() {
  const self = fileURLToPath(import.meta.url);
  for (const line of String(new Error().stack).split("\n").slice(1)) {
    const m = /(file:\/\/[^\s)]+?):\d+:\d+/.exec(line) ?? /\((\/[^\s)]+?):\d+:\d+\)/.exec(line);
    if (!m) continue;
    const file = m[1].startsWith("file:") ? fileURLToPath(m[1]) : m[1];
    if (file !== self) return file;
  }
  return null;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The command that runs one case again, as its evidence states it: `--spec
 * <file relative to the repo>` for a spec in e2e/specs/, `--spec-file
 * <absolute path>` for any other file (a scratch copy, lib/specfile.mjs).
 */
export function rerunCommand(runId, file, name) {
  const grep = `--grep '${escapeRe(name).replace(/'/g, "'\\''")}'`;
  if (!file) return `node e2e/run.mjs run --attach ${runId} ${grep}`;
  const inSpecs = relative(SPECS_DIR, file);
  const where = inSpecs && !inSpecs.startsWith("..") && !isAbsolute(inSpecs) ? `--spec ${relative(REPO_ROOT, file)}` : `--spec-file ${file}`;
  return `node e2e/run.mjs run --attach ${runId} ${where} ${grep}`;
}

const trampolines = new Map();
/**
 * node:test records a case's `file` as the place test() was CALLED, which for
 * every scenario would be this file — so ids would collide across specs and
 * the reporter could not tell two concurrently running spec files apart. The
 * call is therefore made from a one-line function whose sourceURL is the spec
 * file, and node:test attributes the case to the spec. (Measured: a direct
 * call reports e2e/lib/test.mjs, the trampoline reports the spec.)
 */
function declare(file) {
  if (!file) return (t, ...args) => t(...args);
  if (!trampolines.has(file)) {
    const url = pathToFileURL(file).href.replace(/\s/g, "%20");
    trampolines.set(file, new Function("test", "name", "options", "fn", `return test(name, options, fn);\n//# sourceURL=${url}`));
  }
  return trampolines.get(file);
}

/** The cases one declaration expands to: [{name, n, trial, skip}] (exported for the self-test). */
export function expand(name, opts = {}, target = currentTarget()) {
  const { n = null, trials = 1 } = opts;
  const ns = n == null ? [null] : Array.isArray(n) ? n : [n];
  const override = trialsOverride();
  const out = [];
  for (const N of ns) {
    const k = trialsPerN(trials, N, { override });
    for (let trial = 1; trial <= k; trial += 1) {
      const full = `${name}${N != null ? ` [N=${N}]` : ""}${k > 1 ? ` #${trial}` : ""}`;
      out.push({ name: full, n: N, trial, skip: skipReason(target, { ...opts, n: N }) });
    }
  }
  return out;
}

/**
 * A precondition of a case that is not the thing under test: throw
 * E2E_PRECONDITION, which FAILS the case even when it carries a defect tag.
 */
export function precondition(value, message) {
  if (value) return value;
  const err = new Error(`precondition: ${message}`);
  err.code = "E2E_PRECONDITION";
  throw err;
}

/** The failures a `defect:` case reports as its known defect (TODO); everything else FAILS. */
export function isDefectOracleFailure(err) {
  if (!err) return false;
  if (err.code === "E2E_DEFECT_ORACLE") return true;
  return err instanceof AssertionError || err.code === "ERR_ASSERTION";
}

function inconclusiveError(reason) {
  const err = new Error(`INCONCLUSIVE: ${reason}`);
  err.code = "E2E_INCONCLUSIVE";
  err.reason = String(reason).replace(/\s+/g, " ").trim() || "no reason given";
  return err;
}

/** The code of what ctx.notReproduced(reason) throws: a known defect's trial that never reached the defect's window (see the header). */
export const NOT_REPRODUCED_CODE = "E2E_NOT_REPRODUCED";

function notReproducedError(reason, defect) {
  const why = redactString(String(reason ?? "").replace(/\s+/g, " ").trim()) || "no reason given";
  const err = new Error(`NOT REPRODUCED: ${why}`);
  err.code = NOT_REPRODUCED_CODE;
  err.reason = why;
  err.defect = String(defect);
  return err;
}

// --- When the stack does not answer -------------------------------------------

/**
 * The Hosting emulator answers 504 itself ("Timed out waiting for function to
 * respond.") for a function that has not answered within 60 s: measured on
 * loaded shared stacks at 60,005–60,010 ms, on POST /folder-access,
 * /team-members, /organize, /view and /session. The product never answered
 * such a request, so nothing was measured. A quicker 504 is an answer, and
 * is judged.
 */
export const HOSTING_CUTOFF_MS = 59_000;

/** http.mjs's own deadline: the AbortController's reason, which fetch rejects with as it is. */
const CLIENT_DEADLINE_RE = /^timeout after \d+ ms$/;
/** gRPC status DEADLINE_EXCEEDED, the numeric `code` the Admin SDK's Firestore client puts on its error. */
const GRPC_DEADLINE_EXCEEDED = 4;
/**
 * The messages that code comes with: grpc-js's "4 DEADLINE_EXCEEDED:
 * Deadline exceeded after …" (measured: a read of a Firestore that never
 * answers), and google-gax's "Total timeout of API [<name> ]exceeded N
 * milliseconds …" when its retries run out of time. Each at the start of the
 * message: gax's "Exceeded maximum number of retries retrying error …" carries
 * the same code but counts tries, not time, and Firestore's retry settings
 * set no such count, so it is not taken, whatever error it quotes.
 */
const GRPC_DEADLINE_RE = /^4 DEADLINE_EXCEEDED: |^Total timeout of API (?:\S+ )?exceeded \d+ milliseconds\b/;
/** A message that starts with the request it is about: http.mjs's E2E_STATUS, openSession's E2E_SESSION. */
const REQUEST_IN_MESSAGE_RE = /^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS) (\S+?)(?=:\s|\s|$)/;

const isAssertion = (err) => err instanceof AssertionError || err?.code === "ERR_ASSERTION";

/** The ms `r` waited for its answer: `ms` (an http.mjs response, a User response entry), else respondedAt − sentAt (a User.capture row), else null. */
function answerMs(r) {
  if (Number.isFinite(r?.ms)) return r.ms;
  if (Number.isFinite(r?.respondedAt) && Number.isFinite(r?.sentAt)) return r.respondedAt - r.sentAt;
  return null;
}

/** A URL or path without its origin, query or fragment, as written (never percent-encoded again). */
function pathOnly(u) {
  return String(u).replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, "").split(/[?#]/)[0] || "/";
}

/** `r` as a request: "POST /access" (a User entry or capture row), "a request to /access" (an http.mjs response), or "a request". */
function requestOf(r) {
  if (r?.method && (r.path || r.url)) return `${r.method} ${r.path ?? pathOnly(r.url)}`;
  if (r?.url) return `a request to ${pathOnly(r.url)}`;
  return "a request";
}

/**
 * Is `r` the Hosting emulator's own 504 at its cut-off: status 504 after
 * HOSTING_CUTOFF_MS or more? `r` is an http.mjs response, a User response
 * entry (waitForResponse, findResponses), a User log.requests row or a
 * User.capture row. Anything without a measured wait is false.
 */
export function isHostingCutoff(r) {
  if (!r || typeof r !== "object") return false;
  const status = typeof r.status === "function" ? r.status() : r.status;
  const ms = answerMs(r);
  return Number(status) === 504 && ms != null && ms >= HOSTING_CUTOFF_MS;
}

/**
 * The error for a request the stack cut off: E2E_STACK_CUTOFF, its message
 * and `stackCut` "<what> answered 504 after <ms> ms, Hosting's cut-off for a
 * function that has not answered" (redacted), `response` the answer. `r` is
 * anything isHostingCutoff reads, or the ms alone. It does not check `r`:
 * answered() does.
 */
export function stackCutoff(what, r) {
  const res = typeof r === "number" ? { status: 504, ms: r } : (r ?? null);
  const ms = answerMs(res);
  const reason = redactString(`${what ?? requestOf(res)} answered 504 after ${ms == null ? "?" : Math.round(ms)} ms, Hosting's cut-off for a function that has not answered`);
  const err = new Error(reason);
  err.code = "E2E_STACK_CUTOFF";
  err.stackCut = reason;
  err.response = res;
  return err;
}

/**
 * `r`, unless it is Hosting's 504 at its cut-off (isHostingCutoff): then
 * throw stackCutoff(what, r). For a response the case reads itself, which no
 * helper refused: a raw http.mjs request, a page's response.
 *
 * `r` may also be a CLI run: a lib/cli.mjs runCli result or spawnCli handle,
 * whose `cut` (cliCut) is a string when the CLI printed a 504 at the cut-off.
 * Then it throws E2E_STACK_CUTOFF with that reason as `stackCut` (prefixed
 * "<what>: " when `what` is given), `response` null and `cli` {code, signal,
 * ms}; never its stdout. A run whose `cut` is null is returned as it is.
 */
export function answered(r, what) {
  if (isHostingCutoff(r)) throw stackCutoff(what ?? requestOf(r), r);
  const cut = r && typeof r === "object" && typeof r.stderr === "string" && typeof r.cut === "string" ? r.cut.trim() : "";
  if (cut) {
    const reason = redactString(what ? `${what}: ${cut}` : cut);
    const err = new Error(reason);
    err.code = "E2E_STACK_CUTOFF";
    err.stackCut = reason;
    err.response = null;
    const ran = r.exited ?? r;
    err.cli = { code: ran.code ?? null, signal: ran.signal ?? null, ms: Number.isFinite(ran.ms) ? ran.ms : null };
    throw err;
  }
  return r;
}

/**
 * Why the stack, not the product, failed with `err`, or null. Only these
 * qualify, and never an assertion, whatever its message:
 *   - E2E_STACK_CUTOFF, or any error whose `stackCut` is a string (answered(),
 *     stackCutoff(), or a spec's own);
 *   - an error carrying Hosting's cut-off 504 as `response` (http.mjs's
 *     E2E_STATUS, openSession's E2E_SESSION, any helper's), or as
 *     `res.response` (mcp.mjs's E2E_MCP_HTTP);
 *   - the http client's own deadline: a message of exactly "timeout after N ms";
 *   - the Admin SDK's own deadline on a Firestore call (a read, a batch): an
 *     error whose `code` is the number 4, gRPC's DEADLINE_EXCEEDED, and whose
 *     message is grpc-js's or google-gax's for it (GRPC_DEADLINE_RE);
 *   - any of these as the cause of ctx.oracle()'s E2E_DEFECT_ORACLE.
 * A quicker 504, another status, a precondition, a guard refusal and a wait
 * that ran out (eventually, Playwright, a toast) are null: the stack answered,
 * or may have. So is DEADLINE_EXCEEDED in the product's own words (a tool
 * error, a 500's body): the product answered, and is judged.
 */
export function stackDidNotAnswer(err) {
  let e = err;
  for (let depth = 0; depth < 4 && e?.code === "E2E_DEFECT_ORACLE"; depth += 1) e = e.cause;
  if (e == null || isAssertion(e) || e.code === "E2E_DEFECT_ORACLE" || e.code === "E2E_INCONCLUSIVE" || e.code === NOT_REPRODUCED_CODE) return null;
  if (typeof e.stackCut === "string" && e.stackCut.trim()) return redactString(e.stackCut.trim());
  if (e.code === "E2E_STACK_CUTOFF") return redactString(String(e.message));
  const msg = String(e?.message ?? e);
  for (const r of [e.response, e.res?.response]) {
    if (!isHostingCutoff(r)) continue;
    const m = REQUEST_IN_MESSAGE_RE.exec(msg);
    const mcp = /^(MCP \S+?):/.exec(msg);
    const what = m ? `${m[1]} ${pathOnly(m[2])}` : mcp ? mcp[1] : requestOf(r);
    return redactString(`${what} answered 504 after ${Math.round(answerMs(r))} ms, Hosting's cut-off for a function that has not answered`);
  }
  if (CLIENT_DEADLINE_RE.test(msg)) return `a request to the stack got no answer: ${msg}`;
  if (e.code === GRPC_DEADLINE_EXCEEDED && GRPC_DEADLINE_RE.test(msg)) {
    return redactString(`a Firestore call through the Admin SDK got no answer within its deadline: ${msg.split("\n")[0].slice(0, 240)}`);
  }
  return null;
}

/** What a spec's own `also` may excuse: never an assertion, a known defect's oracle, an INCONCLUSIVE, a NOT REPRODUCED, a breach or a guard refusal. */
function alsoMayJudge(err) {
  if (err == null || isAssertion(err)) return false;
  return !/^E2E_(DEFECT_ORACLE|INCONCLUSIVE|NOT_REPRODUCED|ISOLATION|GUARD)/.test(String(err.code ?? ""));
}

/**
 * A case body whose failure because the stack did not answer
 * (stackDidNotAnswer) ends INCONCLUSIVE instead: reason "the stack did not
 * answer, so nothing was measured: <why>", the failure kept as its `cause`
 * (error.txt) and in stack-did-not-answer.txt. Every other failure stands.
 * `also(err, ctx)` → a reason or null is a spec's own wider evidence,
 * consulted only when stackDidNotAnswer found none and never for what
 * alsoMayJudge refuses; when it throws, the original failure stands.
 * `scenario(name, {inconclusiveOnStackTimeout: true}, fn)` is the same, and
 * `scenario(name, {inconclusiveOnPageStall: true}, fn)` is
 * `onAnsweringStack(fn, {also: pageStall})`.
 */
export function onAnsweringStack(body, { also = null } = {}) {
  if (typeof body !== "function") throw new TypeError(`onAnsweringStack(body): body is the case's (ctx) => …, got ${typeof body}`);
  if (also != null && typeof also !== "function") throw new TypeError(`onAnsweringStack: also is (err, ctx) => reason | null, got ${typeof also}`);
  return async (ctx) => {
    try {
      return await body(ctx);
    } catch (err) {
      let why = stackDidNotAnswer(err);
      if (!why && also && alsoMayJudge(err)) {
        try {
          why = await also(err, ctx);
        } catch (judging) {
          try {
            ctx?.ev?.step?.(`onAnsweringStack: also threw (${String(judging?.message ?? judging).split("\n")[0]}); the failure stands`);
          } catch {}
          throw err;
        }
      }
      if (typeof why !== "string" || !why.trim()) throw err;
      try {
        ctx?.ev?.text?.("stack-did-not-answer.txt", `${err?.stack ?? err}${err?.cause ? `\ncause: ${err.cause?.stack ?? err.cause}` : ""}`);
      } catch {}
      const out = inconclusiveError(`the stack did not answer, so nothing was measured: ${redactString(why.trim())}`);
      out.cause = err;
      throw out;
    }
  };
}

// --- Sending again what the stack did not answer -------------------------------

/**
 * Why `x` is the stack not answering a call, or null. For an error, what
 * stackDidNotAnswer says. For a value a call returned (an answer its `expect`
 * let through): Hosting's cut-off 504 (isHostingCutoff) on it or on its
 * `response` (a seed.mjs or grant.mjs result), or a lib/cli.mjs run whose
 * `cut` names one. Any other answer, however slow and whatever its status, is
 * the product's, and null.
 */
export function unanswered(x) {
  if (x instanceof Error) return stackDidNotAnswer(x);
  if (x == null || typeof x !== "object") return null;
  for (const r of [x, x.response]) {
    if (isHostingCutoff(r)) return redactString(`${requestOf(r)} answered 504 after ${Math.round(answerMs(r))} ms, Hosting's cut-off for a function that has not answered`);
  }
  if (typeof x.stderr === "string" && typeof x.cut === "string" && x.cut.trim()) return redactString(x.cut.trim());
  return null;
}

/** untilLanded's options, so a misspelt one throws instead of being ignored. */
const LANDED_OPTIONS = Object.freeze(["attempts", "lookupMs", "intervalMs", "backoffMs", "stopAt", "onFail"]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * What untilLanded with `stopAt: "budget"` keeps between its own end and the
 * case's budget (ctx.budgetEndsAt): it gives up this long before the budget
 * would run out, so that its INCONCLUSIVE, not the budget's E2E_CASE_BUDGET,
 * is what the case judges.
 */
const LANDED_BUDGET_SLACK_MS = 2_000;

/** `effect()` raced against `end` (a Date.now() time): a read still out then counts as "not yet", and its late outcome is dropped. */
function readBy(effect, end) {
  const read = Promise.resolve().then(effect);
  read.catch(() => undefined);
  let timer;
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("the read had not answered when the look's time ran out")), Math.max(0, end - Date.now()));
  });
  return Promise.race([read, late]).finally(() => clearTimeout(timer));
}

/**
 * Poll `effect` until it gives a value (anything but null, undefined or
 * false) or `lookupMs` pass: {value, ms, error}. Its throws count as "not
 * yet". With `until` (a Date.now() time) the look also ends then, and each
 * read is raced against its end, so the look never outlasts it.
 */
async function lookFor(effect, lookupMs, intervalMs, until = null) {
  const t0 = Date.now();
  const end = until === null ? t0 + lookupMs : Math.min(t0 + lookupMs, until);
  let error = null;
  for (;;) {
    try {
      const v = until === null ? await effect() : await readBy(effect, end);
      if (v !== null && v !== undefined && v !== false) return { value: v, ms: Date.now() - t0, error: null };
    } catch (err) {
      error = String(err?.message ?? err).split("\n")[0].slice(0, 200);
    }
    const left = end - Date.now();
    if (left <= 0) return { value: null, ms: Date.now() - t0, error };
    await sleep(Math.min(intervalMs, left));
  }
}

/**
 * Send a call again when the stack did not answer it (unanswered: Hosting's
 * 504 at its cut-off, the client's own deadline, the Admin SDK's), and end the
 * case INCONCLUSIVE when that keeps happening. On a loaded shared stack a
 * function the proxy gave up on often goes on to finish, so for a call whose
 * effect can be read back, `effect` (async () => the effect, or null,
 * undefined or false while it is not there) is polled every `intervalMs` for
 * up to `lookupMs` after each such failure, before anything is sent again, and
 * taken when found. `effect` null is a call that may simply be sent again (an
 * idempotent one, such as POST /session): then `backoffMs` passes instead.
 *
 * Resolves {out, landed, attempts}: `out` the call's own answer (any answer
 * at all, a refusal included; a throw that is an answer is rethrown as it
 * is), or `landed` the effect found instead; `attempts` how many times it was
 * sent. Each failure, look and resend is a step of the case. After `attempts`
 * sends with no answer and no effect, or a failure at or past `stopAt` (a
 * Date.now() time: none is sent after it), it throws E2E_INCONCLUSIVE: "the
 * stack did not answer, so nothing was measured: <what> got no answer N
 * time(s) (the last: …)", with the last failure as its cause and in
 * stack-did-not-answer.txt. `onFail({attempt, why, error, out})` runs at each
 * failure, before the look (a seed helper ledgers the id it named there).
 *
 * `stopAt: "budget"` ties it to the case's budget instead (ctx.budgetEndsAt,
 * which caseBudget sets: inconclusiveOnCaseTimeout, or a body wrapped in
 * caseBudget; a ctx without one throws TypeError before anything is sent).
 * Everything it does then ends LANDED_BUDGET_SLACK_MS (2 s) before the
 * budget would: a look is cut to end by then (each read raced against it,
 * so a read the stack does not answer cannot hold it), and the call is sent
 * again only while one more send and what follows it still fit: the longest
 * send that went unanswered so far, plus `lookupMs` with an effect or
 * `backoffMs` without. Otherwise it is not sent again, and the INCONCLUSIVE
 * says so ("; it was not sent again: one more send and its look, about N ms,
 * would not end within the case's budget (M ms left)"). The first send is
 * always made. So a stack that keeps not answering ends the case through
 * untilLanded, never as E2E_CASE_BUDGET mid-look.
 */
export async function untilLanded(ctx, what, send, effect, options = {}) {
  if (ctx == null || typeof ctx !== "object") throw new TypeError(`untilLanded(ctx, what, send, effect): ctx is the case's ctx, got ${ctx === null ? "null" : typeof ctx}`);
  if (typeof what !== "string" || !what.trim()) throw new TypeError(`untilLanded: what names the call ("POST /publish <id>"), got ${JSON.stringify(what) ?? String(what)}`);
  if (typeof send !== "function") throw new TypeError(`untilLanded: send is async () => the call's answer, got ${typeof send}`);
  if (effect !== null && typeof effect !== "function") throw new TypeError(`untilLanded: effect is async () => the call's effect (null while it is not there), or null for a call that may simply be sent again, got ${typeof effect}`);
  if (options === null || typeof options !== "object" || Array.isArray(options)) throw new TypeError(`untilLanded: options is {${LANDED_OPTIONS.join(", ")}}`);
  const unknown = Object.keys(options).filter((k) => !LANDED_OPTIONS.includes(k));
  if (unknown.length > 0) throw new TypeError(`untilLanded: unknown option ${unknown.map((k) => JSON.stringify(k)).join(", ")} (known: ${LANDED_OPTIONS.join(", ")})`);
  const { attempts = 3, lookupMs = 60_000, intervalMs = 2_000, backoffMs = 5_000, stopAt = null, onFail = null } = options;
  if (!Number.isInteger(attempts) || attempts < 1) throw new TypeError(`untilLanded: attempts is how many times it may be sent, a whole number 1 or more, got ${JSON.stringify(attempts) ?? String(attempts)}`);
  for (const [k, v] of [["lookupMs", lookupMs], ["backoffMs", backoffMs]]) {
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw new TypeError(`untilLanded: ${k} is a number of ms, 0 or more, got ${JSON.stringify(v) ?? String(v)}`);
  }
  if (typeof intervalMs !== "number" || !Number.isFinite(intervalMs) || intervalMs <= 0) throw new TypeError(`untilLanded: intervalMs is a number of ms above 0, got ${JSON.stringify(intervalMs) ?? String(intervalMs)}`);
  const byBudget = stopAt === "budget";
  if (stopAt !== null && !byBudget && (typeof stopAt !== "number" || !Number.isFinite(stopAt))) {
    throw new TypeError(`untilLanded: stopAt is a Date.now() time or null, or "budget" for the case's own budget, got ${JSON.stringify(stopAt) ?? String(stopAt)}`);
  }
  if (onFail !== null && typeof onFail !== "function") throw new TypeError(`untilLanded: onFail is ({attempt, why, error, out}) => …, or null, got ${typeof onFail}`);
  // With the case's budget: when everything here must be over, read once (the budget does not move).
  let endBy = null;
  if (byBudget) {
    const endsAt = ctx.budgetEndsAt;
    if (typeof endsAt !== "number" || !Number.isFinite(endsAt)) {
      throw new TypeError(`untilLanded: stopAt "budget" reads the case's budget from ctx.budgetEndsAt, which caseBudget sets (scenario's inconclusiveOnCaseTimeout: true, or a body wrapped in caseBudget); this ctx has none (got ${JSON.stringify(endsAt) ?? String(endsAt)})`);
    }
    endBy = endsAt - LANDED_BUDGET_SLACK_MS;
  }
  const step = (text) => {
    try {
      ctx.step?.(text);
    } catch {}
  };
  let longestSendMs = 0; // the longest send the stack left unanswered so far: what one more may cost
  for (let attempt = 1; ; attempt += 1) {
    let out;
    let thrown = null;
    const sentAt = Date.now();
    try {
      out = await send();
    } catch (err) {
      thrown = err;
    }
    const why = thrown ? stackDidNotAnswer(thrown) : unanswered(out);
    if (!why) {
      if (thrown) throw thrown;
      return { out, landed: null, attempts: attempt };
    }
    longestSendMs = Math.max(longestSendMs, Date.now() - sentAt);
    const failure = thrown ?? Object.assign(new Error(why), { code: "E2E_STACK_CUTOFF", stackCut: why, response: out?.response ?? null });
    if (onFail) await onFail({ attempt, why, error: thrown, out: thrown ? undefined : out });
    let looked = null;
    if (effect && byBudget && endBy - Date.now() <= 0) {
      looked = { value: null, ms: 0, error: null, skipped: true };
      step(`environment: ${what}: ${why}; no time is left in the case's budget to look for its effect (attempt ${attempt} of ${attempts})`);
    } else if (effect) {
      const room = byBudget ? endBy - Date.now() : Infinity;
      const cut = room < lookupMs;
      step(cut
        ? `environment: ${what}: ${why}; looking for its effect for up to ${room} ms, all the case's budget leaves (attempt ${attempt} of ${attempts})`
        : `environment: ${what}: ${why}; looking for its effect for up to ${lookupMs} ms before it is sent again (attempt ${attempt} of ${attempts})`);
      looked = await lookFor(effect, lookupMs, intervalMs, byBudget ? endBy : null);
      looked.cut = cut;
      if (looked.value !== null) {
        step(`environment: ${what} had taken effect though the stack never answered it (seen ${looked.ms} ms into the look); taken, not sent again`);
        return { out: null, landed: looked.value, attempts: attempt };
      }
    }
    const past = stopAt !== null && !byBudget && Date.now() >= stopAt;
    // One more send, then its look (or, without an effect, the back-off before it): does it end inside the budget?
    const needMs = longestSendMs + (effect ? lookupMs : backoffMs);
    const leftMs = byBudget ? endBy - Date.now() : Infinity;
    const noRoom = byBudget && attempt < attempts && needMs > leftMs;
    if (attempt >= attempts || past || noRoom) {
      let after = "";
      if (effect && looked?.skipped) {
        after = attempt === 1 ? ", and no time was left in the case's budget to look for its effect" : `, and it had not taken effect ${lookupMs} ms after each but the last, after which no time was left in the case's budget to look`;
      } else if (effect && looked?.cut) {
        after = attempt === 1 ? `, and it had not taken effect ${looked.ms} ms after it, all the case's budget left` : `, and it had not taken effect ${lookupMs} ms after each but the last, nor ${looked.ms} ms after the last, all the case's budget left`;
      } else if (effect) {
        after = `, and it had not taken effect ${lookupMs} ms after ${attempt === 1 ? "it" : "each"}`;
      }
      if (effect && looked?.error) after += ` (the last look: ${looked.error})`;
      let stop = "";
      if (past && attempt < attempts) stop = "; past its stopAt, it was not sent again";
      else if (noRoom) stop = `; it was not sent again: one more send ${effect ? "and its look" : "after its back-off"}, about ${Math.round(needMs)} ms, would not end within the case's budget (${Math.max(0, Math.round(leftMs))} ms left)`;
      try {
        ctx.ev?.text?.("stack-did-not-answer.txt", `${failure?.stack ?? failure}`);
      } catch {}
      const err = inconclusiveError(`the stack did not answer, so nothing was measured: ${redactString(`${what} got no answer ${attempt} time(s) (the last: ${why})${after}${stop}`)}`);
      err.cause = failure;
      throw err;
    }
    step(`environment: ${what}: ${why}${effect ? `, and no effect within ${lookupMs} ms` : ""}; sending it again (attempt ${attempt + 1} of ${attempts})`);
    if (!effect && backoffMs > 0) await sleep(backoffMs);
  }
}

// --- When a page saw the stack stall --------------------------------------------

/**
 * How far back pageStall looks when the failure names no wait of its own (a
 * precondition, a Playwright TimeoutError without its length): the longest
 * wait a spec commonly makes (a mailbox, 120 s) and a margin.
 */
export const STALL_WINDOW_MS = 130_000;
/** What pageStall adds before a wait that names its length, so a stall already under way as the wait began counts. */
const STALL_MARGIN_MS = 10_000;

/**
 * A wait's own words, and how long it waited: a lib wait ("… within N ms":
 * eventually, User's waits, toasts, a mailbox, caseBudget's), Playwright's
 * ("Timeout N ms exceeded"), http.mjs's deadline ("timeout after N ms").
 * Read on the message's first line only: what follows is a call log, or the
 * last error a poll saw.
 */
const WAIT_RE = /\bwithin (\d+) ?ms\b|\bTimeout (\d+) ?ms exceeded\b|^timeout after (\d+) ms$/;
/** lib/logs.mjs's wait, E2E_LOG_TIMEOUT: "no line matching … after N ms". */
const LOG_WAIT_RE = /\bafter (\d+) ms\b/;
/** Waits that are the harness's own, never the stack's: a spare port, a barrier among the case's own peers, the case's timeout. */
const HARNESS_WAITS = new Set(["E2E_SPARE_TIMEOUT", "E2E_SYNC_TIMEOUT", "E2E_TIMEOUT"]);
/** Never a wait: an answer the product gave (a status, a tool error), a known defect's oracle, an INCONCLUSIVE, a NOT REPRODUCED, a breach, a refusal, a cut-off already named. */
const NOT_A_WAIT_RE = /^E2E_(DEFECT_ORACLE|INCONCLUSIVE|NOT_REPRODUCED|ISOLATION|GUARD|STATUS$|SESSION$|MCP_|WINDOW_OPEN|STACK_CUTOFF)/;
/** What the Firestore web SDK logs when its backend has not answered for 10 s ("Could not reach Cloud Firestore backend. Backend didn't respond within 10 seconds…"). */
const FIRESTORE_LOST_RE = /Could not reach Cloud Firestore backend/;

const codeOf = (e) => String(e?.code ?? "");
/** May `e` be judged as a wait at all: an object, no assertion, no answer it carries, none of the codes above. */
const mayBeWait = (e) => e != null && typeof e === "object" && !isAssertion(e) && !HARNESS_WAITS.has(codeOf(e)) && !NOT_A_WAIT_RE.test(codeOf(e)) && e.response == null && e.res == null;

/** `e` as a wait that ran out, {ms} (ms null when it does not say), or null. */
function waitIn(e) {
  const line = String(e?.message ?? "").split("\n")[0];
  const m = (codeOf(e) === "E2E_LOG_TIMEOUT" ? LOG_WAIT_RE.exec(line) : null) ?? WAIT_RE.exec(line);
  if (m) return { ms: Number(m[1] ?? m[2] ?? m[3]) };
  if (e?.name === "TimeoutError" || codeOf(e) === "E2E_EVENTUALLY_TIMEOUT" || codeOf(e) === "E2E_LOG_TIMEOUT") return { ms: null };
  return null;
}

/**
 * What kind of failure `err` is for pageStall: {kind: "wait" | "precondition",
 * ms} or null. A wait that ran out (its own words, or one level down as its
 * `cause`: a helper that rewords a Playwright timeout) or E2E_PRECONDITION;
 * never an assertion, an error that carries the answer it refused
 * (`response`, `res`: the product answered, and is judged), a known defect's
 * oracle or the harness's own waits.
 */
function waitOf(err) {
  if (!mayBeWait(err)) return null;
  if (codeOf(err) === "E2E_PRECONDITION") return { kind: "precondition", ms: null };
  const own = waitIn(err);
  if (own) return { kind: "wait", ...own };
  const via = mayBeWait(err.cause) ? waitIn(err.cause) : null;
  return via ? { kind: "wait", ...via } : null;
}

/** The users `ctx` has made, without making a pool: ctx.usersSoFar, else ctx.users.users; [] when neither can be read. */
function usersOf(ctx) {
  try {
    const list = Array.isArray(ctx?.usersSoFar) ? ctx.usersSoFar : ctx?.users?.users;
    return Array.isArray(list) ? list : [];
  } catch {
    return []; // the case already timed out: ctx.users throws
  }
}

/**
 * What the case's pages saw of the stack stalling at or after `since` (a
 * Date.now() time): `cut`, each a request answered Hosting's cut-off 504
 * then (User.responses, else log.requests), and `lost`, each a page whose
 * Firestore client lost the emulator then (its console line, or its network
 * test, log.sdkProbes).
 */
function stallSeen(users, since) {
  const cut = [];
  const lost = [];
  for (const u of users) {
    const name = String(u?.name ?? "a user");
    const rows = Array.isArray(u?.responses) ? u.responses : Array.isArray(u?.log?.requests) ? u.log.requests : [];
    for (const r of rows) {
      if (!isHostingCutoff(r)) continue;
      // When it was answered, on Date.now()'s clock: an entry's `at`, a log row's `t` + `ms`.
      const at = Number.isFinite(r.at) ? r.at : Number.isFinite(r.t) ? r.t + answerMs(r) : null;
      if (at == null || at < since) continue;
      cut.push(`${name}: ${requestOf(r)} 504 after ${Math.round(answerMs(r))} ms`);
    }
    if ((u?.log?.console ?? []).some((c) => Number(c?.t) >= since && FIRESTORE_LOST_RE.test(String(c?.text ?? "")))) lost.push(`${name}: "Could not reach Cloud Firestore backend"`);
    const probes = (u?.log?.sdkProbes ?? []).filter((p) => Number(p?.t) >= since).length;
    if (probes) lost.push(`${name}: ${probes === 1 ? "the Firestore SDK's network test" : `${probes} Firestore SDK network tests`}`);
  }
  return { cut, lost };
}

/** A Date.now() time from a number, or from an ISO string (http.mjs's record `t`); null for anything else. */
function timeOf(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

/**
 * Evidence's http lines (the records http.mjs logs into a case's evidence,
 * redacted, one per request and per redirect hop) as rows: {t (the hop's
 * start, a Date.now() time), at (t + ms: when it was answered or failed),
 * actor, method, url (redacted, as http.jsonl has it), path (no origin,
 * query or fragment), status (null when nothing answered), ms, error (the
 * fetch's own failure, http.mjs's "timeout after N ms" among them, or
 * "guard refused: <rule>"; else null)}. A line that is no request record (a
 * withheld one) is left out; every value is null when it cannot be read.
 */
function requestRows(lines) {
  const rows = [];
  for (const line of Array.isArray(lines) ? lines : []) {
    let r;
    try {
      r = typeof line === "string" ? JSON.parse(line) : line;
    } catch {
      continue;
    }
    if (!r || typeof r !== "object" || typeof r.method !== "string") continue;
    const t = timeOf(r.t);
    const ms = Number.isFinite(r.ms) ? r.ms : null;
    const url = typeof r.url === "string" ? r.url : null;
    const refused = r.guard?.refused ? `guard refused: ${r.guard.rule ?? r.guard.reason ?? "?"}` : null;
    rows.push({
      t,
      at: t != null && ms != null ? t + ms : null,
      actor: typeof r.actor === "string" ? r.actor : null,
      method: r.method,
      url,
      path: url ? pathOnly(url) : null,
      status: Number.isFinite(r.status) ? r.status : null,
      ms,
      error: typeof r.error === "string" ? r.error : refused,
    });
  }
  return rows;
}

/** The case's own requests, ctx.requests() (ctx.requests(options) when options are given); [] when ctx has none, or reading them throws or gives no array. */
function requestsOf(ctx, options = undefined) {
  try {
    const rows = typeof ctx?.requests !== "function" ? null : options === undefined ? ctx.requests() : ctx.requests(options);
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

/** A hop http.mjs pendingRequests lists (sent, not yet answered) as a ctx.requests() row: no status, ms or answer time yet, and `pending: true`. */
function pendingRow(h) {
  const t = timeOf(h?.t);
  const url = typeof h?.url === "string" ? h.url : null;
  return { t, at: null, actor: typeof h?.actor === "string" ? h.actor : null, method: String(h?.method ?? "?"), url, path: url ? pathOnly(url) : null, status: null, ms: null, error: null, pending: true };
}

/** Each of `rows` (ctx.requests()) answered Hosting's cut-off 504 at or after `since`, as a line: "owner: POST /publish 504 after 60005 ms". */
function requestsCut(rows, since) {
  const out = [];
  for (const r of rows) {
    if (!isHostingCutoff(r)) continue;
    const t = timeOf(r.t);
    const at = Number.isFinite(r.at) ? r.at : t != null ? t + answerMs(r) : null;
    if (at == null || at < since) continue;
    out.push(`${typeof r.actor === "string" && r.actor ? r.actor : "this case"}: ${requestOf(r)} 504 after ${Math.round(answerMs(r))} ms`);
  }
  return out;
}

/**
 * The evidence pageStall reads, for a spec's own use or User.waitShown's:
 * what `users` (BrowserPool users, or objects shaped as them: `name`,
 * `responses` or `log.requests`, `log.console`, `log.sdkProbes`) saw of the
 * stack stalling at or after `since`, a Date.now() time. `cut`: a line per
 * response answered Hosting's cut-off 504 then ("owner: POST /session 504
 * after 60004 ms"); `lost`: a line per page whose Firestore client lost the
 * emulator then (its console's "Could not reach Cloud Firestore backend", or
 * the SDK's network test, which it sends each time its Listen channel errors).
 * A quicker 504, or nothing, is no evidence. Throws TypeError unless `users`
 * is an array and `since` a number.
 */
export function stallEvidence(users, since) {
  if (!Array.isArray(users)) throw new TypeError(`stallEvidence(users, since): users is an array of users, got ${users === null ? "null" : typeof users}`);
  if (typeof since !== "number" || !Number.isFinite(since)) throw new TypeError(`stallEvidence: since is a Date.now() time, got ${JSON.stringify(since) ?? String(since)}`);
  return stallSeen(users, since);
}

const LIB_DIR = `${dirname(fileURLToPath(import.meta.url))}${sep}`;
/** One V8 stack frame: "at [async ]fn (where:line:col)" or "at [async ]where:line:col". */
const FRAME_RE = /^\s*at (?:async )?(?:(.*?) \()?(.+?):(\d+):(\d+)\)?$/;

/** The frames of `stack` that name a file: [{fn, path, line}], node's own and node_modules' left out. */
function framesOf(stack) {
  const out = [];
  for (const l of String(stack ?? "").split("\n")) {
    const m = FRAME_RE.exec(l);
    if (!m) continue;
    let path = m[2];
    if (path.startsWith("file://")) {
      try {
        path = fileURLToPath(path);
      } catch {
        continue;
      }
    }
    if (!path.startsWith(sep) || path.includes(`${sep}node_modules${sep}`)) continue;
    out.push({ fn: (m[1] ?? "").trim(), path, line: Number(m[3]) });
  }
  return out;
}

/**
 * Where a failure came from, read from its stack (else its cause's): the
 * first frame outside e2e/lib (a spec, a self-test), by file name and line,
 * and the outermost e2e/lib call it made, as "a19-account.spec.mjs:244 (via
 * User.waitForToast, browser.mjs:2129)". A stack that names no such frame
 * gives the lib call alone ("User.poll, browser.mjs:2145"); one that names
 * neither, null. Never a directory: no absolute path reaches a reason.
 */
export function callSite(err) {
  for (const e of [err, err?.cause]) {
    const frames = framesOf(e?.stack);
    const i = frames.findIndex((f) => !f.path.startsWith(LIB_DIR));
    const libs = (i < 0 ? frames : frames.slice(0, i)).filter((f) => f.path.startsWith(LIB_DIR));
    const lib = libs.at(-1);
    const libText = lib ? `${lib.fn ? `${lib.fn}, ` : ""}${relative(LIB_DIR, lib.path)}:${lib.line}` : null;
    if (i >= 0) return `${basename(frames[i].path)}:${frames[i].line}${libText ? ` (via ${libText})` : ""}`;
    if (libText) return libText;
  }
  return null;
}

/**
 * Why a wait that ran out, or a precondition, may be the stack's and not the
 * product's: a reason, or null. For onAnsweringStack's `also` (as
 * `inconclusiveOnPageStall: true` passes it), or a spec's own `also` to call.
 *
 * Only `err` that is a wait that ran out (waitOf: "… within N ms",
 * Playwright's "Timeout N ms exceeded", eventually's E2E_EVENTUALLY_TIMEOUT,
 * logs' E2E_LOG_TIMEOUT, either one level down as the cause) or a
 * precondition, and only with evidence that a page of this case saw the
 * stack stall in that wait's window: a response answered Hosting's cut-off
 * 504 (isHostingCutoff) or the page's Firestore client losing the emulator
 * (the SDK's console line "Could not reach Cloud Firestore backend", or its
 * network test, log.sdkProbes). With `requests: true`, a request the case
 * made itself from Node (ctx.requests(): any http.mjs client inside the case,
 * mcp.mjs's, a session's) answered Hosting's cut-off 504 in that window is
 * the same evidence: the stack it waited on stalled, page or not. Off by
 * default, so a call without it judges as it always did. The window is the
 * wait's own length plus `marginMs` back from `now`, or `windowMs` when the
 * failure names no length.
 * Never an assertion, an error carrying the answer it refused, a known
 * defect's oracle, a guard refusal, a breach or the harness's own waits (a
 * sync barrier, a spare port). The reason names the evidence, the window, and
 * the failure with its call site (callSite).
 */
export function pageStall(err, ctx, { windowMs = STALL_WINDOW_MS, marginMs = STALL_MARGIN_MS, now = Date.now(), requests = false } = {}) {
  for (const [k, v] of [["windowMs", windowMs], ["marginMs", marginMs], ["now", now]]) {
    if (!Number.isFinite(v) || v < 0) throw new TypeError(`pageStall: ${k} is a number of ms, 0 or more, got ${JSON.stringify(v) ?? String(v)}`);
  }
  if (typeof requests !== "boolean") throw new TypeError(`pageStall: requests is true (count the case's own requests, ctx.requests()) or false, got ${JSON.stringify(requests) ?? String(requests)}`);
  const wait = waitOf(err);
  if (!wait) return null;
  const spanMs = wait.ms != null ? wait.ms + marginMs : windowMs;
  const { cut, lost } = stallSeen(usersOf(ctx), now - spanMs);
  const own = requests ? requestsCut(requestsOf(ctx), now - spanMs) : [];
  if (cut.length === 0 && lost.length === 0 && own.length === 0) return null;
  const list = (xs) => `${xs.slice(0, 3).join("; ")}${xs.length > 3 ? `; and ${xs.length - 3} more` : ""}`;
  const seen = [
    cut.length ? `a page's request got Hosting's cut-off 504 (${list(cut)})` : null,
    lost.length ? `a page's Firestore client lost the emulator (${list(lost)})` : null,
    own.length ? `a request this case made got Hosting's cut-off 504 (${list(own)})` : null,
  ].filter(Boolean).join(", and ");
  const what = wait.kind === "precondition" ? "a precondition failed" : "a wait ran out";
  const first = String(err.message ?? err).split("\n")[0].slice(0, 200);
  return redactString(`${seen}, in the ${Math.round(spanMs / 1000)} s before ${what} — the failure, at ${callSite(err) ?? "an unknown call site"}: ${first}`);
}

// --- When the emulator killed functions under load -------------------------------

/** The Firestore emulator giving up on a transaction's lock ("10 ABORTED: Transaction lock timeout."), measured on loaded shared stacks. */
const LOCK_TIMEOUT_RE = /\bABORTED: Transaction lock timeout\b/;
/** The Functions emulator's line when an unhandled error ends a function: on its own, as likely the product's error as the stack's. */
const KILLED_RE = /Your function was killed because it raised an unhandled error/;
/** The Functions emulator's line when a function ran past its 60 s limit: on its own, as likely the product hanging. */
const TIMED_OUT_60_RE = /Your function timed out after ~60s/;
/** Hosting's access line for a request it answered 504 (`"POST /access HTTP/1.1" 504 `): the product never answers 504, so this is Hosting's cut-off. */
const HOSTING_504_LINE_RE = /^i\s+hosting: .*"[A-Z]+ \S+ HTTP\/[\d.]+" 504 /;
/** How many lines after its lock timeout a kill line may come and still be that error's: its stack trace, with other functions' lines between. */
const LOCK_KILL_SPAN_LINES = 60;

const hasCapability = (t, c) => (t?.capabilities instanceof Set ? t.capabilities.has(c) : Array.isArray(t?.capabilities) && t.capabilities.includes(c));

/** The stack's emulators.log size as the case begins (ctx.logSince), or null on a target without the "logs" capability. */
function logSinceOf(target) {
  if (target?.kind !== "local" || !target.runId || !hasCapability(target, "logs")) return null;
  try {
    return logMark({ target });
  } catch {
    return null;
  }
}

/**
 * What the Functions emulator's log `text` says it killed: `lockKills`, each
 * a kill line within LOCK_KILL_SPAN_LINES after an unpaired lock-timeout line
 * (oldest first); `otherKills`, every other kill line; `timedOut`, the 60 s
 * limit's lines; `hosting504`, Hosting's 504 access lines.
 */
function killsIn(text) {
  const pending = [];
  let lockKills = 0;
  let otherKills = 0;
  let timedOut = 0;
  const hosting504 = [];
  String(text).split("\n").forEach((line, i) => {
    if (LOCK_TIMEOUT_RE.test(line)) {
      pending.push(i);
    } else if (KILLED_RE.test(line)) {
      while (pending.length && i - pending[0] > LOCK_KILL_SPAN_LINES) pending.shift();
      if (pending.length) {
        pending.shift();
        lockKills += 1;
      } else {
        otherKills += 1;
      }
    } else if (TIMED_OUT_60_RE.test(line)) {
      timedOut += 1;
    } else if (HOSTING_504_LINE_RE.test(line)) {
      hosting504.push(line);
    }
  });
  return { lockKills, otherKills, timedOut, hosting504 };
}

/**
 * Why a wait that ran out may be the stack's and not the product's, read
 * from the emulator's own log: a reason, or null. For onAnsweringStack's
 * `also` (as `inconclusiveOnFunctionKill: true` passes it), or a spec's own
 * `also` to call.
 *
 * Only `err` that is a wait that ran out (as pageStall reads one, but never a
 * precondition), and never one that says something EXTRA arrived
 * (`missingOnly === false`, as expectMailboxes sets it, on the error or its
 * cause): mail cannot be unsent, and one too many is the product's. The
 * evidence is the stack's emulators.log from `since` (default ctx.logSince,
 * the case's start) on:
 *   - a function killed for a transaction lock timeout: the emulator's
 *     "Your function was killed because it raised an unhandled error" within
 *     60 lines after a "ABORTED: Transaction lock timeout" not yet paired.
 *     A kill for any other error is no evidence: it may be the product's;
 *   - a function stopped at the 60 s limit ("Your function timed out after
 *     ~60s") while Hosting answered a request 504 (its cut-off) in the same
 *     span: the stack-wide signature of load. Either alone is no evidence.
 * The log does not say which function a kill ended, and a shared stack runs
 * other specs' functions: this says the measurement was not reliable, never
 * that the product passed. Null without a mark (a target without the "logs"
 * capability) or a log to read. The kills' counts and Hosting's 504 lines go
 * to the case's `function-kills.json`. The reason names the evidence and the
 * failure at its call site (callSite).
 */
export function functionKill(err, ctx, { since = ctx?.logSince ?? null, target = ctx?.target ?? null } = {}) {
  if (since !== null && (!Number.isInteger(since) || since < 0)) {
    throw new TypeError(`functionKill: since is a byte offset into the emulators log (a logMark), 0 or more, or null, got ${JSON.stringify(since) ?? String(since)}`);
  }
  const wait = waitOf(err);
  if (!wait || wait.kind !== "wait") return null;
  if (err.missingOnly === false || err.cause?.missingOnly === false) return null;
  if (since === null || !target?.runId || !hasCapability(target, "logs")) return null;
  let text;
  try {
    text = readLog(logFile(target.runId), since);
  } catch {
    return null;
  }
  const k = killsIn(text);
  const seen = [];
  if (k.lockKills > 0) seen.push(`the emulator killed ${k.lockKills} function(s) for a transaction lock timeout ("ABORTED: Transaction lock timeout")`);
  if (k.timedOut > 0 && k.hosting504.length > 0) seen.push(`the emulator stopped ${k.timedOut} function(s) at its 60 s limit while Hosting answered ${k.hosting504.length} request(s) 504`);
  if (seen.length === 0) return null;
  try {
    ctx?.ev?.json?.("function-kills", { since, lockKills: k.lockKills, otherKills: k.otherKills, timedOut: k.timedOut, hosting504: k.hosting504.length, hosting504Lines: k.hosting504.slice(0, 20).map((l) => redactString(l)) });
  } catch {}
  const from = since === (ctx?.logSince ?? null) ? "since the case began" : `since byte ${since} of the emulators log`;
  const first = String(err.message ?? err).split("\n")[0].slice(0, 200);
  return redactString(`${seen.join(", and ")} ${from}, so what it waited for may be what a killed function never did — the failure, at ${callSite(err) ?? "an unknown call site"}: ${first}`);
}

// --- When the case's own timeout runs out ----------------------------------------

/**
 * What a case's budget keeps back from its timeout, for what the case does
 * after its body while node:test still listens: judge the failure and write
 * its evidence (every user's capture, on a FAIL). Run out of it, and
 * node:test reports its timeout over the outcome already decided. Its
 * browsers then close without being waited for (one Chrome took 3 s on an
 * idle machine, longer under load). A case of under 80 s keeps a quarter of
 * its timeout instead.
 */
export const CASE_BUDGET_MARGIN_MS = 20_000;

/** The ctx hook a budget calls as it abandons the body: runCase then makes no new users for it. */
const ABANDON = Symbol("e2e.case.abandon");

/**
 * A case body that runs against a budget, `timeoutMs` less a margin
 * (CASE_BUDGET_MARGIN_MS, or a quarter of `timeoutMs` when that is less), so
 * that running out of time is a failure the case still judges and reports
 * itself. node:test reports its own timeout the moment it fires, as a FAIL
 * no judge reads.
 *
 * Running out rejects with E2E_CASE_BUDGET, "the case's budget ran out: not
 * done within <budget> ms (its timeoutMs <timeoutMs> less <margin> ms, kept
 * to judge and record it)", with `budgetMs` and `timeoutMs`. That is a wait
 * that ran out, so pageStall and functionKill read it, its window the whole
 * case. Its stack is where caseBudget was called, the case's declaration, so
 * callSite names the case. The body is abandoned, not stopped: what it awaits
 * runs on until the case closes its pool, which the case then does without
 * waiting for it, and it can make no new users.
 * As the body starts it sets `ctx.budgetEndsAt`, the Date.now() time the
 * budget runs out (the earlier one, when a budget is already set), which
 * untilLanded's `stopAt: "budget"` and a spec's own judgement read.
 * `timeoutMs` that is not a positive number throws TypeError.
 * `scenario(name, {inconclusiveOnCaseTimeout: true}, fn)` wraps the body in
 * it, inside onAnsweringStack(fn, {also: pageStall}).
 */
export function caseBudget(body, timeoutMs) {
  if (typeof body !== "function") throw new TypeError(`caseBudget(body, timeoutMs): body is the case's (ctx) => …, got ${typeof body}`);
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError(`caseBudget: timeoutMs is the case's timeout, a positive number of ms, got ${JSON.stringify(timeoutMs) ?? String(timeoutMs)}`);
  }
  const marginMs = Math.min(CASE_BUDGET_MARGIN_MS, Math.floor(timeoutMs / 4));
  const budgetMs = timeoutMs - marginMs;
  // Where the case was declared: the budget's error carries these frames, not the timer's.
  const declared = String(new Error().stack ?? "").split("\n").slice(1).join("\n");
  return async (ctx) => {
    let timer;
    const endsAt = Date.now() + budgetMs;
    try {
      // What untilLanded's stopAt "budget" reads; an outer budget that ends sooner still wins.
      if (ctx !== null && typeof ctx === "object") {
        const prior = ctx.budgetEndsAt;
        ctx.budgetEndsAt = typeof prior === "number" && Number.isFinite(prior) ? Math.min(prior, endsAt) : endsAt;
      }
    } catch {
      /* a frozen ctx (a self-test's) keeps none: untilLanded then refuses "budget" */
    }
    const spent = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const err = new Error(`the case's budget ran out: not done within ${budgetMs} ms (its timeoutMs ${timeoutMs} less ${marginMs} ms, kept to judge and record it)`);
        err.code = "E2E_CASE_BUDGET";
        err.budgetMs = budgetMs;
        err.timeoutMs = timeoutMs;
        err.stack = `Error: ${err.message}\n${declared}`;
        try {
          ctx?.[ABANDON]?.(`its budget of ${budgetMs} ms ran out`);
          ctx?.ev?.step?.(`the case's budget of ${budgetMs} ms ran out: the body is abandoned, and its failure judged while the case can still report it`);
        } catch {}
        reject(err);
      }, budgetMs);
    });
    try {
      return await Promise.race([Promise.resolve().then(() => body(ctx)), spent]);
    } finally {
      clearTimeout(timer);
    }
  };
}

// --- When the stack answered the case's own requests slowly --------------------------

/** What httpStall takes for a slow answer unless told otherwise: half Hosting's cut-off. A quiet stack answers these requests in well under 2 s. */
const HTTP_SLOW_MS = 30_000;
/**
 * The least `slowMs` httpStall takes: the Firestore web SDK's own "Backend
 * didn't respond within 10 seconds". Below it a merely busy stack, or a
 * product that is slow, would excuse a case that ran out of time.
 */
const HTTP_SLOW_MIN_MS = 10_000;

/** A ctx.requests() row as httpStall names it, `ms` its time (so far, for one in flight): "owner: POST /visibility answered 200 after 58004 ms". */
function slowLine(r, ms) {
  const who = typeof r.actor === "string" && r.actor ? r.actor : "this case";
  const req = `${r.method} ${r.path ?? (typeof r.url === "string" ? pathOnly(r.url) : "?")}`;
  if (r.pending === true) return `${who}: ${req} still unanswered after ${Math.round(ms)} ms`;
  if (r.status != null) return `${who}: ${req} answered ${r.status} after ${Math.round(ms)} ms`;
  return `${who}: ${req} got no answer in ${Math.round(ms)} ms${r.error ? ` (${String(r.error).split("\n")[0].slice(0, 80)})` : ""}`;
}

/**
 * Why a case whose budget ran out may have run out on the stack and not the
 * product, read from the case's OWN requests: a reason, or null. pageStall's
 * counterpart for what a case sends from Node (ctx.requests({pending: true}):
 * any http.mjs client inside the case, mcp.mjs's, a session's, a seed's), for
 * a case with no page, or whose pages saw nothing. For onAnsweringStack's
 * `also` (as `inconclusiveOnHttpStall: true` passes it), or a spec's own.
 *
 * Only `err` that is the case's budget running out (E2E_CASE_BUDGET, from
 * caseBudget): a slow answer is still an answer, so it may explain the case
 * running out of TIME, and nothing else; any other wait, an assertion, an
 * answer, a precondition is null. The evidence is at least one of the case's
 * requests that took `slowMs` (30 s) or more to be answered or to fail, or
 * that was still unanswered that long when the judge ran (in flight: the one
 * the budget ran out during). A guard refusal, or a quicker failure, is no
 * evidence: a budget that ran out on a stack that answered quickly FAILS.
 * A request the product takes that long even on a quiet stack (a large
 * upload) is no evidence of anything: give such a case a larger `slowMs`.
 * `slowMs` below 10,000 ms (the Firestore SDK's own threshold), or `now`
 * that is not a Date.now() time, throws TypeError. The reason names the
 * slowest requests and the failure at its call site (callSite).
 */
export function httpStall(err, ctx, { slowMs = HTTP_SLOW_MS, now = Date.now() } = {}) {
  if (typeof slowMs !== "number" || !Number.isFinite(slowMs) || slowMs < HTTP_SLOW_MIN_MS) {
    throw new TypeError(`httpStall: slowMs is how long an answer took to count as the stack's, a number of ms, ${HTTP_SLOW_MIN_MS} or more, got ${JSON.stringify(slowMs) ?? String(slowMs)}`);
  }
  if (typeof now !== "number" || !Number.isFinite(now) || now < 0) throw new TypeError(`httpStall: now is a Date.now() time, got ${JSON.stringify(now) ?? String(now)}`);
  if (err == null || typeof err !== "object" || codeOf(err) !== "E2E_CASE_BUDGET") return null;
  const rows = requestsOf(ctx, { pending: true });
  const slow = [];
  for (const r of rows) {
    if (!r || typeof r !== "object") continue;
    const t = timeOf(r.t);
    const ms = r.pending === true ? (t == null ? null : now - t) : Number.isFinite(r.ms) && (r.status != null || r.error != null) && !/^guard refused/.test(String(r.error ?? "")) ? r.ms : null;
    if (ms != null && ms >= slowMs) slow.push({ r, ms });
  }
  if (slow.length === 0) return null;
  slow.sort((a, b) => b.ms - a.ms);
  const lines = slow.map(({ r, ms }) => slowLine(r, ms));
  const list = `${lines.slice(0, 3).join("; ")}${lines.length > 3 ? `; and ${lines.length - 3} more` : ""}`;
  const first = String(err.message ?? err).split("\n")[0].slice(0, 200);
  return redactString(`the case's budget ran out while the stack answered its own requests slowly: ${slow.length} of its ${rows.length} request(s) took ${Math.round(slowMs / 1000)} s or more (${list}), so the time it ran out of went to the stack — the failure, at ${callSite(err) ?? "an unknown call site"}: ${first}`);
}

/** Declare a scenario. See the header for the options and ctx. */
export function scenario(name, opts, fn) {
  if (typeof opts === "function") [opts, fn] = [{}, opts];
  const stackOpt = opts.inconclusiveOnStackTimeout;
  if (stackOpt !== undefined && typeof stackOpt !== "boolean") {
    throw new TypeError(`scenario ${JSON.stringify(name)}: inconclusiveOnStackTimeout is true or false, got ${JSON.stringify(stackOpt) ?? String(stackOpt)}`);
  }
  const pageOpt = opts.inconclusiveOnPageStall;
  if (pageOpt !== undefined && typeof pageOpt !== "boolean") {
    throw new TypeError(`scenario ${JSON.stringify(name)}: inconclusiveOnPageStall is true or false, got ${JSON.stringify(pageOpt) ?? String(pageOpt)}`);
  }
  if (pageOpt && stackOpt === false) {
    throw new TypeError(`scenario ${JSON.stringify(name)}: inconclusiveOnPageStall widens inconclusiveOnStackTimeout, which this case sets to false`);
  }
  const killOpt = opts.inconclusiveOnFunctionKill;
  if (killOpt !== undefined && typeof killOpt !== "boolean") {
    throw new TypeError(`scenario ${JSON.stringify(name)}: inconclusiveOnFunctionKill is true or false, got ${JSON.stringify(killOpt) ?? String(killOpt)}`);
  }
  if (killOpt && stackOpt === false) {
    throw new TypeError(`scenario ${JSON.stringify(name)}: inconclusiveOnFunctionKill widens inconclusiveOnStackTimeout, which this case sets to false`);
  }
  const caseOpt = opts.inconclusiveOnCaseTimeout;
  if (caseOpt !== undefined && typeof caseOpt !== "boolean") {
    throw new TypeError(`scenario ${JSON.stringify(name)}: inconclusiveOnCaseTimeout is true or false, got ${JSON.stringify(caseOpt) ?? String(caseOpt)}`);
  }
  if (caseOpt && stackOpt === false) {
    throw new TypeError(`scenario ${JSON.stringify(name)}: inconclusiveOnCaseTimeout widens inconclusiveOnStackTimeout, which this case sets to false`);
  }
  if (caseOpt && pageOpt === false) {
    throw new TypeError(`scenario ${JSON.stringify(name)}: inconclusiveOnCaseTimeout reads the case's timeout as a wait for pageStall, which this case turns off (inconclusiveOnPageStall: false)`);
  }
  const reqOpt = opts.inconclusiveOnRequestStall;
  if (reqOpt !== undefined && typeof reqOpt !== "boolean") {
    throw new TypeError(`scenario ${JSON.stringify(name)}: inconclusiveOnRequestStall is true or false, got ${JSON.stringify(reqOpt) ?? String(reqOpt)}`);
  }
  if (reqOpt && stackOpt === false) {
    throw new TypeError(`scenario ${JSON.stringify(name)}: inconclusiveOnRequestStall widens inconclusiveOnStackTimeout, which this case sets to false`);
  }
  if (reqOpt && pageOpt === false) {
    throw new TypeError(`scenario ${JSON.stringify(name)}: inconclusiveOnRequestStall is pageStall counting the case's own requests too, which this case turns off (inconclusiveOnPageStall: false)`);
  }
  const httpOpt = opts.inconclusiveOnHttpStall;
  if (httpOpt !== undefined && typeof httpOpt !== "boolean") {
    throw new TypeError(`scenario ${JSON.stringify(name)}: inconclusiveOnHttpStall is true or false, got ${JSON.stringify(httpOpt) ?? String(httpOpt)}`);
  }
  if (httpOpt && stackOpt === false) {
    throw new TypeError(`scenario ${JSON.stringify(name)}: inconclusiveOnHttpStall widens inconclusiveOnStackTimeout, which this case sets to false`);
  }
  if (httpOpt && pageOpt === false) {
    throw new TypeError(`scenario ${JSON.stringify(name)}: inconclusiveOnHttpStall implies inconclusiveOnCaseTimeout, whose budget pageStall judges first, which this case turns off (inconclusiveOnPageStall: false)`);
  }
  if (httpOpt && caseOpt === false) {
    throw new TypeError(`scenario ${JSON.stringify(name)}: inconclusiveOnHttpStall judges the case's budget, which this case turns off (inconclusiveOnCaseTimeout: false)`);
  }
  // A case's own timeoutMs, else the tier default run.mjs passes as
  // E2E_CASE_TIMEOUT_MS (lib/budget.mjs): --test-timeout now bounds the whole
  // FILE, and may be larger than any one case should run.
  const timeoutMs = opts.timeoutMs || caseTimeoutDefault() || null;
  // The budget goes inside the judges, so that running out of it is judged.
  if ((caseOpt || httpOpt) && timeoutMs) fn = caseBudget(fn, timeoutMs);
  const pageOn = pageOpt || caseOpt || reqOpt || httpOpt;
  // Exactly pageStall unless the case counts its own requests too.
  const stall = reqOpt ? (err, ctx) => pageStall(err, ctx, { requests: true }) : pageStall;
  if (httpOpt) fn = onAnsweringStack(fn, { also: (err, ctx) => stall(err, ctx) ?? httpStall(err, ctx) ?? (killOpt ? functionKill(err, ctx) : null) });
  else if (pageOn && killOpt) fn = onAnsweringStack(fn, { also: (err, ctx) => stall(err, ctx) ?? functionKill(err, ctx) });
  else if (pageOn) fn = onAnsweringStack(fn, { also: stall });
  else if (killOpt) fn = onAnsweringStack(fn, { also: functionKill });
  else if (stackOpt) fn = onAnsweringStack(fn);
  const target = currentTarget();
  const file = callerFile();
  const usersPerBrowser = opts.usersPerBrowser ?? 5;
  // A concurrency scenario with `n` runs the plan's K per N unless it says otherwise.
  const trials = scenarioTrials(opts, file);
  for (const c of expand(name, { ...opts, trials }, target)) {
    const options = {};
    if (timeoutMs) options.timeout = timeoutMs;
    // A defect case is NOT declared todo here: that would turn every failure
    // of it — a breach, a timeout — into "failed as expected". runCase marks
    // it todo only when the defect's own oracle is what failed.
    if (c.skip) options.skip = c.skip;
    declare(file)(test, c.name, options, (t) => runCase(t, { target, c, fn, file, usersPerBrowser, defect: opts.defect ?? null, timeoutMs }));
  }
}

/** On an INCONCLUSIVE, the most runCase waits for its pages' DOM excerpts and screenshots (their consoles and requests are written at once, whatever the time). */
export const INCONCLUSIVE_CAPTURE_MS = 20_000;
/** How much of a case's timeoutMs an INCONCLUSIVE's capture leaves unspent: for its report and the pool's close (Chrome takes seconds to close, more under load), so that node:test's timeout never turns the INCONCLUSIVE into a FAIL. */
export const CAPTURE_RESERVE_MS = 15_000;

/**
 * Capture `users` into `ev` (Evidence's captureUser) one after another, until
 * `deadline` (a Date.now() time; Infinity: no limit). captureUser writes a
 * user's console and requests synchronously as it is called, then awaits its
 * DOM excerpt and screenshot (a page.evaluate with no timeout of its own).
 * So EVERY user is called, those after the deadline too, and its console and
 * requests are kept; only the wait for the rest stops at the deadline (what
 * is still running then may finish later, or fail as the pool closes).
 * Resolves {captured, late, failed} (user names, in order); never rejects.
 * TypeError for an `ev` without captureUser, `users` that is not an array,
 * or a deadline that is not a number.
 */
export async function captureUsers(ev, users, { deadline = Infinity } = {}) {
  if (!ev || typeof ev.captureUser !== "function") throw new TypeError("captureUsers: ev is an Evidence (with captureUser)");
  if (!Array.isArray(users)) throw new TypeError(`captureUsers: users is an array, got ${typeof users}`);
  if (typeof deadline !== "number" || Number.isNaN(deadline)) throw new TypeError(`captureUsers: deadline is a Date.now() time or Infinity, got ${JSON.stringify(deadline) ?? String(deadline)}`);
  const out = { captured: [], late: [], failed: [] };
  for (const u of users) {
    const name = String(u?.name ?? "?");
    let done;
    try {
      done = Promise.resolve(ev.captureUser(u)).then(() => "captured", () => "failed");
    } catch {
      out.failed.push(name); // a captureUser that throws before it is a promise
      continue;
    }
    const left = deadline - Date.now();
    if (!(left > 0)) {
      out.late.push(name);
      continue;
    }
    let timer = null;
    // setTimeout takes at most 2^31 − 1 ms (more, Infinity included, would fire at once).
    const limit = left > 2_147_483_647 ? null : new Promise((resolve) => (timer = setTimeout(resolve, left, "late")));
    const r = await (limit ? Promise.race([done, limit]) : done);
    clearTimeout(timer);
    out[r].push(name);
  }
  return out;
}

async function runCase(t, { target, c, fn, file, usersPerBrowser, defect, timeoutMs }) {
  const startedAt = Date.now(); // node:test's timeout of the case runs from about here
  const ev = new Evidence({ runDir: evidenceRoot(target), slug: c.name, name: c.name });
  ev.rerun = rerunCommand(target.runId, file, c.name);
  if (defect) ev.step(`known defect ${defect}: only this defect's own oracle failing is reported as TODO; anything else fails`);
  const sink = ev.httpSink();
  let pool = null;
  let settled = false; // the body finished (normally or not) before any abort
  let aborted = false; // node:test already reported this case (timeout, cancel)
  let abandoned = null; // why caseBudget abandoned the body: the late body makes no new users
  const windows = new Map(); // the documents this case made unlisted or public (grant.mjs)
  let probesNoted = false;

  /**
   * The SDK network tests this case's browsers sent (browser.mjs isSdkProbe):
   * blocked, never a breach, but a sign the stack stalled the SDK's Listen
   * channel. A step, an evidence file and one findings row; never throws.
   */
  const noteSdkProbes = () => {
    if (probesNoted || typeof pool?.sdkProbes !== "function") return;
    try {
      const probes = pool.sdkProbes();
      if (probes.length === 0) return;
      probesNoted = true;
      const users = [...new Set(probes.map((p) => p.user))];
      ev.step(`environment: ${probes.length} Firestore SDK network test(s) from ${users.join(", ")}, sent after its Listen channel errored (a slow stack): blocked, not an isolation breach`);
      ev.json("sdk-probes", probes);
      grantMod?.recordFinding?.(target, { kind: "sdk-probe", class: "E", case: c.name, count: probes.length, users, first: new Date(Math.min(...probes.map((p) => p.t))).toISOString() });
    } catch {
      /* a note, never the case's outcome */
    }
  };

  /**
   * Make this case's windows private; with `strict`, one that will not close
   * throws E2E_WINDOW_OPEN. A close the stack did not answer is judged by the
   * document's record (grant.mjs closeWindows), not by the missing answer.
   */
  const closeCaseWindows = async (strict) => {
    if (!grantMod?.closeWindows || windows.size === 0) return;
    const close = () => grantMod.closeWindows({ scope: windows });
    const out = await (httpMod?.withEvidenceSink ? httpMod.withEvidenceSink(sink, close) : close());
    for (const c of out.closed) {
      ev.step(c.via === "record"
        ? `teardown: ${c.docId} is private again (POST /visibility ${c.status ?? "got no answer"}, but its record then said private, with no public projection and no open-edit gate)`
        : `teardown: ${c.docId} is private again (POST /visibility ${c.status})`);
    }
    if (out.failed.length === 0) return;
    const what = out.failed.map((f) => `${f.docId} (${f.visibility}): ${f.error}`).join("; ");
    ev.step(`teardown: ${out.failed.length} document(s) could not be made private: ${what}`);
    if (!strict) return;
    const err = new Error(`window left open: ${what}`);
    err.code = "E2E_WINDOW_OPEN";
    err.failed = out.failed;
    throw err;
  };

  const onAbort = () => {
    if (settled || aborted) return;
    aborted = true;
    const why = t.signal.reason?.message ?? String(t.signal.reason ?? "aborted");
    const err = new Error(timeoutMs ? `timed out after ${timeoutMs} ms (${why})` : `aborted: ${why}`);
    err.code = "E2E_TIMEOUT";
    try {
      // Synchronously, while node:test still attaches diagnostics to this case.
      t.diagnostic(`evidence=${ev.flush({ error: err })}`);
    } catch (capture) {
      try {
        t.diagnostic(`evidence capture failed: ${capture.message}`);
      } catch {}
    }
    void (async () => {
      for (const u of pool?.users ?? []) await ev.captureUser(u).catch(() => undefined);
      if (pool) {
        const b = pool.breaches();
        if (b.length) ev.json("isolation-breaches", b);
        noteSdkProbes();
      }
      await pool?.close().catch(() => undefined); // pending Playwright calls reject now
      await closeCaseWindows(false).catch(() => undefined); // the case is over: close its windows now
    })();
  };
  t.signal.addEventListener("abort", onAbort, { once: true });

  /**
   * An INCONCLUSIVE keeps every page as a FAIL does (console, requests, DOM,
   * screenshot), within limits a FAIL does not need: the DOM and screenshot
   * waits end INCONCLUSIVE_CAPTURE_MS after it, and CAPTURE_RESERVE_MS before
   * the case's timeout, so that a page that does not answer never turns the
   * outcome into node:test's timeout. A step names any user not waited for.
   * Never throws.
   */
  const captureInconclusive = async () => {
    try {
      const users = pool?.users ?? [];
      if (users.length === 0) return;
      const deadline = Math.min(Date.now() + INCONCLUSIVE_CAPTURE_MS, timeoutMs ? startedAt + timeoutMs - CAPTURE_RESERVE_MS : Infinity);
      const r = await captureUsers(ev, users, { deadline });
      if (r.late.length) ev.step(`evidence: ${r.late.join(", ")}: console and requests kept; the DOM excerpt and screenshot were not waited for (an INCONCLUSIVE's capture stops ${INCONCLUSIVE_CAPTURE_MS} ms after it, and ${CAPTURE_RESERVE_MS} ms before the case's timeout)`);
      if (r.failed.length) ev.step(`evidence: capturing ${r.failed.join(", ")} failed`);
    } catch {
      /* evidence, never the outcome */
    }
  };

  const ctx = {
    target,
    n: c.n,
    trial: c.trial,
    name: c.name,
    t,
    ev,
    step: (text) => ev.step(text),
    get users() {
      if (aborted) throw new Error("this case was already reported (timed out); no new users");
      if (abandoned) throw new Error(`this case's body was abandoned (${abandoned}); no new users`);
      pool ??= new BrowserPool({ target, usersPerBrowser });
      return pool;
    },
    /** The users this case has made so far, a copy, or []: never makes a pool, never throws (pageStall reads it after a failure). */
    get usersSoFar() {
      return pool ? [...pool.users] : [];
    },
    /** The stack's emulators.log size as the case began (a logMark: functionKill reads from it), or null without the "logs" capability. */
    logSince: logSinceOf(target),
    /** The Date.now() time the case's budget runs out, which caseBudget sets as the body starts (untilLanded's stopAt "budget" reads it); null without one. */
    budgetEndsAt: null,
    /**
     * This case's own Node requests so far, as http.mjs logged them into its
     * evidence (the latest 2,000): fresh rows, never throws (requestRows).
     * With {pending: true}, then one row per hop still in flight (http.mjs
     * pendingRequests: sent, not yet answered), `pending: true` and no
     * status, ms or answer time yet.
     */
    requests(o) {
      const pending = o != null && typeof o === "object" && o.pending === true;
      try {
        const rows = requestRows(ev.http);
        if (!pending || typeof httpMod?.pendingRequests !== "function") return rows;
        return [...rows, ...httpMod.pendingRequests(sink).map(pendingRow)];
      } catch {
        return [];
      }
    },
    http(o = {}) {
      if (!httpMod?.createHttp) throw new Error("e2e/lib/http.mjs (createHttp) is not available");
      return httpMod.createHttp(target, { evidence: sink, ...o });
    },
    mcp(o = {}) {
      if (!mcpMod?.mcpClient) throw new Error("e2e/lib/mcp.mjs (mcpClient) is not available");
      return mcpMod.mcpClient(target, { evidence: sink, ...o });
    },
    /** End the case INCONCLUSIVE: a measurement precondition did not hold. Throws; never returns. */
    inconclusive(reason) {
      throw inconclusiveError(reason);
    },
    /**
     * End a known defect's case NOT REPRODUCED: this trial never reached the
     * defect's window (a natural race that did not race), so it says neither
     * that the defect is there nor that it is fixed. Throws E2E_NOT_REPRODUCED;
     * never returns. A case without `defect` gets a TypeError (it FAILS).
     */
    notReproduced(reason) {
      if (!defect) throw new TypeError(`ctx.notReproduced: only a known defect's case (scenario's defect: "S<n>") ends NOT REPRODUCED; ${JSON.stringify(c.name)} declares no defect. A trial that never reached a window it measures is ctx.inconclusive(reason)`);
      throw notReproducedError(reason, defect);
    },
    /** Run a defect's oracle: whatever it throws is that oracle failing (E2E_DEFECT_ORACLE), but an E2E_NOT_REPRODUCED, which passes through as it is. */
    async oracle(check) {
      try {
        return await (typeof check === "function" ? check() : check);
      } catch (err) {
        if (err?.code === "E2E_DEFECT_ORACLE" || err?.code === NOT_REPRODUCED_CODE) throw err;
        const wrapped = new Error(err?.message ?? String(err), { cause: err });
        wrapped.code = "E2E_DEFECT_ORACLE";
        throw wrapped;
      }
    },
  };
  Object.defineProperty(ctx, ABANDON, { value: (why) => (abandoned ??= String(why || "its budget ran out")) });
  /**
   * A live case of N >= LIVE_RESERVE_MIN_N on a local stack: room for its
   * browsers AND the stack's growth before the body (load.mjs admitLive),
   * waiting up to E2E_POOL_WAIT_MS; no room is INCONCLUSIVE, never a FAIL.
   */
  const reserveLive = async () => {
    if (target?.kind !== "local" || !(Number.isInteger(c.n) && c.n >= LIVE_RESERVE_MIN_N)) return;
    const dir = process.env.E2E_INVOCATION_DIR;
    const r = await admitLive({ n: c.n, timeoutMs: poolWaitMs(), logFile: dir ? join(dir, "load.jsonl") : null, signal: t.signal });
    if (!r.ok) throw inconclusiveError(`the machine never had room for this case: ${r.reason}`);
    if (r.waitedMs > 0) ev.step(`environment: waited ${Math.round(r.waitedMs / 1000)} s for ${(r.needBytes / GIB).toFixed(1)} GB available (N=${c.n}: its browsers and the stack's growth)`);
  };
  const body = async () => {
    if (process.env.E2E_RTDB_COVERAGE_RECYCLE === "1" && coverageBoundary.needed) {
      const firestore = await recycleFirestoreCoverage(target, { boundary: coverageBoundary, caseName: c.name });
      t.diagnostic(`maintenance: archived ${firestore.coverage.sourceBytes} bytes of Firestore rule coverage and reapplied identical rules ${firestore.rulesSha256}; ${firestore.coverage.artifact}`);
      const recycled = await recycleRtdbCoverage(target, { boundary: coverageBoundary, caseName: c.name });
      t.diagnostic(`maintenance: archived ${recycled.coverage.sourceBytes} bytes of RTDB rule coverage and restored exact rules ${recycled.rulesSha256} after a whitespace-only round trip; ${recycled.coverage.artifact}`);
    }
    await reserveLive();
    return fn(ctx);
  };
  const scoped = () => (grantMod?.withWindowScope ? grantMod.withWindowScope(windows, body) : body());
  const run = () => (httpMod?.withEvidenceSink ? httpMod.withEvidenceSink(sink, scoped) : scoped());
  coverageBoundary.enter();
  try {
    await run();
    settled = true;
    if (aborted) return;
    noteSdkProbes();
    pool?.assertIsolation();
    await closeCaseWindows(true);
    if (defect) t.todo(`known defect ${defect}`); // reported as "passed unexpectedly"
    if (ev.always) t.diagnostic(`evidence=${ev.flush()}`);
  } catch (caught) {
    settled = true;
    if (aborted) throw caught; // already reported, with its evidence
    let err = caught;
    noteSdkProbes();
    const breaches = pool ? pool.breaches() : [];
    if (breaches.length && !String(err?.code ?? "").startsWith("E2E_ISOLATION")) {
      // A breach fails the case whatever else happened, an INCONCLUSIVE or a
      // known defect's oracle included: the body's error rides along as the cause.
      try {
        pool.assertIsolation();
      } catch (breach) {
        breach.cause = err;
        err = breach;
      }
    }
    if (err?.code === "E2E_INCONCLUSIVE") {
      await captureInconclusive();
      try {
        t.diagnostic(`evidence=${ev.flush({ error: err })}`);
      } catch {}
      t.diagnostic(`outcome=inconclusive:${err.reason}`);
      t.skip(`INCONCLUSIVE: ${err.reason}`);
      return;
    }
    if (defect && err?.code === NOT_REPRODUCED_CODE) {
      // A measurement that ran and did not reach the defect's window: its
      // steps and HTTP are kept, its pages are not (nothing went wrong in them).
      try {
        t.diagnostic(`evidence=${ev.flush({ error: err })}`);
      } catch {}
      t.diagnostic(`outcome=not-reproduced:${JSON.stringify({ defect: String(defect), reason: err.reason })}`);
      t.skip(formatNotReproduced(String(defect), err.reason));
      return;
    }
    if (defect && isDefectOracleFailure(err)) t.todo(`known defect ${defect}`);
    try {
      for (const u of pool?.users ?? []) await ev.captureUser(u).catch(() => undefined);
      if (breaches.length) ev.json("isolation-breaches", breaches);
      t.diagnostic(`evidence=${ev.flush({ error: err })}`);
    } catch (capture) {
      t.diagnostic(`evidence capture failed: ${capture.message}`);
    }
    throw err;
  } finally {
    t.signal.removeEventListener("abort", onAbort);
    await closeCaseWindows(false).catch(() => undefined); // pass, fail or a late body: never left open
    // A body its budget abandoned has had its outcome decided inside the
    // margin: closing its browsers (seconds a Chrome, more under load) is not
    // waited for, or node:test's timeout would report over that outcome.
    try {
      if (!aborted && abandoned) void pool?.close().catch(() => undefined);
      else if (!aborted) await pool?.close();
    } finally {
      coverageBoundary.leave({ settled: settled && !aborted && !abandoned, closed: !pool || (pool.closed && !aborted && !abandoned), usedBrowsers: !!pool, pending: httpMod?.pendingRequests?.(sink)?.length ?? 0 });
    }
  }
}

export { escapeRe };
