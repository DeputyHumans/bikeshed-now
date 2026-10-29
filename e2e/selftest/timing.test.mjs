// SPDX-License-Identifier: Apache-2.0
// Phase diagnostics retain elapsed time and preserve operation results and failures (SPEC §12).
import { test } from "node:test";
import assert from "node:assert/strict";
import { timePhase } from "../lib/timing.mjs";

test("timing records the operation's complete duration and case identity", async () => {
  const rows = []; let clock = 10;
  const result = await timePhase("unused", "case-body", async () => { clock = 35; return 42; }, { now: () => clock, emit: row => rows.push(row), caseName: "example" });
  assert.equal(result, 42);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].durationMs, 25);
  assert.equal(rows[0].phase, "case-body");
  assert.equal(rows[0].caseName, "example");
  assert.equal(rows[0].outcome, "completed");
});

test("timing retains the original rejection even when diagnostic writing fails", async () => {
  const original = new Error("original");
  await assert.rejects(timePhase("unused", "cleanup", async () => { throw original; }, { emit: () => { throw new Error("disk full"); } }), err => err === original);
  const rows = [];
  await assert.rejects(timePhase("unused", "cleanup", async () => { throw original; }, { emit: row => rows.push(row) }), err => err === original);
  assert.equal(rows[0].outcome, "failed");
  assert.equal(await timePhase(null, "cleanup", async () => 7, { emit: () => assert.fail("disabled") }), 7);
});
