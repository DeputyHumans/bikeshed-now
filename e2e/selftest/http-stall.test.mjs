// SPDX-License-Identifier: Apache-2.0
// Self-test: a case whose budget ran out while the stack answered its own requests slowly — httpStall, http.mjs pendingRequests, ctx.requests({pending}) and scenario's inconclusiveOnHttpStall (SPEC §12).

/**
 * httpStall is checked here against rows shaped as ctx.requests({pending:
 * true}) gives them, and http.mjs's in-flight list against real clients with
 * a stand-in fetch. Then a generated fixture spec runs through `node --test`
 * with the real reporter, the way run.mjs runs one: each case makes its
 * requests through real http.mjs clients, one answered by a stand-in fetch
 * that moves the fixture's clock 35 s as it answers 200 (a self-test cannot
 * wait half a minute), or that never answers after moving it 31 s; and then
 * runs out of its budget or a wait, or fails an assertion. A local server
 * answers the plain requests. No browser.
 */

import { after, before, test } from "node:test";
import assert, { AssertionError } from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHttp, pendingRequests, withEvidenceSink } from "../lib/http.mjs";
import { createInvocation, nodeTestArgs } from "../lib/invocation.mjs";
import { E2E_DIR, E2E_TMP, OUT_DIR, REPO_ROOT, ensureDir } from "../lib/paths.mjs";
import { httpStall, scenario } from "../lib/test.mjs";

const lib = (f) => pathToFileURL(join(E2E_DIR, "lib", f)).href;
const LEAD = "the stack did not answer, so nothing was measured: ";
const NOW = 1_800_000_000_000;

const runId = `selftest-http-stall-${process.pid}`;
let server;
let target;
let tmp;
let runDir;

const shaped = (code, message, extra = {}) => Object.assign(new Error(message), { code }, extra);
const budgetError = () => shaped("E2E_CASE_BUDGET", "the case's budget ran out: not done within 440000 ms (its timeoutMs 460000 less 20000 ms, kept to judge and record it)", { budgetMs: 440_000, timeoutMs: 460_000 });

/** A row as ctx.requests() gives one: sent `ago` ms before NOW, answered after `ms` (status, or `error` with no status). */
function row(ago, ms, { status = 200, error = null, path = "/visibility", actor = "owner", method = "POST" } = {}) {
  const t = NOW - ago;
  return { t, at: t + ms, actor, method, url: `http://127.0.0.1:1${path}`, path, status: error ? null : status, ms, error };
}
/** A row as ctx.requests({pending: true}) adds one: sent `ago` ms before NOW, not answered yet. */
const pending = (ago, { path = "/visibility", actor = "owner", method = "POST" } = {}) => ({ t: NOW - ago, at: null, actor, method, url: `http://127.0.0.1:1${path}`, path, status: null, ms: null, error: null, pending: true });
/** A ctx with only what httpStall reads: requests(o), whose in-flight rows come only with {pending: true}. */
const ctxWith = (rows = [], open = []) => ({ usersSoFar: [], requests: (o) => (o?.pending === true ? [...rows, ...open] : rows) });
const judge = (err, ctx, o = {}) => httpStall(err, ctx, { now: NOW, ...o });

before(async () => {
  server = http.createServer((req, res) => {
    res.setHeader("content-type", "text/plain");
    res.end("ok");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  tmp = mkdtempSync(join(ensureDir(E2E_TMP, "E2E_TMP"), "selftest-http-stall-"));
  runDir = join(OUT_DIR, runId);
  mkdirSync(runDir, { recursive: true });
  target = { kind: "local", runId, runDir, origin: `http://127.0.0.1:${port}`, projectId: "demo-bikeshed", capabilities: ["local"], stack: { ports: { hosting: port } } };
});

after(async () => {
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
  rmSync(tmp, { recursive: true, force: true });
  rmSync(runDir, { recursive: true, force: true });
});

test("httpStall: the case's budget ran out while one of its own requests took 30 s or more to be answered, to fail, or is still in flight: a reason; a quick stack is none", () => {
  const err = budgetError();
  const why = judge(err, ctxWith([row(200_000, 900), row(120_000, 35_004), row(60_000, 1_200, { path: "/session" })]));
  assert.match(why, /^the case's budget ran out while the stack answered its own requests slowly: 1 of its 3 request\(s\) took 30 s or more \(owner: POST \/visibility answered 200 after 35004 ms\), so the time it ran out of went to the stack — the failure, at http-stall\.test\.mjs:\d+: the case's budget ran out: not done within 440000 ms/);

  assert.equal(judge(err, ctxWith([row(200_000, 900), row(60_000, 29_999)])), null, "NEGATIVE: every answer under 30 s: the budget FAILS");
  assert.equal(judge(err, ctxWith()), null, "NEGATIVE: no requests at all, no evidence");
  assert.equal(typeof judge(err, ctxWith([row(60_000, 30_000)])), "string", "30 s itself counts");

  const inFlight = judge(err, ctxWith([row(200_000, 900)], [pending(31_000, { path: "/publish", actor: "harness" })]));
  assert.match(inFlight, /: 1 of its 2 request\(s\) took 30 s or more \(harness: POST \/publish still unanswered after 31000 ms\), so/, "the request the budget ran out during");
  assert.equal(judge(err, ctxWith([row(200_000, 900)], [pending(29_000)])), null, "NEGATIVE: in flight for less than 30 s");
  assert.equal(typeof judge(err, { usersSoFar: [], requests: () => [pending(90_000)] }), "string", "a ctx that gives in-flight rows unasked is read the same");

  const noAnswer = judge(err, ctxWith([row(200_000, 150_000, { error: "timeout after 150000 ms" })]));
  assert.match(noAnswer, /\(owner: POST \/visibility got no answer in 150000 ms \(timeout after 150000 ms\)\)/, "the client's own deadline is the slowest answer of all");
  assert.equal(judge(err, ctxWith([row(200_000, 50, { error: "connect ECONNREFUSED 127.0.0.1:1" })])), null, "NEGATIVE: a quick failure is no slow answer");
  assert.equal(judge(err, ctxWith([{ ...row(200_000, 0), ms: null, status: null, error: "guard refused: ledger" }])), null, "NEGATIVE: a guard refusal was never sent");
  assert.equal(judge(err, ctxWith([{ ...row(200_000, 40_000), status: null, error: null }])), null, "a row that says neither status nor error is no answer to time");
  assert.equal(judge(err, ctxWith([], [{ ...pending(40_000), t: null }])), null, "an in-flight row with no time cannot be timed");

  const many = judge(err, ctxWith([row(9, 31_000, { path: "/a" }), row(8, 59_000, { status: 504, path: "/b" }), row(7, 45_000, { path: "/c" }), row(6, 33_000, { path: "/d" }), row(5, 40_000, { path: "/e" })]));
  assert.match(many, /: 5 of its 5 request\(s\) took 30 s or more \(owner: POST \/b answered 504 after 59000 ms; owner: POST \/c answered 200 after 45000 ms; owner: POST \/e answered 200 after 40000 ms; and 2 more\)/, "the slowest first, three named");

  const keyed = judge(err, ctxWith([{ ...row(200_000, 40_000), url: "http://127.0.0.1:1/content/~abcdefgh12345678/x?k=abcdefgh12345678", path: null, actor: null }]));
  assert.match(keyed, /\(this case: POST \/content\/~‹redacted›\/x answered 200 after 40000 ms\)/, "a path from the url when the row has none; no actor is this case's");
  assert.doesNotMatch(keyed, /abcdefgh12345678/, "a link key never reaches a reason");

  assert.equal(typeof judge(err, ctxWith([row(60_000, 12_000)]), { slowMs: 10_000 }), "string", "slowMs moves the line");
  assert.equal(judge(err, ctxWith([row(60_000, 35_000)]), { slowMs: 40_000 }), null, "NEGATIVE: under a larger slowMs");
});

test("httpStall judges only the case's budget running out: never another wait, an assertion, an answer, a precondition or a known defect's oracle; bad options throw", () => {
  const ctx = ctxWith([row(60_000, 50_000)]);
  const never = [
    shaped("E2E_EVENTUALLY_TIMEOUT", "eventually: x not met within 4000 ms after 3 samples; last value: null"),
    Object.assign(new Error("locator.click: Timeout 90000ms exceeded."), { name: "TimeoutError" }),
    shaped("E2E_PRECONDITION", "precondition: the publish answered"),
    new AssertionError({ message: "the case's budget ran out" }),
    shaped("E2E_DEFECT_ORACLE", "the case's budget ran out", { cause: budgetError() }),
    shaped("E2E_STATUS", "POST /publish: expected 200, got 504", { response: { status: 504, ms: 60_005 } }),
    shaped("E2E_TIMEOUT", "timed out after 460000 ms"),
    new Error("the case's budget ran out: not done within 5 ms"),
    null,
    "E2E_CASE_BUDGET",
  ];
  for (const err of never) assert.equal(judge(err, ctx), null, String(err?.code ?? err?.message ?? err));
  assert.equal(typeof judge(budgetError(), ctx), "string");

  for (const bad of [9_999, -1, Number.NaN, Infinity, "30000", null]) {
    assert.throws(() => httpStall(budgetError(), ctx, { slowMs: bad }), (e) => e instanceof TypeError && /^httpStall: slowMs is how long an answer took to count as the stack's, a number of ms, 10000 or more, got /.test(e.message), String(bad));
  }
  assert.throws(() => httpStall(budgetError(), ctx, { now: "now" }), (e) => e instanceof TypeError && /^httpStall: now is a Date\.now\(\) time, got "now"$/.test(e.message));
  for (const c of [null, {}, { requests: "rows" }, { requests: () => { throw new Error("boom"); } }, { requests: () => "rows" }]) {
    assert.equal(judge(budgetError(), c), null, "a ctx with no readable requests is no evidence, and never throws");
  }
});

test("http.mjs pendingRequests: a hop is listed under its sink from the moment it is sent until it is answered or fails; a client with evidence: false is never listed", async () => {
  const allow = { check: () => ({ allow: true }) };
  const lines = [];
  const sink = (line) => lines.push(line);
  const gates = [];
  const held = (url, init) => new Promise((resolve, reject) => {
    gates.push({ answer: () => resolve(new Response("ok", { status: 200 })), fail: () => reject(new Error("socket hang up")) });
    init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
  });
  const until = async (n) => {
    for (let i = 0; i < 200 && gates.length < n; i += 1) await new Promise((r) => setTimeout(r, 5));
    assert.equal(gates.length, n, "the stand-in fetch was reached");
  };
  const owner = createHttp(target, { actor: "owner", evidence: sink, guard: allow, fetch: held });
  const t0 = Date.now();
  const one = owner.post("/visibility?k=abcdefgh12345678", { json: { a: 1 } });
  await until(1);
  const listed = pendingRequests(sink);
  assert.equal(listed.length, 1);
  assert.deepEqual(Object.keys(listed[0]), ["t", "actor", "method", "url"]);
  assert.deepEqual([listed[0].actor, listed[0].method, listed[0].url], ["owner", "POST", `${target.origin}/visibility?k=‹redacted›`], "redacted, as its record will be");
  assert.ok(listed[0].t >= t0 && listed[0].t <= Date.now(), "when it was sent, on Date.now()'s clock");
  listed[0].actor = "changed";
  assert.equal(pendingRequests(sink)[0].actor, "owner", "copies");
  assert.equal(lines.length, 0, "no record yet: it is in flight");
  gates[0].answer();
  assert.equal((await one).status, 200);
  assert.deepEqual(pendingRequests(sink), [], "answered: no longer in flight");
  assert.equal(lines.length, 1);

  const two = owner.get("/x").catch((e) => e);
  await until(2);
  assert.equal(pendingRequests(sink).length, 1);
  gates[1].fail();
  assert.match(String((await two).message), /socket hang up/);
  assert.deepEqual(pendingRequests(sink), [], "failed: no longer in flight");
  assert.match(lines[1], /"error":"socket hang up"/);

  const timed = createHttp(target, { actor: "owner", evidence: sink, guard: allow, fetch: held, timeoutMs: 50 }).get("/y").catch((e) => e);
  assert.match(String((await timed).message), /^timeout after 50 ms$/);
  assert.deepEqual(pendingRequests(sink), [], "its own deadline: no longer in flight");

  // No evidence option: listed under the sink of the case it runs in, as its record will be.
  const caseSink = (line) => lines.push(line);
  const ambient = createHttp(target, { actor: "ambient", guard: allow, fetch: held });
  const three = withEvidenceSink(caseSink, () => ambient.get("/z"));
  await until(4);
  assert.deepEqual(pendingRequests(caseSink).map((h) => [h.actor, h.method, h.url]), [["ambient", "GET", `${target.origin}/z`]]);
  assert.deepEqual(pendingRequests(sink), [], "never another sink's");
  const quiet = createHttp(target, { actor: "quiet", evidence: false, guard: allow, fetch: held });
  const four = withEvidenceSink(caseSink, () => quiet.get("/q"));
  await until(5);
  assert.equal(pendingRequests(caseSink).length, 1, "NEGATIVE: evidence: false logs nowhere, and is listed nowhere");
  gates[3].answer();
  gates[4].answer();
  await Promise.all([three, four]);
  assert.deepEqual(pendingRequests(caseSink), []);
  for (const bad of [undefined, null, "sink", {}, 1]) assert.deepEqual(pendingRequests(bad), [], String(bad));
});

test("scenario: inconclusiveOnHttpStall is a boolean, and stands beside none of inconclusiveOnStackTimeout, inconclusiveOnPageStall or inconclusiveOnCaseTimeout set to false", () => {
  assert.throws(() => scenario("bad option", { inconclusiveOnHttpStall: "yes" }, async () => {}), (e) => e instanceof TypeError && /inconclusiveOnHttpStall is true or false, got "yes"/.test(e.message));
  assert.throws(() => scenario("bad option", { inconclusiveOnHttpStall: 1 }, async () => {}), TypeError);
  assert.throws(() => scenario("contradiction", { inconclusiveOnHttpStall: true, inconclusiveOnStackTimeout: false }, async () => {}), /inconclusiveOnHttpStall widens inconclusiveOnStackTimeout, which this case sets to false/);
  assert.throws(() => scenario("contradiction", { inconclusiveOnHttpStall: true, inconclusiveOnPageStall: false }, async () => {}), /inconclusiveOnHttpStall implies inconclusiveOnCaseTimeout, whose budget pageStall judges first, which this case turns off \(inconclusiveOnPageStall: false\)/);
  assert.throws(() => scenario("contradiction", { inconclusiveOnHttpStall: true, inconclusiveOnCaseTimeout: false }, async () => {}), /inconclusiveOnHttpStall judges the case's budget, which this case turns off \(inconclusiveOnCaseTimeout: false\)/);
});

// --- Through node --test and the reporter --------------------------------------

/** A case of 4 s keeps a quarter (1 s) back: its budget is 3 s. */
const T = 4_000;
const BUDGET = 3_000;

const fixture = (marker) => `// fixture spec, generated by selftest/http-stall.test.mjs
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { eventually } from ${JSON.stringify(lib("assert.mjs"))};
import { createHttp } from ${JSON.stringify(lib("http.mjs"))};
import { caseBudget, httpStall, onAnsweringStack, scenario } from ${JSON.stringify(lib("test.mjs"))};
// The fixture's clock: a stand-in fetch moves it as a slow stack would.
const realNow = Date.now;
let skew = 0;
let requestNow = null;
Date.now = () => requestNow ?? realNow() + skew;
const allow = { check: () => ({ allow: true }) };
const slowOk = async () => { requestNow += 35000; return new Response("ok", { status: 200, headers: { "content-type": "text/plain" } }); };
const held = (url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }));
const hung = (url, init) => { skew += 31000; return held(url, init); };
const never = () => new Promise(() => {});
async function slow(ctx) {
  // Freeze only this artificial request; budget timers and later waits still
  // see the ordinary clock after its exact interval has been recorded.
  requestNow = realNow() + skew;
  try {
    const r = await ctx.http({ actor: "owner", fetch: slowOk, guard: allow }).post("/visibility", { json: { expiresAt: 1 } });
    assert.equal(r.status, 200);
  } finally {
    skew = requestNow - realNow();
    requestNow = null;
  }
}
scenario("budget, its own request answered after 35 s, inconclusiveOnHttpStall", { timeoutMs: ${T}, inconclusiveOnHttpStall: true }, async (ctx) => { await slow(ctx); await never(); });
scenario("budget, its own request in flight for 31 s, inconclusiveOnHttpStall", { timeoutMs: ${T}, inconclusiveOnHttpStall: true }, async (ctx) => { await ctx.http({ actor: "harness", fetch: hung, guard: allow, timeoutMs: 5000 }).post("/publish"); });
scenario("budget, its own requests answered quickly, inconclusiveOnHttpStall", { timeoutMs: ${T}, inconclusiveOnHttpStall: true }, async (ctx) => { await ctx.http({ actor: "owner", guard: allow }).get("/plain"); await never(); });
scenario("budget, its own request answered after 35 s, inconclusiveOnCaseTimeout only", { timeoutMs: ${T}, inconclusiveOnCaseTimeout: true }, async (ctx) => { await slow(ctx); await never(); });
scenario("a wait ran out after a 35 s answer, inconclusiveOnHttpStall", { timeoutMs: ${T}, inconclusiveOnHttpStall: true }, async (ctx) => { await slow(ctx); await eventually(() => false, { timeout: 300, message: "the record" }); });
scenario("an assertion after a 35 s answer, inconclusiveOnHttpStall", { timeoutMs: ${T}, inconclusiveOnHttpStall: true }, async (ctx) => { await slow(ctx); assert.fail("the product answered wrongly"); });
scenario("by hand, onAnsweringStack(caseBudget(fn), {also: httpStall})", { timeoutMs: ${T} }, onAnsweringStack(caseBudget(async (ctx) => { await slow(ctx); await never(); }, ${T}), { also: (err, ctx) => httpStall(err, ctx) }));
scenario("ctx.requests({pending: true}) adds the case's requests still in flight", {}, async (ctx) => {
  await ctx.http({ actor: "reader", guard: allow }).get("/plain");
  const sent = [
    ctx.http({ actor: "owner", fetch: held, guard: allow, timeoutMs: 400 }).post("/visibility?k=abcdefgh12345678"),
    createHttp(ctx.target, { actor: "ambient", fetch: held, guard: allow, timeoutMs: 400 }).get("/z"), // no evidence option: the case's all the same
    createHttp(ctx.target, { actor: "elsewhere", evidence: false, fetch: held, guard: allow, timeoutMs: 400 }).get("/q"), // logs nowhere
  ].map((p) => p.then(() => "answered", (e) => String(e?.message ?? e)));
  await new Promise((r) => setTimeout(r, 100));
  const during = { plain: ctx.requests(), pending: ctx.requests({ pending: true }), nullArg: ctx.requests(null), notTrue: ctx.requests({ pending: "yes" }) };
  const ends = await Promise.all(sent);
  writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ during, after: ctx.requests({ pending: true }), ends }));
});
`;

function runAsync(cmd, args, { env, cwd, timeout }) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
    }, timeout);
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

test("through node --test and the reporter: opted in, a case whose budget ran out while the stack answered its own requests slowly (or still had one in flight) ends INCONCLUSIVE; a quick stack, the option off, another wait or an assertion FAILS; ctx.requests({pending: true}) gives the requests in flight", async () => {
  const targetFile = join(tmp, "target.json");
  writeFileSync(targetFile, JSON.stringify(target));
  const marker = join(tmp, "rows.json");
  const FIXTURE = fixture(marker);
  const spec = join(tmp, "fixture.spec.mjs");
  writeFileSync(spec, FIXTURE);
  const inv = createInvocation(runDir, { runId, suite: "functional", plan: [{ tier: "functional", files: [spec] }], grep: null, n: null });
  const env = { ...process.env, E2E_TARGET: targetFile, E2E_RUN_ID: runId, E2E_SUITE: "functional", E2E_INVOCATION_DIR: inv.dir };
  delete env.NODE_TEST_CONTEXT; // a nested node --test that inherits it streams to its parent and ignores reporters
  delete env.E2E_N;
  delete env.E2E_TRACE;
  delete env.E2E_CASE_TIMEOUT_MS;
  delete env.E2E_EVIDENCE;
  // ASYNC: the fixture's plain requests reach this process's own server.
  const proc = await runAsync(process.execPath, nodeTestArgs({ files: [spec], resultsFile: join(inv.dir, "results-functional.jsonl"), reporter: join(E2E_DIR, "lib", "reporter.mjs") }), { cwd: REPO_ROOT, timeout: 120_000, env });
  assert.notEqual(proc.status, null, `node --test hung and was killed (stdout tail: ${proc.stdout.slice(-800)})`);
  const records = readFileSync(join(inv.dir, "results-functional.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((r) => r.file === spec);
  const by = Object.fromEntries(records.map((r) => [r.name, r]));
  const failure = (e) => (e?.code && e.code !== "ERR_TEST_FAILURE" ? e.code : (e?.message ?? null));
  const outcome = (name) => [by[name]?.status, by[name]?.status === "inconclusive" ? by[name].inconclusive : failure(by[name]?.error)];
  const line = (needle) => FIXTURE.split("\n").findIndex((l) => l.includes(needle)) + 1;
  const scenarioLine = (name) => line(`scenario(${JSON.stringify(name)}`);
  const libLine = (file, needle) => readFileSync(join(E2E_DIR, "lib", file), "utf8").split("\n").findIndex((l) => l.includes(needle)) + 1;
  const budgetMessage = `the case's budget ran out: not done within ${BUDGET} ms (its timeoutMs ${T} less ${T - BUDGET} ms, kept to judge and record it)`;
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const viaScenario = `\\(via scenario, test\\.mjs:${libLine("test.mjs", "fn = caseBudget(fn, timeoutMs)")}\\)`;

  const answered = "budget, its own request answered after 35 s, inconclusiveOnHttpStall";
  const [s1, r1] = outcome(answered);
  assert.equal(s1, "inconclusive", String(r1));
  assert.match(r1, new RegExp(`^${esc(LEAD)}the case's budget ran out while the stack answered its own requests slowly: 1 of its 1 request\\(s\\) took 30 s or more \\(owner: POST /visibility answered 200 after 35000 ms\\), so the time it ran out of went to the stack — the failure, at fixture\\.spec\\.mjs:${scenarioLine(answered)} ${viaScenario}: ${esc(budgetMessage)}$`));
  assert.match(readFileSync(join(REPO_ROOT, by[answered].evidenceDir, "stack-did-not-answer.txt"), "utf8"), /the case's budget ran out/, "the failure itself is kept");

  const inFlight = "budget, its own request in flight for 31 s, inconclusiveOnHttpStall";
  const [s2, r2] = outcome(inFlight);
  assert.equal(s2, "inconclusive", String(r2));
  assert.match(r2, new RegExp(`: 1 of its 1 request\\(s\\) took 30 s or more \\(harness: POST /publish still unanswered after 3[45]\\d\\d\\d ms\\), so the time it ran out of went to the stack — the failure, at fixture\\.spec\\.mjs:${scenarioLine(inFlight)} `), "the request the budget ran out during, in flight");

  assert.deepEqual(outcome("budget, its own requests answered quickly, inconclusiveOnHttpStall"), ["fail", "E2E_CASE_BUDGET"], "NEGATIVE: a budget that ran out on a stack that answered quickly FAILS");
  assert.deepEqual(outcome("budget, its own request answered after 35 s, inconclusiveOnCaseTimeout only"), ["fail", "E2E_CASE_BUDGET"], "NEGATIVE: without the option a slow answer is no evidence, as before");
  assert.deepEqual(outcome("a wait ran out after a 35 s answer, inconclusiveOnHttpStall"), ["fail", "E2E_EVENTUALLY_TIMEOUT"], "a slow answer explains running out of time, never another wait");
  assert.deepEqual(outcome("an assertion after a 35 s answer, inconclusiveOnHttpStall"), ["fail", "ERR_ASSERTION"], "an assertion FAILS, whatever the stack did");

  const byHand = "by hand, onAnsweringStack(caseBudget(fn), {also: httpStall})";
  const [s7, r7] = outcome(byHand);
  assert.equal(s7, "inconclusive", String(r7));
  assert.match(r7, new RegExp(`\\(owner: POST /visibility answered 200 after 35000 ms\\), so the time it ran out of went to the stack — the failure, at fixture\\.spec\\.mjs:${scenarioLine(byHand)} \\(via caseBudget, test\\.mjs:\\d+\\): ${esc(budgetMessage)}$`));

  assert.deepEqual(outcome("ctx.requests({pending: true}) adds the case's requests still in flight"), ["pass", null]);
  const { during, after: later, ends } = JSON.parse(readFileSync(marker, "utf8"));
  assert.deepEqual(during.plain.map((r) => [r.actor, r.path, r.status]), [["reader", "/plain", 200]], "without the option: answered rows only, as before");
  assert.deepEqual(during.nullArg, during.plain, "ctx.requests(null) never throws, and adds nothing");
  assert.deepEqual(during.notTrue, during.plain, "only pending: true adds the rows in flight");
  assert.deepEqual(during.pending.map((r) => [r.actor, r.method, r.path, r.status, r.ms, r.at, r.error, r.pending ?? false]), [
    ["reader", "GET", "/plain", 200, during.plain[0].ms, during.plain[0].at, null, false],
    ["owner", "POST", "/visibility", null, null, null, null, true],
    ["ambient", "GET", "/z", null, null, null, null, true],
  ], "the answered rows, then one per request in flight, a client without an evidence option among them; none from evidence: false");
  for (const r of during.pending.slice(1)) {
    assert.deepEqual(Object.keys(r), ["t", "at", "actor", "method", "url", "path", "status", "ms", "error", "pending"]);
    assert.ok(Number.isFinite(r.t), JSON.stringify(r));
  }
  assert.match(during.pending[1].url, /\/visibility\?k=‹redacted›$/, "redacted, as its record will be");
  assert.ok(!JSON.stringify(during).includes("abcdefgh12345678"), "a link key never reaches a row");
  assert.deepEqual(ends, ["timeout after 400 ms", "timeout after 400 ms", "timeout after 400 ms"]);
  assert.deepEqual(later.map((r) => [r.actor, r.path, r.status, r.error, r.pending ?? false]), [
    ["reader", "/plain", 200, null, false],
    ["owner", "/visibility", null, "timeout after 400 ms", false],
    ["ambient", "/z", null, "timeout after 400 ms", false],
  ], "once over, each is an answered row, and none is in flight");
  assert.equal(records.length, 8, `one record per case: ${records.map((r) => r.name).join(" | ")}`);
});
