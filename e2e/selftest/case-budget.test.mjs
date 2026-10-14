// SPDX-License-Identifier: Apache-2.0
// Self-test: a case's own timeout, run as a budget, is a wait the judges read — caseBudget and scenario's inconclusiveOnCaseTimeout (SPEC §12).

/**
 * caseBudget is checked in this process: its margin (on mock timers for a
 * long case, in real time for a short one), its error, that pageStall reads
 * that error as a wait over the whole case and stackDidNotAnswer does not,
 * and its refusals. Then a generated fixture spec runs through `node --test`
 * with the real reporter, the way run.mjs runs one, with real pages: a body
 * that never finishes while its page lost the emulator, the same on a quiet
 * page, the same without the option (node:test's own timeout), a late body
 * after its budget, and the outcomes the option must not change. A local
 * server stands in for the stack. Needs Chrome.
 */

import { after, before, mock, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createInvocation, nodeTestArgs } from "../lib/invocation.mjs";
import { E2E_DIR, E2E_TMP, OUT_DIR, REPO_ROOT, ensureDir } from "../lib/paths.mjs";
import { CASE_BUDGET_MARGIN_MS, callSite, caseBudget, pageStall, scenario, stackDidNotAnswer } from "../lib/test.mjs";

const lib = (f) => pathToFileURL(join(E2E_DIR, "lib", f)).href;
const LEAD = "the stack did not answer, so nothing was measured: ";
const LOST_LINE = "@firebase/firestore: Firestore (11.0.0): Could not reach Cloud Firestore backend. Backend didn't respond within 10 seconds.";
const budgetMessage = (budgetMs, timeoutMs) => `the case's budget ran out: not done within ${budgetMs} ms (its timeoutMs ${timeoutMs} less ${timeoutMs - budgetMs} ms, kept to judge and record it)`;

const runId = `selftest-budget-${process.pid}`;
let server;
let target;
let tmp;
let runDir;

/** What `p` rejects with (it must reject). */
async function rejection(p) {
  try {
    await p;
  } catch (err) {
    return err;
  }
  assert.fail("expected a rejection");
}

const never = () => new Promise(() => {});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** A ctx with only what caseBudget and pageStall read: its steps, and users shaped as BrowserPool's. */
const ctxWith = (users = []) => {
  const steps = [];
  return { steps, usersSoFar: users, ev: { step: (s) => steps.push(s), text() {} } };
};

before(async () => {
  server = http.createServer((req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end("<!doctype html><title>app</title><body>app</body>");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  tmp = mkdtempSync(join(ensureDir(E2E_TMP, "E2E_TMP"), "selftest-case-budget-"));
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

test("caseBudget: a long case keeps CASE_BUDGET_MARGIN_MS back from its timeout; running out is E2E_CASE_BUDGET, at the case's declaration", async () => {
  assert.equal(CASE_BUDGET_MARGIN_MS, 20_000);
  mock.timers.enable({ apis: ["setTimeout"] });
  let err;
  try {
    const ctx = ctxWith();
    const p = caseBudget(never, 600_000)(ctx);
    p.catch(() => undefined);
    mock.timers.tick(579_999);
    await Promise.resolve();
    assert.deepEqual(ctx.steps, [], "not yet: one ms short of the budget");
    mock.timers.tick(1);
    err = await rejection(p);
    assert.deepEqual(ctx.steps, ["the case's budget of 580000 ms ran out: the body is abandoned, and its failure judged while the case can still report it"]);
  } finally {
    mock.timers.reset();
  }
  assert.equal(err.code, "E2E_CASE_BUDGET");
  assert.equal(err.message, budgetMessage(580_000, 600_000));
  assert.equal(err.budgetMs, 580_000);
  assert.equal(err.timeoutMs, 600_000);
  assert.match(callSite(err), /^case-budget\.test\.mjs:\d+ \(via caseBudget, test\.mjs:\d+\)$/, "the stack is where the budget was declared, never the timer's");
  assert.equal(stackDidNotAnswer(err), null, "running out of time is a wait, not a request the stack did not answer");
});

test("caseBudget: a short case keeps a quarter of its timeout; a body done in time returns its value or its own failure, and leaves no timer", async () => {
  const t0 = Date.now();
  const ctx = ctxWith();
  const err = await rejection(caseBudget(never, 800)(ctx));
  const took = Date.now() - t0;
  assert.equal(err.message, budgetMessage(600, 800));
  assert.ok(took >= 590 && took < 800, `ran out after ${took} ms, before the case's 800 ms`);

  const quiet = ctxWith();
  assert.equal(await caseBudget(async () => "done", 400)(quiet), "done");
  const boom = new Error("boom");
  assert.equal(await rejection(caseBudget(async () => { throw boom; }, 400)(quiet)), boom, "the body's own failure, as it was");
  assert.equal(await rejection(caseBudget(() => { throw boom; }, 400)(quiet)), boom, "a body that throws at once");
  await sleep(450);
  assert.deepEqual(quiet.steps, [], "a body done in time cleared its budget");
});

test("pageStall reads the budget as a wait over the whole case: a page's stall anywhere in it is evidence; none is not", async () => {
  const now = 1_800_000_000_000;
  const err = Object.assign(new Error(budgetMessage(285_000, 300_000)), { code: "E2E_CASE_BUDGET", budgetMs: 285_000, timeoutMs: 300_000 });
  const lostAgo = (ago) => [{ name: "reader", log: { console: [{ t: now - ago, type: "error", text: LOST_LINE }], sdkProbes: [] }, responses: [] }];
  const cutAgo = (ago) => [{ name: "owner", log: { console: [], sdkProbes: [] }, responses: [{ seq: 1, t: now - ago - 60_005, at: now - ago, ms: 60_005, method: "POST", url: "http://127.0.0.1:1/folder", path: "/folder", status: 504 }] }];
  const why = pageStall(err, ctxWith(lostAgo(280_000)), { now });
  assert.match(why, /^a page's Firestore client lost the emulator \(reader: "Could not reach Cloud Firestore backend"\), in the 295 s before a wait ran out — the failure, at .*: the case's budget ran out: not done within 285000 ms/);
  assert.match(pageStall(err, ctxWith(cutAgo(200_000)), { now }), /^a page's request got Hosting's cut-off 504 \(owner: POST \/folder 504 after 60005 ms\)/);
  assert.equal(pageStall(err, ctxWith(lostAgo(296_000)), { now }), null, "NEGATIVE: before the case began is not this case's stall");
  assert.equal(pageStall(err, ctxWith([]), { now }), null, "NEGATIVE: no pages, no evidence");
});

test("caseBudget and the option refuse what is not a body, a timeout or a boolean", () => {
  assert.throws(() => caseBudget("body", 1_000), (e) => e instanceof TypeError && /body is the case's \(ctx\) => …, got string/.test(e.message));
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, "60000", null, undefined]) {
    assert.throws(() => caseBudget(async () => {}, bad), (e) => e instanceof TypeError && /caseBudget: timeoutMs is the case's timeout, a positive number of ms/.test(e.message), String(bad));
  }
  assert.throws(() => scenario("bad option", { inconclusiveOnCaseTimeout: "yes" }, async () => {}), /inconclusiveOnCaseTimeout is true or false, got "yes"/);
  assert.throws(() => scenario("bad option", { inconclusiveOnCaseTimeout: 1 }, async () => {}), TypeError);
  assert.throws(() => scenario("contradiction", { inconclusiveOnCaseTimeout: true, inconclusiveOnStackTimeout: false }, async () => {}), /inconclusiveOnCaseTimeout widens inconclusiveOnStackTimeout, which this case sets to false/);
  assert.throws(() => scenario("contradiction", { inconclusiveOnCaseTimeout: true, inconclusiveOnPageStall: false }, async () => {}), /inconclusiveOnCaseTimeout reads the case's timeout as a wait for pageStall, which this case turns off/);
});

// --- Through node --test and the reporter --------------------------------------

/** Enough margin (a quarter, 6 s) to judge and capture a page after the budget runs out. */
const TIMEOUT_MS = 24_000;
const BUDGET_MS = 18_000; // TIMEOUT_MS less a quarter of it
/** A margin (a quarter, 2.5 s) shorter than closing a Chrome takes (3 s idle): the outcome must not wait for it. */
const LOST_TIMEOUT_MS = 10_000;
const LOST_BUDGET_MS = 7_500;
/** The case without the option only waits for node:test's own timeout. */
const BARE_TIMEOUT_MS = 8_000;

const fixture = (marker) => `// fixture spec, generated by selftest/case-budget.test.mjs
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { scenario } from ${JSON.stringify(lib("test.mjs"))};
const LOST = ${JSON.stringify(LOST_LINE)};
const never = () => new Promise(() => {});
async function page(ctx, lost) {
  const u = await ctx.users.user({ name: "reader" });
  await u.goto("/app");
  if (lost) {
    await u.page.evaluate((line) => console.error(line), LOST);
    await u.poll(() => u.log.console.some((c) => c.text.includes("Could not reach")), { timeout: 5000, what: "the console line" });
  }
  return u;
}
scenario("budget, a page lost the emulator, opted in", { timeoutMs: ${LOST_TIMEOUT_MS}, inconclusiveOnCaseTimeout: true }, async (ctx) => { await page(ctx, true); await never(); });
scenario("budget, a quiet page, opted in; the late body asks for users", { timeoutMs: ${TIMEOUT_MS}, inconclusiveOnCaseTimeout: true }, async (ctx) => {
  await page(ctx, false);
  await new Promise((r) => setTimeout(r, ${BUDGET_MS} + 1000));
  try {
    const pool = ctx.users;
    writeFileSync(${JSON.stringify(marker)}, "made: " + typeof pool);
  } catch (err) {
    writeFileSync(${JSON.stringify(marker)}, "refused: " + err.message);
  }
});
scenario("timeout, a page lost the emulator, inconclusiveOnPageStall only", { timeoutMs: ${BARE_TIMEOUT_MS}, inconclusiveOnPageStall: true }, async (ctx) => { await page(ctx, true); await never(); });
scenario("done in time, a page lost the emulator, opted in", { timeoutMs: ${TIMEOUT_MS}, inconclusiveOnCaseTimeout: true }, async (ctx) => { const u = await page(ctx, true); assert.equal(await u.page.title(), "app"); });
scenario("an assertion in time, a page lost the emulator, opted in", { timeoutMs: ${TIMEOUT_MS}, inconclusiveOnCaseTimeout: true }, async (ctx) => { await page(ctx, true); assert.fail("the page ignored what it was delivered"); });
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

test("through node --test and the reporter: opted in, a case out of time while its page lost the emulator is INCONCLUSIVE at its declaration; on a quiet page it FAILS as its own budget; without the option node:test's timeout FAILS it", async () => {
  const targetFile = join(tmp, "target.json");
  writeFileSync(targetFile, JSON.stringify(target));
  const marker = join(tmp, "late-body.txt");
  const FIXTURE = fixture(marker);
  const spec = join(tmp, "fixture.spec.mjs");
  writeFileSync(spec, FIXTURE);
  const inv = createInvocation(runDir, { runId, suite: "functional", plan: [{ tier: "functional", files: [spec] }], grep: null, n: null });
  const env = { ...process.env, E2E_TARGET: targetFile, E2E_RUN_ID: runId, E2E_SUITE: "functional", E2E_INVOCATION_DIR: inv.dir };
  delete env.NODE_TEST_CONTEXT; // a nested node --test that inherits it streams to its parent and ignores reporters
  delete env.E2E_N;
  delete env.E2E_TRACE;
  delete env.E2E_CASE_TIMEOUT_MS;
  // ASYNC: the fixture's pages reach this process's own server.
  const proc = await runAsync(process.execPath, nodeTestArgs({ files: [spec], resultsFile: join(inv.dir, "results-functional.jsonl"), reporter: join(E2E_DIR, "lib", "reporter.mjs") }), { cwd: REPO_ROOT, timeout: 240_000, env });
  assert.notEqual(proc.status, null, `node --test hung and was killed (stdout tail: ${proc.stdout.slice(-800)})`);
  const records = readFileSync(join(inv.dir, "results-functional.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((r) => r.file === spec);
  const by = Object.fromEntries(records.map((r) => [r.name, r]));
  const failure = (e) => (e?.code && e.code !== "ERR_TEST_FAILURE" ? e.code : (e?.message ?? null));
  const outcome = (name) => [by[name]?.status, by[name]?.status === "inconclusive" ? by[name].inconclusive : failure(by[name]?.error)];
  const line = (needle) => FIXTURE.split("\n").findIndex((l) => l.includes(needle)) + 1;
  const scenarioLine = (name) => line(`scenario(${JSON.stringify(name)}`);
  const budgetLine = readFileSync(join(E2E_DIR, "lib", "test.mjs"), "utf8").split("\n").findIndex((l) => l.includes("fn = caseBudget(fn, timeoutMs)")) + 1;

  const [s1, r1] = outcome("budget, a page lost the emulator, opted in");
  assert.equal(s1, "inconclusive", `${r1} (its outcome must not wait for its Chrome to close)`);
  assert.equal(r1, `${LEAD}a page's Firestore client lost the emulator (reader: "Could not reach Cloud Firestore backend"), in the ${Math.round((LOST_BUDGET_MS + 10_000) / 1000)} s before a wait ran out — the failure, at fixture.spec.mjs:${scenarioLine("budget, a page lost the emulator, opted in")} (via scenario, test.mjs:${budgetLine}): ${budgetMessage(LOST_BUDGET_MS, LOST_TIMEOUT_MS)}`);
  const ev = join(REPO_ROOT, by["budget, a page lost the emulator, opted in"].evidenceDir);
  assert.match(readFileSync(join(ev, "stack-did-not-answer.txt"), "utf8"), new RegExp(`the case's budget ran out: not done within ${LOST_BUDGET_MS} ms`), "the failure itself is kept");
  assert.match(readFileSync(join(ev, "steps.md"), "utf8"), new RegExp(`the case's budget of ${LOST_BUDGET_MS} ms ran out: the body is abandoned`));

  const quiet = "budget, a quiet page, opted in; the late body asks for users";
  assert.deepEqual(outcome(quiet), ["fail", "E2E_CASE_BUDGET"], "NEGATIVE: out of time on a stack that kept answering FAILS, as its own budget");
  const quietEv = join(REPO_ROOT, by[quiet].evidenceDir);
  assert.match(readFileSync(join(quietEv, "error.txt"), "utf8"), new RegExp(`the case's budget ran out: not done within ${BUDGET_MS} ms`));
  assert.ok(existsSync(join(quietEv, "screenshot-reader.png")), "a FAIL by budget captures its pages, which node:test's timeout races");
  assert.equal(readFileSync(marker, "utf8"), `refused: this case's body was abandoned (its budget of ${BUDGET_MS} ms ran out); no new users`, "the abandoned body makes no pool");

  const timedOut = by["timeout, a page lost the emulator, inconclusiveOnPageStall only"];
  assert.equal(timedOut?.status, "fail", "without the option node:test's own timeout FAILS, whatever the page saw");
  assert.equal(timedOut.error?.failureType, "testTimeoutFailure", JSON.stringify(timedOut.error));


  assert.deepEqual(outcome("done in time, a page lost the emulator, opted in"), ["pass", null]);
  assert.deepEqual(outcome("an assertion in time, a page lost the emulator, opted in"), ["fail", "ERR_ASSERTION"], "an assertion FAILS, whatever a page saw");
  assert.equal(records.length, 5, `one record per case: ${records.map((r) => r.name).join(" | ")}`);
});
