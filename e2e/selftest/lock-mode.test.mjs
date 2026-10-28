// SPDX-License-Identifier: Apache-2.0
// Self-test: the tier lock a run takes — an authoring concurrency run (every N <= 2, trials <= 2) shares, any other is alone — and that the run records it (SPEC §12).

/**
 * tierLockMode is pure, so most of this is a table. The rest pins how
 * run.mjs uses it (read from its source: the lock it acquires is the one
 * tierLockMode chose from the run's own --n and --trials, and the load gate
 * still applies to every concurrency run), and that what run.mjs records
 * (invocation.json `locks`) reaches results.json, summary.md and merged.md,
 * written through createInvocation and the report functions run.mjs calls.
 * No stack, no browser.
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { E2E_DIR, OUT_DIR, ensureDir } from "../lib/paths.mjs";
import { AUTHORING_MAX_N, AUTHORING_MAX_TRIALS, TIER_MODE, tierLockMode } from "../lib/locks.mjs";
import { mergeInvocations, mergeRun, tierLocksLine } from "../lib/report.mjs";
import { createInvocation } from "../lib/invocation.mjs";
import { blankSource } from "../lib/budget.mjs";

const RUN_MJS = join(E2E_DIR, "run.mjs");

test("the authoring limits are N <= 2 and trials <= 2, and the concurrency tier's base mode is still exclusive", () => {
  assert.equal(AUTHORING_MAX_N, 2);
  assert.equal(AUTHORING_MAX_TRIALS, 2);
  assert.equal(TIER_MODE.concurrency, "exclusive");
  assert.equal(TIER_MODE.functional, "shared");
  assert.equal(TIER_MODE.smoke, "shared");
});

test("an AUTHORING concurrency run — every selected N at most 2 and at most 2 trials — takes the SHARED lock", () => {
  for (const [n, trials] of [[[2], 2], [[2], 1], [[1], 1], [[1, 2], 2], [[2, 1], 1], [[2, 2], 2]]) {
    const l = tierLockMode("concurrency", { n, trials });
    assert.equal(l.mode, "shared", `--n ${n.join(",")} --trials ${trials}: ${l.reason}`);
    assert.equal(l.authoring, true);
    assert.equal(l.tier, "concurrency");
    assert.match(l.reason, new RegExp(`^authoring run: --n ${n.join(",")} --trials ${trials}\\b`));
  }
});

test("NEGATIVE: every other concurrency run is EXCLUSIVE, and its reason names what made it a measurement run", () => {
  const rows = [
    [{ n: [5], trials: 1 }, /--n 5 selects N=5, not from 1 to 2/],
    [{ n: [3], trials: 1 }, /selects N=3/],
    [{ n: [2, 5], trials: 1 }, /--n 2,5 selects N=5,/],
    [{ n: [20], trials: 2 }, /selects N=20/],
    [{ n: [2, 5, 10, 20], trials: 1 }, /selects N=5,10,20/],
    [{ n: null, trials: 1 }, /no --n: every N the specs declare/],
    [{ trials: 2 }, /no --n/],
    [{ n: [2], trials: null }, /no --trials: each scenario's own trials, the plan's 10\/5\/3\/3/],
    [{ n: [2] }, /no --trials/],
    [{ n: [2], trials: 3 }, /--trials 3, not from 1 to 2/],
    [{ n: [1], trials: 10 }, /--trials 10/],
    [{ n: null, trials: null }, /no --n: .*; no --trials: /],
    [{}, /no --n: .*; no --trials: /],
    [undefined, /no --n: .*; no --trials: /],
    [{ n: [5], trials: 3 }, /selects N=5, .*; --trials 3,/],
    [{ n: [], trials: 1 }, /--n selects no N/],
    [{ n: [0], trials: 1 }, /selects N=0/],
    [{ n: [Number.NaN], trials: 1 }, /selects N=NaN/],
    [{ n: [1.5], trials: 1 }, /selects N=1.5/],
    [{ n: "2", trials: 1 }, /--n selects no N/],
    [{ n: [2], trials: 0 }, /--trials 0,/],
    [{ n: [2], trials: 1.5 }, /--trials 1.5,/],
  ];
  for (const [sel, why] of rows) {
    const l = tierLockMode("concurrency", sel);
    assert.equal(l.mode, "exclusive", `${JSON.stringify(sel)} must be exclusive: ${l.reason}`);
    assert.equal(l.authoring, false);
    assert.match(l.reason, /^measurement run: /);
    assert.match(l.reason, why);
  }
});

test("smoke and functional share whatever the selection; an unknown tier throws", () => {
  for (const tier of ["smoke", "functional"]) {
    for (const sel of [{}, { n: [20], trials: 10 }, { n: [2], trials: 2 }]) {
      const l = tierLockMode(tier, sel);
      assert.deepEqual([l.tier, l.mode, l.authoring], [tier, "shared", false]);
    }
  }
  for (const bad of ["prod", "", undefined, "toString", "__proto__"]) assert.throws(() => tierLockMode(bad, { n: [2], trials: 2 }), /tierLockMode: unknown tier/);
});

test("run.mjs takes each tier's lock as tierLockMode chose it from the run's own --n and --trials, records it, and gates every concurrency run on load", () => {
  const src = readFileSync(RUN_MJS, "utf8");
  const code = blankSource(src); // comments and string contents blanked: only code matches
  assert.doesNotMatch(code, /\bTIER_MODE\b/, "no tier's lock is read from TIER_MODE directly");
  assert.equal([...code.matchAll(/\bacquireTierLock\s*\(/g)].length, 2, "the suite runner and the self-test runner each take a tier lock");
  assert.match(code, /\bacquireTierLock\s*\(\s*tierLock\.mode\s*,/, "the lock taken is the one tierLockMode chose");
  assert.match(code, /\.tierLock\s*=\s*tierLockMode\s*\(\s*p\.tier\s*,\s*selection\s*\)/, "chosen per tier of the plan, from the run's selection");
  assert.match(code, /const selection\s*=\s*\{\s*n:\s*values\.n\s*\?\s*values\.n\.split\(/, "--n as numbers");
  assert.match(code, /trials:\s*values\.trials\s*\?\s*Number\(values\.trials\)\s*:\s*null\s*\}/, "--trials as a number, null when absent");
  assert.match(code, /env\.E2E_N\s*=\s*values\.n\b/, "the spec process selects by the same --n");
  assert.match(code, /env\.E2E_TRIALS\s*=\s*values\.trials\b/, "and runs the same --trials");
  assert.match(code, /locks\[tier\]\s*=\s*\{\s*\.\.\.tierLock\s*,\s*acquiredAt:/, "the lock taken is recorded");
  assert.match(code, /updateInvocationMeta\(\s*inv\.dir\s*,\s*\{\s*locks\s*(?:,|\})/, "into invocation.json");
  assert.doesNotMatch(code, /\.authoring\b|mode\s*===|===\s*mode\b/, "nothing else depends on the mode: the gates apply whatever it is");
  assert.match(src, /if \(tier === "concurrency"\) \{\s*const max = Number\(values\["max-load"\] \?\? DEFAULT_MAX_LOAD\);\s*const gate = await waitForLoad\(/, "the load gate applies to every concurrency run, shared or exclusive");
});

const runId = `selftest-lockmode-${process.pid}`;
const runDir = join(OUT_DIR, runId);
after(() => rmSync(runDir, { recursive: true, force: true }));

/** One invocation the way run.mjs writes it: createInvocation with `locks`, the lock taken, one concurrency record. */
function invocation(sel, { taken = true } = {}) {
  const lock = tierLockMode("concurrency", sel);
  const locks = { concurrency: taken ? { ...lock, acquiredAt: new Date().toISOString(), waitedMs: 0 } : lock };
  const inv = createInvocation(runDir, { runId, suite: "concurrency", plan: [{ tier: "concurrency", files: ["e2e/specs/concurrency/canary.spec.mjs"] }], spec: [], grep: null, n: sel.n ?? null, trials: sel.trials ?? null, locks });
  const name = `canary [N=2]${inv.id}`;
  writeFileSync(join(inv.dir, "results-concurrency.jsonl"), JSON.stringify({ id: `e2e/specs/concurrency/canary.spec.mjs::${name}`, file: "e2e/specs/concurrency/canary.spec.mjs", name, path: [name], suite: "concurrency", runId, status: "pass", at: new Date().toISOString() }) + "\n");
  return inv;
}

test("the lock mode is in results.json, summary.md and merged.md: an authoring run reads SHARED, a measurement run EXCLUSIVE", () => {
  ensureDir(runDir);
  const authoring = invocation({ n: [2], trials: 2 });
  const measurement = invocation({ n: [2, 5, 10, 20], trials: null });
  const planDefault = invocation({ n: [2], trials: null });
  const never = invocation({ n: [5], trials: 1 }, { taken: false });

  const a = mergeRun(authoring.dir);
  assert.equal(a.results.invocation.locks.concurrency.mode, "shared");
  assert.equal(a.results.invocation.locks.concurrency.authoring, true);
  const aMd = readFileSync(join(authoring.dir, "summary.md"), "utf8");
  assert.match(aMd, /^Tier locks: concurrency SHARED \(authoring run: --n 2 --trials 2 /m);
  assert.match(aMd, /^Selection: suite concurrency · --n 2 · --trials 2$/m);

  for (const inv of [measurement, planDefault]) {
    const m = mergeRun(inv.dir);
    assert.equal(m.results.invocation.locks.concurrency.mode, "exclusive");
    const md = readFileSync(join(inv.dir, "summary.md"), "utf8");
    assert.match(md, /^Tier locks: concurrency EXCLUSIVE \(measurement run: [^\n]*no --trials: each scenario's own trials, the plan's 10\/5\/3\/3 by default\)$/m);
    assert.doesNotMatch(md, /SHARED/);
  }
  assert.match(readFileSync(join(measurement.dir, "summary.md"), "utf8"), /selects N=5,10,20/);

  mergeRun(never.dir);
  assert.match(readFileSync(join(never.dir, "summary.md"), "utf8"), /^Tier locks: concurrency EXCLUSIVE \(measurement run: --n 5 selects N=5, not from 1 to 2\), never taken$/m);

  const merged = mergeInvocations(runId);
  const rows = Object.fromEntries(merged.results.invocations.map((i) => [i.id, i]));
  assert.equal(rows[authoring.id]?.locks?.concurrency?.mode, "shared", "merged.json carries each invocation's locks");
  assert.equal(rows[measurement.id]?.locks?.concurrency?.mode, "exclusive");
  const mergedMd = readFileSync(join(runDir, "merged.md"), "utf8");
  const row = (id) => mergedMd.split("\n").find((l) => l.startsWith(`| ${id} |`)) ?? "";
  assert.match(row(authoring.id), /--n 2 · --trials 2 · Tier locks: concurrency SHARED \|/);
  assert.match(row(measurement.id), /--n 2,5,10,20 · Tier locks: concurrency EXCLUSIVE \|/);
  assert.match(row(planDefault.id), /--n 2 · Tier locks: concurrency EXCLUSIVE \|/);
});

test("tierLocksLine: every tier recorded, the concurrency reason unless brief, a long wait named, nothing for an older run", () => {
  const at = new Date().toISOString();
  const locks = {
    smoke: { ...tierLockMode("smoke"), acquiredAt: at, waitedMs: 10 },
    functional: { ...tierLockMode("functional"), acquiredAt: at, waitedMs: 0 },
    concurrency: { ...tierLockMode("concurrency", { n: [2, 5] }), acquiredAt: at, waitedMs: 61_400 },
  };
  assert.equal(tierLocksLine(locks), `Tier locks: smoke SHARED · functional SHARED · concurrency EXCLUSIVE (${locks.concurrency.reason}), after waiting 61 s`);
  assert.equal(tierLocksLine(locks, { brief: true }), "Tier locks: smoke SHARED · functional SHARED · concurrency EXCLUSIVE");
  for (const none of [undefined, null, {}, { concurrency: null }, { concurrency: { reason: "no mode" } }, "shared"]) assert.equal(tierLocksLine(none), null);
});
