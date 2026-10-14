// SPDX-License-Identifier: Apache-2.0
// Self-test: a concurrency scenario runs the plan's K per N (10/5/3/3) by default, its own `trials` when it says, and --trials k (E2E_TRIALS) for every N; the file budget counts the same (SPEC §12).

import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { SPECS_DIR } from "../lib/paths.mjs";
import { PLAN_TRIALS, TRIALS_ENV, expand, isConcurrencySpec, scenarioTrials, trialsOverride, trialsPerN } from "../lib/test.mjs";
import { fileBudget, scanScenarios, tierTimeouts } from "../lib/budget.mjs";
import { readFileSync } from "node:fs";

const target = { kind: "local", runId: "selftest-trials", capabilities: new Set(["local"]) };
const saved = { trials: process.env[TRIALS_ENV], suite: process.env.E2E_SUITE, n: process.env.E2E_N };
afterEach(() => {
  for (const [k, env] of [["trials", TRIALS_ENV], ["suite", "E2E_SUITE"], ["n", "E2E_N"]]) {
    if (saved[k] === undefined) delete process.env[env];
    else process.env[env] = saved[k];
  }
});
const clear = () => {
  delete process.env[TRIALS_ENV];
  delete process.env.E2E_SUITE;
  delete process.env.E2E_N;
};
const perN = (cases) => Object.fromEntries([...new Set(cases.map((c) => c.n))].map((n) => [n, cases.filter((c) => c.n === n).length]));

test("the plan's K per N is 10/5/3/3", () => {
  assert.deepEqual(PLAN_TRIALS, { 2: 10, 5: 5, 10: 3, 20: 3 });
});

test("a concurrency scenario with n and no trials runs the plan's K per N; a functional one runs once", () => {
  clear();
  const conc = join(SPECS_DIR, "concurrency", "c01-typing.spec.mjs");
  const func = join(SPECS_DIR, "functional", "a11-live.spec.mjs");
  assert.equal(isConcurrencySpec(conc), true);
  assert.equal(isConcurrencySpec(func), false);
  assert.equal(scenarioTrials({ n: [2, 5, 10, 20] }, conc), "plan");
  assert.equal(scenarioTrials({ n: [2] }, func), 1);
  assert.equal(scenarioTrials({}, conc), 1, "no n: one case");
  assert.deepEqual(scenarioTrials({ n: [2], trials: { 2: 2 } }, conc), { 2: 2 }, "its own trials win");
  const cases = expand("C1 typing", { n: [2, 5, 10, 20], trials: scenarioTrials({ n: [2, 5, 10, 20] }, conc) }, target);
  assert.deepEqual(perN(cases), { 2: 10, 5: 5, 10: 3, 20: 3 });
  assert.equal(cases[0].name, "C1 typing [N=2] #1");
  assert.equal(cases.at(-1).name, "C1 typing [N=20] #3");
  assert.deepEqual(perN(expand("A11", { n: [2], trials: scenarioTrials({ n: [2] }, func) }, target)), { 2: 1 });
  assert.equal(expand("A11", { n: [2], trials: 1 }, target)[0].name, "A11 [N=2]", "one trial: no #k");
  assert.throws(() => scenarioTrials({ n: [2], trials: "lots" }, conc), TypeError);
});

test("--trials k (E2E_TRIALS) makes every scenario k trials per N, whatever it declares", () => {
  clear();
  process.env[TRIALS_ENV] = "2";
  assert.equal(trialsOverride(), 2);
  assert.deepEqual(perN(expand("C1", { n: [2, 5], trials: "plan" }, target)), { 2: 2, 5: 2 });
  assert.deepEqual(perN(expand("C1", { n: [2], trials: { 2: 7 } }, target)), { 2: 2 });
  process.env[TRIALS_ENV] = "1";
  const one = expand("C1", { n: [2, 5], trials: "plan" }, target);
  assert.deepEqual(one.map((c) => c.name), ["C1 [N=2]", "C1 [N=5]"]);
  assert.equal(trialsPerN("plan", 20, { override: null }), 3);
  process.env[TRIALS_ENV] = "0";
  assert.throws(() => trialsOverride(), TypeError, "NEGATIVE: zero trials is refused");
  process.env[TRIALS_ENV] = "x";
  assert.throws(() => trialsOverride(), TypeError);
});

test("--n still selects among the trials: the others are skipped with the reason", () => {
  clear();
  process.env.E2E_N = "5";
  const cases = expand("C1", { n: [2, 5], trials: "plan" }, target);
  assert.deepEqual(cases.filter((c) => !c.skip).map((c) => c.name), ["C1 [N=5] #1", "C1 [N=5] #2", "C1 [N=5] #3", "C1 [N=5] #4", "C1 [N=5] #5"]);
  assert.match(cases[0].skip, /N=2 not selected/);
});

test("the file budget counts the plan's trials in a concurrency spec, `\"plan\"`, and the --trials override", () => {
  const src = 'scenario("C1", { n: [2, 5, 10, 20], timeoutMs: 1000 }, async () => {});\nscenario("C2", { n: [2], trials: "plan", timeoutMs: 1000 }, async () => {});\n';
  assert.equal(scanScenarios(src, { caseDefaultMs: 1000 }).cases, 4 + 10, "outside the concurrency directory C1 runs once per N");
  const conc = fileBudget(join(SPECS_DIR, "concurrency", "x.spec.mjs"), { caseDefaultMs: 1000, source: src });
  assert.equal(conc.cases, 21 + 10);
  const over = fileBudget(join(SPECS_DIR, "concurrency", "x.spec.mjs"), { caseDefaultMs: 1000, source: src, trialsOverride: 2 });
  assert.equal(over.cases, 8 + 2);
});

test("a scratch spec run as the concurrency tier (--spec-file … --suite concurrency) is budgeted as scenario() runs it: one predicate in both", async () => {
  clear();
  const budgetMod = await import("../lib/budget.mjs");
  assert.equal(typeof budgetMod.isConcurrencySpec, "function", "budget.mjs owns the predicate");
  assert.equal(isConcurrencySpec, budgetMod.isConcurrencySpec, "test.mjs re-exports the same function");
  const scratch = join(SPECS_DIR, "..", "..", "..", "e2e-scratch-elsewhere", "c99-scratch.spec.mjs");
  const src = 'scenario("C99", { n: [2, 5, 10, 20], timeoutMs: 1000 }, async () => {});\n';
  const budget = (file, tier) => fileBudget(file, { caseDefaultMs: 1000, source: src, tier }).cases;
  assert.equal(budget(scratch, "concurrency"), 21, "run as the concurrency tier: the plan's 10/5/3/3");
  assert.equal(budget(scratch, "functional"), 4);
  assert.equal(tierTimeouts([scratch], { defaultMs: 1000, read: () => src, tier: "concurrency" }).files[0].cases, 21, "tierTimeouts passes the tier down");
  const opts = { n: [2, 5, 10, 20] };
  for (const [file, tier] of [[scratch, "concurrency"], [scratch, "functional"], [scratch, undefined], [join(SPECS_DIR, "concurrency", "c99.spec.mjs"), "concurrency"], [join(SPECS_DIR, "concurrency", "c99.spec.mjs"), undefined], [join(SPECS_DIR, "functional", "a99.spec.mjs"), "functional"]]) {
    const runtime = expand("C99", { ...opts, trials: scenarioTrials(opts, file, tier ? { E2E_SUITE: tier } : {}) }, target).length;
    assert.equal(budget(file, tier), runtime, `${file.split("/").slice(-2).join("/")} as ${tier ?? "no tier"}: the budget counts what runs`);
  }
});

test("run.mjs gives tierTimeouts the tier it runs (the budget then counts as the spec process does)", () => {
  const src = readFileSync(join(SPECS_DIR, "..", "run.mjs"), "utf8");
  const call = /p\.budget = tierTimeouts\(p\.files, \{([^}]*)\}\)/.exec(src);
  assert.ok(call, "run.mjs sizes each tier's budget with tierTimeouts(p.files, {…})");
  assert.match(call[1], /\btier: p\.tier\b/, "and passes the plan entry's tier");
});
