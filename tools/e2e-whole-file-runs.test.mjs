// SPDX-License-Identifier: Apache-2.0
// Refuse partial, repeated, filtered, stale and nonpassing substitutes for three complete stability observations (SPEC §12).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { STABILITY_FILES, verifyWholeFileRuns } from "./e2e-whole-file-runs.mjs";
const write = (root, path, value) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), typeof value === "string" ? value : JSON.stringify(value)); };
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "whole-file-runs-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const acceptance = { revision: "a".repeat(40), version: "1", fingerprint: "f".repeat(64) }, item = "deep:a08-review:13", file = STABILITY_FILES[item];
  write(root, file, 'scenario("first", {}, () => {});\nscenario("second", {}, () => {});\n');
  const runs = [1, 2, 3].map(i => {
    const runId = `r${i}`, path = `e2e/.out/${runId}/invocations/i/results.json`, invocation = { id: "i", runId, suite: "functional", spec: ["a08-review.spec.mjs", "a11-live.spec.mjs"], grep: null, n: null, trials: null, capabilities: ["local"], plan: [{ tier: "functional", files: [file] }], startedAt: "2026-10-15T01:00:00Z" };
    const report = { runId, invocation, mergedAt: "2026-10-15T01:01:00Z", malformed: [], cases: ["first", "second"].map(name => ({ id: `${file}::${name}`, file, name, status: "pass" })) };
    const done = { ...invocation, endedAt: "2026-10-15T01:01:01Z", exit: 0, interrupted: null, stackDown: null };
    const stack = { fingerprint: { baseSha: acceptance.revision, sha256: acceptance.fingerprint }, expectVersion: acceptance.version, patches: [] };
    return { path, report, done, stack };
  });
  function flush() { for (const r of runs) { write(root, r.path, r.report); write(root, `${dirname(r.path)}/invocation.json`, r.done); write(root, `${dirname(r.path)}/results-final.jsonl`, r.report.cases.map(c => JSON.stringify(c)).join("\n") + "\n"); write(root, `e2e/.out/${r.report.runId}/stack.json`, r.stack); } }
  flush(); return { root, item, file, runs, campaign: { acceptance }, reports: runs.map(r => r.path), flush, verify() { return verifyWholeFileRuns(this.campaign, { item: this.item, reports: this.reports }, { root, snapshot: () => acceptance }); } };
}
test("three complete file runs retain distinct invocation and exact case evidence", t => { const f = fixture(t), proof = f.verify(); assert.equal(proof.runs.length, 3); assert.equal(proof.runs[0].cases.length, 2); assert.equal(proof.originalObligationUnchanged, true); });
for (const [name, change, error] of [
  ["missing run", f => f.reports.pop(), /three distinct/],
  ["duplicate path", f => { f.reports[2] = f.reports[1]; }, /three distinct/],
  ["duplicate identity", f => { f.runs[2].report.runId = f.runs[2].report.invocation.runId = f.runs[2].done.runId = "r2"; }, /duplicate completed/],
  ["grep", f => { f.runs[0].report.invocation.grep = f.runs[0].done.grep = "first"; }, /filtered/],
  ["missing scenario", f => { f.runs[0].report.cases.pop(); }, /omits or replaces/],
  ["wrong source", f => { f.runs[0].stack.fingerprint.sha256 = "e".repeat(64); }, /frozen clean/],
  ["mutant", f => { f.runs[0].stack.patches = ["controls-example"]; }, /frozen clean/],
  ["capability skip", f => { f.runs[0].report.cases[0].status = "skip"; }, /unqualified PASS/],
  ["hidden TODO", f => { f.runs[0].report.cases[0].todo = "not fixed"; }, /unqualified PASS/],
  ["interrupted", f => { f.runs[0].done.interrupted = "SIGINT"; }, /did not finish/],
  ["partial merge", f => { delete f.runs[0].done.endedAt; }, /successful end is absent/],
  ["new declaration", f => { write(f.root, f.file, 'scenario("first", {}, () => {});\nscenario("second", {}, () => {});\nscenario("third", {}, () => {});\n'); }, /omits or replaces/],
  ["dynamic declaration", f => { write(f.root, f.file, 'scenario(variableName, {}, () => {});\n'); }, /reviewed inventory/],
]) test(`whole-file stability rejects ${name}`, t => { const f = fixture(t); change(f); f.flush(); assert.throws(() => f.verify(), error); });


test("current source and any change during verification cannot borrow old stack identities", t => {
  const f = fixture(t), args = { item: f.item, reports: f.reports };
  assert.throws(() => verifyWholeFileRuns(f.campaign, args, { root: f.root, snapshot: () => ({ ...f.campaign.acceptance, fingerprint: "e".repeat(64) }) }), /current source differs/);
  let calls = 0;
  assert.throws(() => verifyWholeFileRuns(f.campaign, args, { root: f.root, snapshot: () => calls++ ? { ...f.campaign.acceptance, fingerprint: "e".repeat(64) } : f.campaign.acceptance }), /source changed/);
});
