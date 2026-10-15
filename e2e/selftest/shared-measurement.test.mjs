// SPDX-License-Identifier: Apache-2.0
// Exercise independent accessibility judges and preserve failed setup evidence (SPEC §7, §12).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { fileBudget } from "../lib/budget.mjs";
import { sharedMeasurement } from "../lib/shared-measurement.mjs";

const ctx = () => ({ inconclusive(reason) { throw Object.assign(new Error(reason), { code: "E2E_INCONCLUSIVE" }); } });
const inconclusive = (err) => err.code === "E2E_INCONCLUSIVE";

test("a standalone judge measures once; later judges and the selected prerequisite reuse it", async () => {
  const contexts = [];
  const setup = sharedMeasurement("measure", {}, async (c) => { contexts.push(c); });
  const first = ctx();
  await setup.ensure(first);
  await setup.ensure(ctx());
  await setup.run(ctx());
  assert.deepEqual(contexts, [first]);
});

test("a selected prerequisite measures once before dependent judges", async () => {
  let runs = 0;
  const setup = sharedMeasurement("measure", {}, async () => { runs++; });
  await setup.run(ctx());
  await setup.ensure(ctx());
  assert.equal(runs, 1);
});

for (const first of ["run", "ensure"]) test(`${first}: a failed setup propagates its error and is never retried or treated as success`, async () => {
  let runs = 0;
  let populated = false;
  const error = new Error("assertion after the last measurement");
  const setup = sharedMeasurement("measure", {}, async () => { runs++; populated = true; throw error; });
  await assert.rejects(setup[first](ctx()), (err) => err === error);
  assert.equal(populated, true, "a complete data cache does not erase the later failure");
  await assert.rejects(setup.ensure(ctx()), (err) => inconclusive(err) && /earlier measurement failed.*assertion after/.test(err.message));
  assert.equal(runs, 1);
});

test("a still-running prerequisite is inconclusive without duplicate work", async () => {
  let finish;
  let runs = 0;
  const setup = sharedMeasurement("measure", {}, () => { runs++; return new Promise((resolve) => { finish = resolve; }); });
  const pending = setup.run(ctx());
  await assert.rejects(setup.ensure(ctx()), (err) => inconclusive(err) && /has not completed/.test(err.message));
  assert.equal(runs, 1);
  finish();
  await pending;
  await setup.ensure(ctx());
});

test("a late body cannot turn its already exhausted case budget into reusable success", async () => {
  const setup = sharedMeasurement("measure", {}, async () => undefined);
  await assert.rejects(setup.run({ ...ctx(), budgetEndsAt: Date.now() - 1 }), /after its case budget/);
  await assert.rejects(setup.ensure(ctx()), inconclusive);
});

// Evaluate actual declarations with only the measurement wrapper replaced. A
// sentinel stops each judge at setup entry, before any browser/admin operation.
// This tests the spec's wiring and option propagation, not a copied model.
function declarations() {
  const cases = new Map();
  const measured = [];
  const source = readFileSync(new URL("../specs/functional/a24-responsive-a11y.spec.mjs", import.meta.url), "utf8");
  runInNewContext(source.replace(/^import .*;\n/gm, ""), {
    currentTarget: () => null,
    after: () => undefined,
    scenario: (name, options, body) => cases.set(name.split(" ")[0], { name, options, body }),
    sharedMeasurement(name, options) {
      const marker = new Error(`measurement entered: ${name}`);
      const record = { name, options, marker, calls: 0 };
      measured.push(record);
      return { options, run: async () => undefined, ensure: async () => { record.calls++; throw marker; } };
    },
  });
  return { cases, measured };
}

for (const [judge, prerequisite] of [
  ["A24.1b", "A24.1"], ["A24.5c", "A24.1"], ["A24.2e2", "A24.2e"],
  ["A24.2f2", "A24.2f"], ["A24.2j", "A24.2h"], ["A24.3b", "A24.3a"],
]) test(`${judge} alone enters ${prerequisite} before judging its cache, with the setup's budget, tier and effects`, async () => {
  const { cases, measured } = declarations();
  const setup = measured.find((x) => x.name.startsWith(`${prerequisite} `));
  assert.ok(setup, "the prerequisite is a shared measurement");
  const selected = cases.get(judge);
  assert.equal(selected.options, cases.get(prerequisite).options, "the selected judge inherits every setup option");
  assert.ok(selected.options.timeoutMs >= 180_000 && selected.options.inconclusiveOnCaseTimeout);
  if (judge === "A24.2e2") assert.equal(selected.options.effects?.[0], "email:POST /access");
  await assert.rejects(selected.body(ctx()), (err) => err === setup.marker);
  assert.equal(setup.calls, 1);
});


test("A24 declares a file budget covering every case despite shared option objects", () => {
  const { cases } = declarations();
  const source = readFileSync(new URL("../specs/functional/a24-responsive-a11y.spec.mjs", import.meta.url), "utf8");
  const budget = fileBudget("e2e/specs/functional/a24-responsive-a11y.spec.mjs", { caseDefaultMs: 600_000, source });
  assert.ok(budget.declaredMs >= [...cases.values()].reduce((sum, c) => sum + c.options.timeoutMs, 0));
});
