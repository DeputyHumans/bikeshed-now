// SPDX-License-Identifier: Apache-2.0
// Self-test: the concurrency tier's load gate waits for a quiet machine and says when it never got one (SPEC §12).

import { test } from "node:test";
import assert from "node:assert/strict";
import { sampleLoad, waitForLoad } from "../lib/load.mjs";

const seq = (...ones) => {
  let i = 0;
  return () => ({ at: "t", one: ones[Math.min(i++, ones.length - 1)], five: 0, fifteen: 0, cpus: 16 });
};

test("a real sample has the machine's numbers", () => {
  const s = sampleLoad();
  assert.ok(Number.isFinite(s.one) && s.cpus >= 1);
});

test("the gate opens at once below the threshold", async () => {
  const r = await waitForLoad({ max: 8, sample: seq(2), pollMs: 5 });
  assert.equal(r.ok, true);
  assert.equal(r.sample.one, 2);
});

test("NEGATIVE: the gate holds while the load is at or above the threshold, then opens", async () => {
  let waited = 0;
  const r = await waitForLoad({ max: 8, sample: seq(12, 8, 7.9), pollMs: 5, onWait: () => waited++ });
  assert.equal(r.ok, true);
  assert.equal(r.sample.one, 7.9, "8 itself is not below 8");
  assert.equal(waited, 1, "told once, not every poll");
});

test("NEGATIVE: a load that never falls reports ok:false instead of running anyway", async () => {
  const r = await waitForLoad({ max: 8, sample: seq(20), pollMs: 5, timeoutMs: 40 });
  assert.equal(r.ok, false);
  assert.equal(r.sample.one, 20);
  assert.ok(r.waitedMs >= 40);
});
