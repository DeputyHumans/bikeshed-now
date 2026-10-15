// SPDX-License-Identifier: Apache-2.0
// Full-run completion rejects partial metadata, interrupted runs, missing planned files and ambiguous case identities (SPEC §12).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { verifyCompletedRun, verifyFinishedRun } from "./e2e-run-completion.mjs";

const base = () => {
  const file = "e2e/specs/concurrency/example.spec.mjs", name = "actual assertion [N=20] #3";
  const invocation = { id: "i", runId: "r", suite: "concurrency", spec: [], grep: null, n: [20], trials: null, capabilities: ["local"], plan: [{ tier: "concurrency", files: [file] }] };
  return { report: { runId: "r", invocation, mergedAt: "2026-10-15T01:01:00Z", cases: [{ file, name, id: `${file}::${name}`, n: 20, trial: 3, status: "pass" }] }, done: { ...structuredClone(invocation), startedAt: "2026-10-15T01:00:00Z", endedAt: "2026-10-15T01:01:01Z", exit: 0, interrupted: null, stackDown: null } };
};

function fixture(t, change = () => {}) {
  const dir = mkdtempSync(join(tmpdir(), "run-completion-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const f = base();
  writeFileSync(join(dir, "results-concurrency.jsonl"), f.report.cases.map(row => JSON.stringify(row)).join("\n") + "\n");
  change(f);
  writeFileSync(join(dir, "invocation.json"), JSON.stringify(f.done));
  return { ...f, path: join(dir, "results.json") };
}

test("a completed invocation binds a full report to its planned files", t => {
  const f = fixture(t);
  assert.deepEqual(verifyCompletedRun(f.report, f.path), f.done);
});

for (const [name, change, message] of [
  ["selection", f => { f.done.suite = "functional"; }, /suite differs/],
  ["run identity", f => { f.done.runId = f.report.invocation.runId = "another"; }, /run identity differs/],
  ["missing end", f => { delete f.done.endedAt; }, /successful end is absent/],
  ["end before start", f => { f.done.endedAt = "2026-10-15T00:59:30Z"; }, /precedes its start/],
  ["nonzero exit", f => { f.done.exit = 1; }, /did not finish successfully/],
  ["interrupted", f => { f.done.interrupted = "SIGINT"; }, /did not finish successfully/],
  ["stack failure", f => { f.done.stackDown = "emulator heap exhausted"; }, /did not finish successfully/],
  ["duplicate case", f => { f.report.cases.push({ ...f.report.cases[0] }); }, /duplicate case identities/],
  ["inconsistent case", f => { f.report.cases[0].name = "another"; }, /case identity differs/],
  ["duplicate plan", f => { f.done.plan[0].files.push(f.done.plan[0].files[0]); f.report.invocation.plan = structuredClone(f.done.plan); }, /planned files are absent or duplicated/],
  ["missing planned file", f => { f.done.plan[0].files.push("e2e/specs/concurrency/unrun.spec.mjs"); f.report.invocation.plan = structuredClone(f.done.plan); }, /exactly its planned files/],
]) test(`completion refuses ${name}`, t => {
  const f = fixture(t, change);
  assert.throws(() => verifyCompletedRun(f.report, f.path), message);
});

for (const [name, alter] of [
  ["an early merged subset", rows => [...rows, { ...rows[0], name: "later assertion [N=20] #3", id: `${rows[0].file}::later assertion [N=20] #3` }]],
  ["a changed final outcome", rows => [{ ...rows[0], status: "fail", error: "final assertion failed" }]],
]) test(`completion refuses ${name} against final reporter records`, t => {
  const f = fixture(t);
  writeFileSync(join(dirname(f.path), "results-concurrency.jsonl"), alter(f.report.cases).map(row => JSON.stringify(row)).join("\n") + "\n");
  assert.throws(() => verifyCompletedRun(f.report, f.path), /final reporter records differ/);
});
test("completion refuses missing and malformed final reporter records", t => {
  const f = fixture(t), raw = join(dirname(f.path), "results-concurrency.jsonl");
  rmSync(raw);
  assert.throws(() => verifyCompletedRun(f.report, f.path), /final reporter records are absent or malformed/);
  writeFileSync(raw, "{incomplete JSON\n");
  assert.throws(() => verifyCompletedRun(f.report, f.path), /final reporter records are absent or malformed/);
});

test("a later explicit re-merge remains bound to the completed final records", t => {
  const f = fixture(t, f => { f.report.mergedAt = "2026-10-15T02:00:00Z"; });
  assert.deepEqual(verifyCompletedRun(f.report, f.path), f.done);
});


test("exit three requires explicit qualified-incomplete binding and still rejects interruption", t => {
  const f = fixture(t, f => { f.done.exit = 3; });
  assert.throws(() => verifyCompletedRun(f.report, f.path), /did not finish successfully/);
  assert.deepEqual(verifyFinishedRun(f.report, f.path, { expectedExit: 3 }), f.done);
  assert.throws(() => verifyFinishedRun(f.report, f.path, { expectedExit: 1 }), /only successful or explicitly incomplete/);
  f.done.interrupted = "SIGINT"; writeFileSync(join(dirname(f.path), "invocation.json"), JSON.stringify(f.done));
  assert.throws(() => verifyFinishedRun(f.report, f.path, { expectedExit: 3 }), /did not finish successfully/);
});

test("final reporter duplicates cannot disappear through the merge's id deduplication", t => {
  const f = fixture(t), raw = join(dirname(f.path), "results-concurrency.jsonl");
  for (const duplicate of [f.report.cases[0], { ...f.report.cases[0], n: 2 }, { ...f.report.cases[0], status: "fail", error: "earlier failure" }]) {
    writeFileSync(raw, [duplicate, f.report.cases[0]].map(row => JSON.stringify(row)).join("\n") + "\n");
    assert.throws(() => verifyCompletedRun(f.report, f.path), /duplicate case identities/);
  }
});
