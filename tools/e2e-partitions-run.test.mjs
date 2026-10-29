// SPDX-License-Identifier: Apache-2.0
// Partition planning refuses stale source and filtered execution before any stack starts (SPEC §12).

import { test } from "node:test";
import assert from "node:assert/strict";
import { planPartitions } from "./e2e-partitions-run.mjs";

const source = { revision: "a".repeat(40), version: "0.20.4", fingerprint: "f".repeat(64) };
const fixture = () => ({ acceptance: { ...source, requirements: [{ id: "natural-n2", kind: "e2e-run", suite: "concurrency", n: 2, planTrials: true, command: "node e2e/run.mjs run --suite concurrency --storage-shim --rtdb-proxy --n 2 --tree worktree", proofs: [] }] } });
const inventory = ["first", "second"].map(name => ({ file: `e2e/specs/concurrency/${name}.spec.mjs`, sha256: "b".repeat(64), cases: [] }));

test("fresh-stack plan preserves the original axes and adds only one full-file selection", () => {
  const c = fixture(), plan = planPartitions(c, "natural-n2", source, inventory);
  assert.equal(plan.jobs.length, 2);
  for (const [i, job] of plan.jobs.entries()) assert.deepEqual(job.args, [...c.acceptance.requirements[0].command.split(" ").slice(1), "--spec", inventory[i].file]);
  assert.deepEqual(c, fixture(), "planning never writes campaign findings");
});
for (const field of ["revision", "version", "fingerprint"]) test(`NEGATIVE: stale ${field} cannot start a partition`, () => {
  assert.throws(() => planPartitions(fixture(), "natural-n2", { ...source, [field]: "stale" }, inventory), /source derivation: .*differs/);
});
for (const addition of [" --grep one", " --trials 1", " --attach old", " --keep", " --spec other", " --target prod", " ; echo bad"]) test(`NEGATIVE: partition command refuses ${addition.trim()}`, () => {
  const c = fixture(); c.acceptance.requirements[0].command += addition;
  assert.throws(() => planPartitions(c, "natural-n2", source, inventory), /filtered or unsafe/);
});
test("NEGATIVE: a filtered matrix cell cannot impersonate a complete suite", () => {
  const c = fixture(); c.acceptance.requirements[0].spec = "first.spec.mjs";
  assert.throws(() => planPartitions(c, "natural-n2", source, inventory), /complete natural concurrency cell/);
});
test("NEGATIVE: duplicate files cannot form a complete plan", () => {
  assert.throws(() => planPartitions(fixture(), "natural-n2", source, [inventory[0], inventory[0]]), /invalid file census/);
});
