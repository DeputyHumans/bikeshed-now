// SPDX-License-Identifier: Apache-2.0
// Self-test: the case's own requests that Hosting cut off are a stall pageStall may count — its `requests` option, ctx.requests() and scenario's inconclusiveOnRequestStall (SPEC §12).

/**
 * pageStall's `requests` option is checked here against rows shaped as
 * ctx.requests() gives them, and errors of the shapes the lib throws when a
 * wait runs out. Then a generated fixture spec runs through `node --test`
 * with the real reporter, the way run.mjs runs one: each case makes its
 * requests through real http.mjs clients (ctx.http, and one made without an
 * evidence option), one of them answered by a stand-in fetch that moves the
 * fixture's clock past Hosting's cut-off as it answers 504 (a self-test
 * cannot wait a minute for it), and then runs out of its budget or a wait, or
 * fails an assertion. A local server answers the plain requests. No browser.
 */

import { after, before, test } from "node:test";
import assert, { AssertionError } from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createInvocation, nodeTestArgs } from "../lib/invocation.mjs";
import { E2E_DIR, E2E_TMP, OUT_DIR, REPO_ROOT, ensureDir } from "../lib/paths.mjs";
import { pageStall, scenario } from "../lib/test.mjs";

const lib = (f) => pathToFileURL(join(E2E_DIR, "lib", f)).href;
const LEAD = "the stack did not answer, so nothing was measured: ";
const LOST_LINE = "@firebase/firestore: Firestore (11.0.0): Could not reach Cloud Firestore backend. Backend didn't respond within 10 seconds.";
const NOW = 1_800_000_000_000;

const runId = `selftest-request-stall-${process.pid}`;
let server;
let target;
let tmp;
let runDir;

const shaped = (code, message, extra = {}) => Object.assign(new Error(message), { code }, extra);
const timeoutError = (message) => Object.assign(new Error(message), { name: "TimeoutError" });

/** A row as ctx.requests() gives one, answered `ago` ms before NOW after `ms`. */
function row(ago, ms, { status = 504, path = "/publish", actor = "owner", method = "POST" } = {}) {
  const t = NOW - ago - ms;
  return { t, at: NOW - ago, actor, method, url: `http://127.0.0.1:1${path}`, path, status, ms, error: null };
}
/** A ctx with only what pageStall reads: its pages (shaped as BrowserPool's) and its own requests. */
const ctxWith = ({ users = [], rows = [] } = {}) => ({ usersSoFar: users, requests: () => rows });
const page = (name, { lost = [], cut = [] } = {}) => ({
  name,
  responses: cut.map(([ago, ms, path = "/access"]) => ({ seq: 0, t: NOW - ago - ms, at: NOW - ago, ms, method: "POST", url: `http://127.0.0.1:1${path}`, path, status: 504 })),
  log: { console: lost.map((ago) => ({ t: NOW - ago, type: "error", text: LOST_LINE })), sdkProbes: [], requests: [] },
});
const judge = (err, ctx, o = {}) => pageStall(err, ctx, { now: NOW, ...o });

before(async () => {
  server = http.createServer((req, res) => {
    res.setHeader("content-type", "text/plain");
    res.end("ok");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  tmp = mkdtempSync(join(ensureDir(E2E_TMP, "E2E_TMP"), "selftest-request-stall-"));
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

test("pageStall({requests: true}): the case's own request answered Hosting's cut-off 504 in the wait's window is evidence; off by default", () => {
  const wait = timeoutError("locator.click: Timeout 90000ms exceeded.\nCall log:\n  - waiting for the thread within 5 ms");
  const cutCtx = ctxWith({ rows: [row(20_000, 60_005)] });
  const why = judge(wait, cutCtx, { requests: true });
  assert.match(why, /^a request this case made got Hosting's cut-off 504 \(owner: POST \/publish 504 after 60005 ms\), in the 100 s before a wait ran out — the failure, at request-stall\.test\.mjs:\d+: locator\.click: Timeout 90000ms exceeded\.$/);
  assert.equal(judge(wait, cutCtx), null, "NEGATIVE: without the option it judges as it always did, on pages alone");
  assert.equal(judge(wait, cutCtx, { requests: false }), null);

  assert.equal(typeof judge(wait, ctxWith({ rows: [row(99_999, 60_005)] }), { requests: true }), "string", "the wait (90 s) and the margin (10 s)");
  assert.equal(judge(wait, ctxWith({ rows: [row(100_001, 60_005)] }), { requests: true }), null, "NEGATIVE: answered before the wait's window");
  assert.equal(judge(wait, ctxWith({ rows: [row(1_000, 58_999)] }), { requests: true }), null, "NEGATIVE: a quicker 504 is the product's answer");
  assert.equal(judge(wait, ctxWith({ rows: [row(1_000, 60_005, { status: 500 })] }), { requests: true }), null, "NEGATIVE: another status at the cut-off is the product's");
  assert.equal(judge(wait, ctxWith({ rows: [{ ...row(1_000, 150_000), status: null, error: "timeout after 150000 ms" }] }), { requests: true }), null, "a request nothing answered is not Hosting's cut-off");
  assert.equal(judge(wait, ctxWith({ rows: [{ ...row(1_000, 60_005), t: null, at: null }] }), { requests: true }), null, "a row with no time cannot be placed in the window");
  assert.equal(judge(wait, ctxWith(), { requests: true }), null, "no requests, no evidence");

  const iso = { t: new Date(NOW - 5_000 - 60_005).toISOString(), method: "POST", url: "http://127.0.0.1:1/session?k=abcdefgh12345678", status: 504, ms: 60_005 };
  const isoWhy = judge(wait, ctxWith({ rows: [iso] }), { requests: true });
  assert.match(isoWhy, /^a request this case made got Hosting's cut-off 504 \(this case: POST \/session 504 after 60005 ms\)/, "an ISO `t` and no `at` (a spec's own rows); no actor");
  assert.doesNotMatch(isoWhy, /abcdefgh12345678/, "a link key never reaches a reason");

  const many = judge(wait, ctxWith({ rows: ["/a", "/b", "/c", "/d", "/e"].map((p, i) => row(1_000 + i, 60_005, { path: p })) }), { requests: true });
  assert.match(many, /\(owner: POST \/a 504 after 60005 ms; owner: POST \/b 504 after 60005 ms; owner: POST \/c 504 after 60005 ms; and 2 more\)/);

  const both = judge(wait, ctxWith({ users: [page("reader", { cut: [[2_000, 60_010]], lost: [3_000] })], rows: [row(1_000, 60_005)] }), { requests: true });
  assert.match(both, /^a page's request got Hosting's cut-off 504 \(reader: POST \/access 504 after 60010 ms\), and a page's Firestore client lost the emulator \(reader: "Could not reach Cloud Firestore backend"\), and a request this case made got Hosting's cut-off 504 \(owner: POST \/publish 504 after 60005 ms\), in the 100 s/, "a page's evidence first, as it always read");
  const pagesOnly = judge(wait, ctxWith({ users: [page("reader", { lost: [3_000] })], rows: [row(1_000, 60_005)] }));
  assert.match(pagesOnly, /^a page's Firestore client lost the emulator \(reader: "Could not reach Cloud Firestore backend"\), in the 100 s before/, "without the option the requests are not named");
});

test("pageStall({requests: true}) judges only what it always judged: a wait (the case's budget included) or a precondition; never an assertion, an answer, a known defect's oracle or a refusal", () => {
  const ctx = ctxWith({ rows: [row(1_000, 60_005)] });
  const budget = shaped("E2E_CASE_BUDGET", "the case's budget ran out: not done within 285000 ms (its timeoutMs 300000 less 15000 ms, kept to judge and record it)", { budgetMs: 285_000, timeoutMs: 300_000 });
  assert.match(judge(budget, ctx, { requests: true }), /^a request this case made got Hosting's cut-off 504 \(owner: POST \/publish 504 after 60005 ms\), in the 295 s before a wait ran out — the failure, at [^:]+:\d+: the case's budget ran out/);
  assert.match(judge(shaped("E2E_PRECONDITION", "precondition: publish answered 504"), ctx, { requests: true }), /in the 130 s before a precondition failed/);
  assert.match(judge(shaped("E2E_EVENTUALLY_TIMEOUT", "eventually: x not met within 4000 ms after 3 samples; last value: null"), ctx, { requests: true }), /in the 14 s before a wait ran out/);
  const never = [
    new AssertionError({ message: "x not met within 5 ms" }),
    shaped("E2E_DEFECT_ORACLE", "u: no matching toast within 5 ms"),
    shaped("E2E_INCONCLUSIVE", "INCONCLUSIVE: within 5 ms"),
    shaped("E2E_GUARD", "guard refused within 5 ms"),
    shaped("E2E_SYNC_TIMEOUT", "barrier: 2 of 3 arrived within 5 ms"),
    shaped("E2E_STATUS", "POST /publish: expected 200, got 504: within 5 ms", { response: { status: 504, ms: 900 } }),
    new Error("plain failure"),
    null,
  ];
  for (const err of never) assert.equal(judge(err, ctx, { requests: true }), null, String(err?.code ?? err?.message ?? err));
});

test("pageStall: a ctx without requests(), or whose requests() throws or gives no array, is no evidence and never throws; `requests` that is not a boolean throws", () => {
  const wait = new Error("u: no matching toast within 1000 ms");
  assert.equal(judge(wait, { usersSoFar: [] }, { requests: true }), null, "no requests() at all (a spec's own pseudo ctx)");
  assert.equal(judge(wait, { usersSoFar: [], requests: () => { throw new Error("boom"); } }, { requests: true }), null);
  assert.equal(judge(wait, { usersSoFar: [], requests: () => "rows" }, { requests: true }), null);
  assert.equal(judge(wait, { usersSoFar: [], requests: "rows" }, { requests: true }), null);
  assert.equal(judge(wait, null, { requests: true }), null);
  for (const bad of ["yes", 1, null, {}]) {
    assert.throws(() => pageStall(wait, ctxWith(), { requests: bad }), (e) => e instanceof TypeError && /^pageStall: requests is true \(count the case's own requests, ctx\.requests\(\)\) or false, got /.test(e.message), JSON.stringify(bad));
  }
});

test("scenario: inconclusiveOnRequestStall is a boolean, and stands beside neither inconclusiveOnStackTimeout: false nor inconclusiveOnPageStall: false", () => {
  assert.throws(() => scenario("bad option", { inconclusiveOnRequestStall: "yes" }, async () => {}), (e) => e instanceof TypeError && /inconclusiveOnRequestStall is true or false, got "yes"/.test(e.message));
  assert.throws(() => scenario("bad option", { inconclusiveOnRequestStall: 1 }, async () => {}), TypeError);
  assert.throws(() => scenario("contradiction", { inconclusiveOnRequestStall: true, inconclusiveOnStackTimeout: false }, async () => {}), /inconclusiveOnRequestStall widens inconclusiveOnStackTimeout, which this case sets to false/);
  assert.throws(() => scenario("contradiction", { inconclusiveOnRequestStall: true, inconclusiveOnPageStall: false }, async () => {}), /inconclusiveOnRequestStall is pageStall counting the case's own requests too, which this case turns off \(inconclusiveOnPageStall: false\)/);
});

// --- Through node --test and the reporter --------------------------------------

/** A case of 4 s keeps a quarter (1 s) back: its budget is 3 s. */
const T = 4_000;
const BUDGET = 3_000;

const fixture = (marker) => `// fixture spec, generated by selftest/request-stall.test.mjs
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { eventually } from ${JSON.stringify(lib("assert.mjs"))};
import { createHttp } from ${JSON.stringify(lib("http.mjs"))};
import { caseBudget, onAnsweringStack, pageStall, scenario } from ${JSON.stringify(lib("test.mjs"))};
// The fixture's clock: the stand-in fetch moves it past Hosting's cut-off as it answers.
const realNow = Date.now;
let skew = 0;
Date.now = () => realNow() + skew;
const allow = { check: () => ({ allow: true }) };
const cutoff = async () => { skew += 60005; return new Response("Timed out waiting for function to respond.", { status: 504, headers: { "content-type": "text/plain" } }); };
const quick504 = async () => new Response("Timed out waiting for function to respond.", { status: 504, headers: { "content-type": "text/plain" } });
const never = () => new Promise(() => {});
async function cut(ctx) {
  const r = await ctx.http({ actor: "owner", fetch: cutoff, guard: allow }).post("/publish", { json: { title: "t" } });
  assert.equal(r.status, 504);
}
scenario("budget, its own request cut off, inconclusiveOnRequestStall", { timeoutMs: ${T}, inconclusiveOnCaseTimeout: true, inconclusiveOnRequestStall: true }, async (ctx) => { await cut(ctx); await never(); });
scenario("budget, its own request cut off, inconclusiveOnCaseTimeout only", { timeoutMs: ${T}, inconclusiveOnCaseTimeout: true }, async (ctx) => { await cut(ctx); await never(); });
scenario("budget, a quick 504, inconclusiveOnRequestStall", { timeoutMs: ${T}, inconclusiveOnCaseTimeout: true, inconclusiveOnRequestStall: true }, async (ctx) => { await ctx.http({ actor: "owner", fetch: quick504, guard: allow }).post("/publish"); await never(); });
scenario("a wait ran out after its own request was cut off, inconclusiveOnRequestStall", { inconclusiveOnRequestStall: true }, async (ctx) => { await cut(ctx); await eventually(() => false, { timeout: 300, message: "the record" }); });
scenario("an assertion after its own request was cut off, inconclusiveOnRequestStall", { inconclusiveOnRequestStall: true }, async (ctx) => { await cut(ctx); assert.fail("the product answered wrongly"); });
scenario("by hand, onAnsweringStack(caseBudget(fn), {also: pageStall with requests})", { timeoutMs: ${T} }, onAnsweringStack(caseBudget(async (ctx) => { await cut(ctx); await never(); }, ${T}), { also: (err, ctx) => pageStall(err, ctx, { requests: true }) }));
scenario("ctx.requests() gives the case's own requests as rows", {}, async (ctx) => {
  await ctx.http({ actor: "reader", guard: allow }).get("/plain");
  await ctx.http({ actor: "owner", fetch: cutoff, guard: allow }).post("/publish?k=abcdefgh12345678");
  await createHttp(ctx.target, { actor: "ambient", guard: allow }).get("/plain"); // no evidence option: the case's sink all the same
  await ctx.http({ actor: "broken", fetch: async () => { throw new Error("socket hang up"); }, guard: allow }).get("/x").catch(() => undefined);
  await createHttp(ctx.target, { actor: "elsewhere", evidence: false, guard: allow }).get("/plain"); // evidence: false logs nowhere
  const first = ctx.requests();
  first[0].status = 999; // a copy: changing it changes nothing
  writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ rows: ctx.requests() }));
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

test("through node --test and the reporter: opted in, a case whose own request Hosting cut off ends INCONCLUSIVE when its budget or a wait runs out; without the option, after a quicker 504, or on an assertion it FAILS; ctx.requests() gives its rows", async () => {
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
  const ownCut = "a request this case made got Hosting's cut-off 504 \\(owner: POST /publish 504 after 6000\\d ms\\)";
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const opted = "budget, its own request cut off, inconclusiveOnRequestStall";
  const [s1, r1] = outcome(opted);
  assert.equal(s1, "inconclusive", String(r1));
  assert.match(r1, new RegExp(`^${esc(LEAD)}${ownCut}, in the 13 s before a wait ran out — the failure, at fixture\\.spec\\.mjs:${scenarioLine(opted)} \\(via scenario, test\\.mjs:${libLine("test.mjs", "fn = caseBudget(fn, timeoutMs)")}\\): ${esc(budgetMessage)}$`));
  assert.match(readFileSync(join(REPO_ROOT, by[opted].evidenceDir, "stack-did-not-answer.txt"), "utf8"), /the case's budget ran out/, "the failure itself is kept");

  assert.deepEqual(outcome("budget, its own request cut off, inconclusiveOnCaseTimeout only"), ["fail", "E2E_CASE_BUDGET"], "NEGATIVE: without the option a case's own requests are no evidence, as before");
  assert.deepEqual(outcome("budget, a quick 504, inconclusiveOnRequestStall"), ["fail", "E2E_CASE_BUDGET"], "NEGATIVE: a quicker 504 is the product's answer, no stall");

  const waited = "a wait ran out after its own request was cut off, inconclusiveOnRequestStall";
  const [s4, r4] = outcome(waited);
  assert.equal(s4, "inconclusive", String(r4));
  assert.match(r4, new RegExp(`^${esc(LEAD)}${ownCut}, in the 10 s before a wait ran out — the failure, at fixture\\.spec\\.mjs:${scenarioLine(waited)} \\(via eventually, assert\\.mjs:\\d+\\): eventually: the record not met within 300 ms`));
  assert.deepEqual(outcome("an assertion after its own request was cut off, inconclusiveOnRequestStall"), ["fail", "ERR_ASSERTION"], "an assertion FAILS, whatever the stack did");

  const byHand = "by hand, onAnsweringStack(caseBudget(fn), {also: pageStall with requests})";
  const [s6, r6] = outcome(byHand);
  assert.equal(s6, "inconclusive", String(r6));
  assert.match(r6, new RegExp(`^${esc(LEAD)}${ownCut}, in the 13 s before a wait ran out — the failure, at fixture\\.spec\\.mjs:${scenarioLine(byHand)} \\(via caseBudget, test\\.mjs:\\d+\\): ${esc(budgetMessage)}$`));

  assert.deepEqual(outcome("ctx.requests() gives the case's own requests as rows"), ["pass", null]);
  const { rows } = JSON.parse(readFileSync(marker, "utf8"));
  assert.deepEqual(rows.map((r) => [r.actor, r.method, r.path, r.status, r.error]), [
    ["reader", "GET", "/plain", 200, null],
    ["owner", "POST", "/publish", 504, null],
    ["ambient", "GET", "/plain", 200, null],
    ["broken", "GET", "/x", null, "socket hang up"],
  ], "every request the case made, a client without an evidence option among them; none from a client with evidence: false; a copy each call");
  for (const r of rows) {
    assert.deepEqual(Object.keys(r), ["t", "at", "actor", "method", "url", "path", "status", "ms", "error"]);
    assert.ok(Number.isFinite(r.t) && Number.isFinite(r.ms) && r.at === r.t + r.ms, JSON.stringify(r));
    assert.ok(r.url.startsWith(`${target.origin}/`), r.url);
  }
  assert.ok(rows[1].ms >= 60_005 && rows[1].ms < 61_000, `the cut-off's measured wait: ${rows[1].ms}`);
  assert.match(rows[1].url, /\/publish\?k=‹redacted›$/, "redacted, as http.jsonl holds it");
  assert.ok(!JSON.stringify(rows).includes("abcdefgh12345678"), "a link key never reaches a row");
  assert.equal(records.length, 7, `one record per case: ${records.map((r) => r.name).join(" | ")}`);
});
