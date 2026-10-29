// SPDX-License-Identifier: Apache-2.0
// Self-test: untilLanded's stopAt "budget" sends again only while one more send and its look end inside the case's budget (ctx.budgetEndsAt, set by caseBudget), so a stack that keeps not answering ends the case INCONCLUSIVE through it, never as the budget running out mid-look (SPEC §12).

/**
 * caseBudget's ctx.budgetEndsAt, then untilLanded against made-up calls in
 * this process, in real time on a small scale: a send is a sleep that then
 * fails as the http client's deadline does ("timeout after N ms"), and a
 * look is a read that finds nothing, or never answers at all. untilLanded
 * gives up 2 s (LANDED_BUDGET_SLACK_MS) before ctx.budgetEndsAt, so each
 * fake ctx's budget is that plus the room the case is meant to have. Last,
 * a generated fixture spec runs through `node --test` with the real
 * reporter: the case of A5.5 on the shared stack (a call never answered,
 * three sends and their looks longer than the budget) ends INCONCLUSIVE
 * with "budget", and FAILS as E2E_CASE_BUDGET mid-look without it.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { E2E_DIR, E2E_TMP, OUT_DIR, REPO_ROOT, ensureDir } from "../lib/paths.mjs";
import { createInvocation, nodeTestArgs } from "../lib/invocation.mjs";
import { createHttp } from "../lib/http.mjs";
import { publish } from "../lib/seed.mjs";
import { caseBudget, untilLanded } from "../lib/test.mjs";

const lib = (f) => pathToFileURL(join(E2E_DIR, "lib", f)).href;
const LEAD = "the stack did not answer, so nothing was measured: ";
/** untilLanded's LANDED_BUDGET_SLACK_MS: it is over this long before the budget would run out. */
const SLACK_MS = 2_000;
const runId = `selftest-landed-budget-${process.pid}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** A ctx with what untilLanded reads: its steps, its evidence's text files, and a budget that runs out `roomMs` + SLACK_MS from now. */
function budgetCtx(roomMs) {
  const steps = [];
  const texts = [];
  return { steps, texts, step: (t) => steps.push(t), ev: { text: (name, value) => texts.push([name, value]) }, budgetEndsAt: Date.now() + SLACK_MS + roomMs };
}
/** A send the stack never answers: `ms` of nothing, then the http client's own deadline. Counts its sends. */
function unansweredSend(ms) {
  const send = async () => {
    send.count += 1;
    await sleep(ms);
    throw new Error(`timeout after ${ms} ms`);
  };
  send.count = 0;
  return send;
}

test("caseBudget sets ctx.budgetEndsAt as the body starts; a budget already set that ends sooner wins; a frozen ctx keeps none and the body still runs", async () => {
  const ctx = {};
  const t0 = Date.now();
  let seen = null;
  await caseBudget(async (c) => {
    seen = c.budgetEndsAt;
  }, 800)(ctx); // a quarter kept back: a budget of 600 ms
  assert.equal(typeof seen, "number");
  assert.ok(seen >= t0 + 600 && seen <= Date.now() + 600, `budgetEndsAt ${seen - t0} ms after the start, not 600`);

  const outer = {};
  let inner = null;
  const t1 = Date.now();
  await caseBudget((c) => caseBudget(async (c2) => {
    inner = c2.budgetEndsAt;
  }, 40_000)(c), 800)(outer);
  assert.ok(inner >= t1 + 600 && inner < t1 + 1_000, `the outer budget (600 ms) ends sooner than the inner (30 s), so it stands: ${inner - t1}`);

  const frozen = Object.freeze({});
  assert.equal(await caseBudget(async (c) => c.budgetEndsAt ?? "none", 400)(frozen), "none");
});

test("stopAt \"budget\": sent again only while one more send and its look end inside the budget; INCONCLUSIVE before the budget runs out, saying why", async () => {
  // 1 500 ms per attempt (a 300 ms send, a 1 200 ms look) in 3 600 ms of room: the second fits, a third would not.
  const ctx = budgetCtx(3_600);
  const send = unansweredSend(300);
  let reads = 0;
  const err = await untilLanded(ctx, "POST /publish d9", send, async () => {
    reads += 1;
    return null;
  }, { attempts: 5, lookupMs: 1_200, intervalMs: 50, stopAt: "budget" }).then(() => null, (e) => e);
  const endedAt = Date.now();
  assert.equal(err?.code, "E2E_INCONCLUSIVE", String(err?.stack ?? err));
  assert.equal(send.count, 2, "sent twice: a third send and its look would have ended past the budget");
  assert.ok(endedAt < ctx.budgetEndsAt - SLACK_MS, `over ${ctx.budgetEndsAt - endedAt} ms before the budget, inside its slack`);
  assert.match(err.reason, new RegExp(`^${LEAD}POST /publish d9 got no answer 2 time\\(s\\) \\(the last: a request to the stack got no answer: timeout after 300 ms\\), and it had not taken effect 1200 ms after each; it was not sent again: one more send and its look, about 1[5-9]\\d\\d ms, would not end within the case's budget \\(\\d+ ms left\\)$`));
  assert.ok(reads > 2, "it looked after each send");
  assert.equal(err.cause.message, "timeout after 300 ms", "the last failure is the cause");
  assert.deepEqual(ctx.texts.map(([n]) => n), ["stack-did-not-answer.txt"]);
  assert.match(ctx.steps.join("\n"), /sending it again \(attempt 2 of 5\)/);
});

test("NEGATIVE: the same call with stopAt the budget's own time (a number, as before) is checked only after each look, so it runs on past the budget", async () => {
  const ctx = budgetCtx(3_600);
  const send = unansweredSend(300);
  const err = await untilLanded(ctx, "POST /publish d9", send, async () => null, { attempts: 5, lookupMs: 1_200, intervalMs: 50, stopAt: ctx.budgetEndsAt }).then(() => null, (e) => e);
  assert.equal(err?.code, "E2E_INCONCLUSIVE");
  assert.ok(Date.now() > ctx.budgetEndsAt, "it ended after the budget would have run out: the case would have FAILED as E2E_CASE_BUDGET mid-look");
  assert.ok(send.count >= 4, `sent ${send.count} times`);
});

test("stopAt \"budget\": the look is cut to end inside the budget, each read raced, so a read the stack never answers cannot hold it", { timeout: 15_000 }, async (t) => {
  const realNow = Date.now.bind(Date);
  let now = realNow();
  let readStartedAt = null;
  t.mock.method(Date, "now", () => readStartedAt === null ? now : now + realNow() - readStartedAt);
  const ctx = budgetCtx(1_500);
  const send = async () => {
    send.count += 1;
    now += 99; // A requested 100 ms timer can be observed as 99 ms.
    throw new Error("timeout after 100 ms");
  };
  send.count = 0;
  const t0 = Date.now();
  const err = await untilLanded(ctx, "POST /trust d8", send, () => {
    readStartedAt = realNow(); // Resume real elapsed time for the unanswered read.
    return new Promise(() => {});
  }, { lookupMs: 60_000, intervalMs: 50, stopAt: "budget" }).then(() => null, (e) => e);
  const took = Date.now() - t0;
  assert.equal(err?.code, "E2E_INCONCLUSIVE", String(err?.stack ?? err));
  assert.ok(took >= 1_400 && took < 1_500 + SLACK_MS, `ended ${took} ms in: at the cut look's end, before the budget`);
  assert.equal(send.count, 1);
  assert.match(err.reason, new RegExp(`^${LEAD}POST /trust d8 got no answer 1 time\\(s\\) \\(the last: a request to the stack got no answer: timeout after 100 ms\\), and it had not taken effect 1[34]\\d\\d ms after it, all the case's budget left \\(the last look: the read had not answered when the look's time ran out\\); it was not sent again: one more send and its look, about 60099 ms, would not end within the case's budget \\(\\d+ ms left\\)$`));
  assert.match(ctx.steps[0], /; looking for its effect for up to 1[34]\d\d ms, all the case's budget leaves \(attempt 1 of 3\)$/);
});

test("stopAt \"budget\": an effect found in a cut look is taken", async () => {
  const ctx = budgetCtx(1_500);
  const send = unansweredSend(100);
  let reads = 0;
  const r = await untilLanded(ctx, "POST /trust d7", send, async () => (++reads >= 3 ? { trusted: true } : null), { lookupMs: 60_000, intervalMs: 50, stopAt: "budget" });
  assert.deepEqual([r.out, r.landed, r.attempts, send.count], [null, { trusted: true }, 1, 1]);
});

test("stopAt \"budget\": a failure with no time left is not looked after at all, and ends it at once", { timeout: 15_000 }, async (t) => {
  // A requested 400 ms timer may be observed as 399 ms by the wall clock.
  // Bind the retry estimate to that observed interval, independently of scheduling.
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const ctx = budgetCtx(200);
  const send = async () => {
    send.count += 1;
    now += 399;
    throw new Error("timeout after 400 ms");
  };
  send.count = 0;
  let reads = 0;
  const err = await untilLanded(ctx, "POST /access d6", send, async () => {
    reads += 1;
    return null;
  }, { lookupMs: 60_000, stopAt: "budget" }).then(() => null, (e) => e);
  assert.equal(err?.code, "E2E_INCONCLUSIVE");
  assert.deepEqual([send.count, reads], [1, 0]);
  assert.equal(err.reason, `${LEAD}POST /access d6 got no answer 1 time(s) (the last: a request to the stack got no answer: timeout after 400 ms), and no time was left in the case's budget to look for its effect; it was not sent again: one more send and its look, about 60399 ms, would not end within the case's budget (0 ms left)`);
  assert.match(ctx.steps[0], /; no time is left in the case's budget to look for its effect \(attempt 1 of 3\)$/);
});

test("stopAt \"budget\" with effect null: the back-off is what follows the send", async () => {
  // 1 000 ms per attempt (a 600 ms back-off, a 400 ms send) in 2 000 ms of room: the second fits, a third would not.
  const ctx = budgetCtx(2_000);
  const send = unansweredSend(400);
  const err = await untilLanded(ctx, "POST /session", send, null, { attempts: 5, backoffMs: 600, stopAt: "budget" }).then(() => null, (e) => e);
  assert.equal(err?.code, "E2E_INCONCLUSIVE");
  assert.equal(send.count, 2);
  assert.match(err.reason, /POST \/session got no answer 2 time\(s\) \(the last: a request to the stack got no answer: timeout after 400 ms\); it was not sent again: one more send after its back-off, about 10\d\d ms, would not end within the case's budget \(\d+ ms left\)$/);
});

test("stopAt \"budget\": with room to spare, attempts still bounds it, in the words it always used", async () => {
  const ctx = budgetCtx(60_000);
  const send = unansweredSend(20);
  const err = await untilLanded(ctx, "POST /x", send, async () => null, { attempts: 2, lookupMs: 100, intervalMs: 20, stopAt: "budget" }).then(() => null, (e) => e);
  assert.equal(send.count, 2);
  assert.equal(err.reason, `${LEAD}POST /x got no answer 2 time(s) (the last: a request to the stack got no answer: timeout after 20 ms), and it had not taken effect 100 ms after each`);
  let n = 0;
  const ok = await untilLanded(budgetCtx(60_000), "POST /y", async () => (++n === 1 ? Promise.reject(new Error("timeout after 5 ms")) : { status: 200 }), null, { backoffMs: 0, stopAt: "budget" });
  assert.deepEqual([ok.out, ok.attempts], [{ status: 200 }, 2], "an answer is returned as it always was");
});

test("stopAt \"budget\" is refused, before anything is sent, on a ctx without a budget; so is any other string", async () => {
  const send = async () => assert.fail("never sent");
  await assert.rejects(untilLanded({}, "x", send, null, { stopAt: "budget" }), (e) => e instanceof TypeError && /^untilLanded: stopAt "budget" reads the case's budget from ctx\.budgetEndsAt, which caseBudget sets \(scenario's inconclusiveOnCaseTimeout: true, or a body wrapped in caseBudget\); this ctx has none \(got undefined\)$/.test(e.message));
  await assert.rejects(untilLanded({ budgetEndsAt: null }, "x", send, null, { stopAt: "budget" }), /this ctx has none \(got null\)/);
  await assert.rejects(untilLanded({ budgetEndsAt: "soon" }, "x", send, null, { stopAt: "budget" }), /this ctx has none \(got "soon"\)/);
  await assert.rejects(untilLanded({ budgetEndsAt: Date.now() + 9e5 }, "x", send, null, { stopAt: "Budget" }), (e) => e instanceof TypeError && /stopAt is a Date\.now\(\) time or null, or "budget" for the case's own budget, got "Budget"/.test(e.message));
  // publish's patient passes it through to untilLanded, which refuses it the same way, before anything is sent
  const target = { kind: "local", runId, origin: "http://127.0.0.1:9", projectId: "demo-bikeshed", capabilities: ["local"], stack: { ports: { hosting: 9 } } };
  const http = createHttp(target, { actor: "owner", evidence: false, timeoutMs: 400 });
  const admin = { readDoc: async () => assert.fail("never read"), rtdbGet: async () => assert.fail("never read") };
  await assert.rejects(publish(http, { body: "<p>x</p>", id: "e2e-budget-none", patient: { ctx: {}, stopAt: "budget" }, admin }), (e) => e instanceof TypeError && /^untilLanded: stopAt "budget" reads the case's budget/.test(e.message));
});

// --- Through node --test and the reporter --------------------------------------

/** 16 s less a quarter kept back: a budget of 12 s, of which untilLanded may use 10. */
const TIMEOUT_MS = 16_000;

const FIXTURE = `// fixture spec, generated by selftest/until-landed-budget.test.mjs
import assert from "node:assert/strict";
import { scenario, untilLanded } from ${JSON.stringify(lib("test.mjs"))};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// POST /publish as the shared stack answered A5.5's: never. A send, then a 3.5 s look, three times: longer than the budget.
const send = async () => { await sleep(1000); throw new Error("timeout after 1000 ms"); };
const nothing = async () => null;
scenario("budget: never answered, stopAt budget", { timeoutMs: ${TIMEOUT_MS}, inconclusiveOnCaseTimeout: true }, async (ctx) => {
  await untilLanded(ctx, "POST /publish fx-budget", send, nothing, { lookupMs: 3500, intervalMs: 100, stopAt: "budget" });
});
scenario("budget: never answered, no stopAt", { timeoutMs: ${TIMEOUT_MS}, inconclusiveOnCaseTimeout: true }, async (ctx) => {
  await untilLanded(ctx, "POST /publish fx-none", send, nothing, { lookupMs: 3500, intervalMs: 100 });
});
scenario("budgetEndsAt in a budgeted case", { timeoutMs: 8000, inconclusiveOnCaseTimeout: true }, async (ctx) => {
  const left = ctx.budgetEndsAt - Date.now();
  assert.ok(left > 5000 && left <= 6000, "a budget of 6 s, just begun: " + left);
});
scenario("budgetEndsAt in a case without one", { timeoutMs: 8000 }, async (ctx) => {
  assert.equal(ctx.budgetEndsAt, null);
});
`;

let tmp;
let runDir;
before(() => {
  tmp = mkdtempSync(join(ensureDir(E2E_TMP, "E2E_TMP"), "selftest-landed-budget-"));
  runDir = join(OUT_DIR, runId);
  mkdirSync(runDir, { recursive: true });
});
after(() => {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(runDir, { recursive: true, force: true });
});

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

test("through node --test and the reporter: a call the stack never answers ends the case INCONCLUSIVE through untilLanded with stopAt \"budget\"; without it the budget runs out mid-look and the case FAILS; ctx.budgetEndsAt is the budget's end, or null", async () => {
  const target = { kind: "local", runId, runDir, origin: "http://127.0.0.1:9", projectId: "demo-bikeshed", capabilities: ["local"], stack: { ports: { hosting: 9 } } };
  const targetFile = join(tmp, "target.json");
  writeFileSync(targetFile, JSON.stringify(target));
  const spec = join(tmp, "budget.spec.mjs");
  writeFileSync(spec, FIXTURE);
  const inv = createInvocation(runDir, { runId, suite: "functional", plan: [{ tier: "functional", files: [spec] }], grep: null, n: null });
  const resultsFile = join(inv.dir, "results-functional.jsonl");
  const env = { ...process.env, E2E_TARGET: targetFile, E2E_RUN_ID: runId, E2E_SUITE: "functional", E2E_INVOCATION_DIR: inv.dir };
  delete env.NODE_TEST_CONTEXT; // a nested node --test that inherits it streams to its parent and ignores reporters
  delete env.E2E_N;
  delete env.E2E_TRACE;
  delete env.E2E_CASE_TIMEOUT_MS;
  delete env.E2E_EVIDENCE;
  const proc = await runAsync(process.execPath, nodeTestArgs({ files: [spec], resultsFile, reporter: join(E2E_DIR, "lib", "reporter.mjs") }), { cwd: REPO_ROOT, timeout: 120_000, env });
  assert.notEqual(proc.status, null, `node --test hung and was killed (stdout tail: ${proc.stdout.slice(-800)})`);
  const by = Object.fromEntries(readFileSync(resultsFile, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((r) => r.file === spec).map((r) => [r.name, r]));

  const stopped = by["budget: never answered, stopAt budget"];
  assert.equal(stopped?.status, "inconclusive", `${JSON.stringify(stopped?.error ?? stopped)}\n${proc.stdout.slice(-1500)}`);
  assert.match(stopped.inconclusive, new RegExp(`^${LEAD}POST /publish fx-budget got no answer 2 time\\(s\\) \\(the last: a request to the stack got no answer: timeout after 1000 ms\\), and it had not taken effect 3500 ms after each; it was not sent again: one more send and its look, about 45\\d\\d ms, would not end within the case's budget \\(\\d+ ms left\\)$`));
  const steps = readFileSync(join(REPO_ROOT, stopped.evidenceDir, "steps.md"), "utf8");
  assert.doesNotMatch(steps, /the case's budget of \d+ ms ran out/, "the budget never ran out: untilLanded ended the case first");

  const ranOut = by["budget: never answered, no stopAt"];
  assert.equal(ranOut?.status, "fail", "NEGATIVE: without it, the third look runs past the budget");
  assert.equal(ranOut.error?.code, "E2E_CASE_BUDGET", JSON.stringify(ranOut.error));

  assert.equal(by["budgetEndsAt in a budgeted case"]?.status, "pass", JSON.stringify(by["budgetEndsAt in a budgeted case"]?.error));
  assert.equal(by["budgetEndsAt in a case without one"]?.status, "pass", JSON.stringify(by["budgetEndsAt in a case without one"]?.error));
});
