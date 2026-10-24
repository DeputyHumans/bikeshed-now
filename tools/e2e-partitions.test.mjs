// SPDX-License-Identifier: Apache-2.0
// Partition evidence controls reject lost files, cases, trials, capabilities and source identities (SPEC §12).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { verifyPartitions, partitionDigest, partitionCellDigest } from "./e2e-partitions.mjs";

const write = (root, path, value) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), typeof value === "string" ? value : JSON.stringify(value)); };
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "e2e-partitions-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = { revision: "a".repeat(40), version: "0.20.4", fingerprint: "f".repeat(64) };
  const campaign = { acceptance: source };
  const cell = { id: "concurrency-natural-n2", kind: "e2e-run", suite: "concurrency", n: 2, planTrials: true, capabilities: ["local", "storage-preconditions"], options: { patches: [] }, proofs: [] };
  const inventory = ["first", "second"].map(name => {
    const file = `e2e/specs/concurrency/${name}.spec.mjs`;
    return { file, sha256: partitionDigest(name), cases: [1, 2].map(trial => ({ id: `${file}::${name} [N=2] #${trial}`, n: 2, trial })) };
  });
  const manifest = { schemaVersion: 1, kind: "concurrency-partitions", cell: cell.id, source, requirementSha256: partitionCellDigest(cell), inventory: structuredClone(inventory), reports: [] };
  for (const [i, expected] of inventory.entries()) {
    const runId = `partition-${i}`, artifact = `e2e/.out/${runId}/invocations/i/results.json`;
    const invocation = { id: "i", runId, suite: "concurrency", spec: [expected.file], grep: null, n: [2], trials: null, capabilities: [...cell.capabilities], plan: [{ tier: "concurrency", files: [expected.file] }], startedAt: "2026-10-24T01:00:00Z" };
    const report = { runId, invocation, mergedAt: "2026-10-24T01:01:00Z", malformed: [], cases: expected.cases.map(c => ({ ...c, file: expected.file, name: c.id.split("::")[1], status: "pass" })) };
    write(root, artifact, report);
    write(root, `${dirname(artifact)}/invocation.json`, { ...invocation, endedAt: "2026-10-24T01:01:01Z", exit: 0, interrupted: null, stackDown: null });
    write(root, `${dirname(artifact)}/results-concurrency.jsonl`, report.cases.map(c => JSON.stringify(c)).join("\n") + "\n");
    write(root, `e2e/.out/${runId}/stack.json`, { fingerprint: { baseSha: source.revision, sha256: source.fingerprint }, expectVersion: source.version, patches: [] });
    manifest.reports.push({ artifact, sha256: partitionDigest(readFileSync(join(root, artifact))) });
  }
  const f = { root, campaign, cell, manifest, inventory };
  f.check = () => verifyPartitions(campaign, cell, manifest, { root, inventory });
  f.alter = change => {
    const ref = manifest.reports[0], report = JSON.parse(readFileSync(join(root, ref.artifact)));
    const done = JSON.parse(readFileSync(join(root, dirname(ref.artifact), "invocation.json")));
    change(report, done);
    write(root, ref.artifact, report); write(root, `${dirname(ref.artifact)}/invocation.json`, done);
    write(root, `${dirname(ref.artifact)}/results-concurrency.jsonl`, report.cases.map(c => JSON.stringify(c)).join("\n") + "\n");
    ref.sha256 = partitionDigest(readFileSync(join(root, ref.artifact)));
  };
  return f;
}

test("complete partitions retain distinct invocations and cover the exact executable census", t => {
  const f = fixture(t), rows = f.check();
  assert.deepEqual(rows.map(r => r.id), ["run-partition-0-i", "run-partition-1-i"]);
  assert.equal(rows.flatMap(r => r.report.cases).length, 4);
});

for (const [name, mutate, message] of [
  ["missing file", f => f.manifest.reports.pop(), /missing partitions/],
  ["duplicate file", f => { f.manifest.reports[1] = f.manifest.reports[0]; }, /duplicate report/],
  ["changed matrix", f => { f.cell.capabilities.push("new-required-capability"); }, /requirement changed/],
  ["invented inventory", f => { f.manifest.inventory[0].cases.pop(); }, /inventory differs/],
  ["stale source", f => { f.manifest.source = { ...f.manifest.source, fingerprint: "e".repeat(64) }; }, /stale fingerprint/],
  ["corrupt report", f => { f.manifest.reports[0].sha256 = "0".repeat(64); }, /digest differs/],
  ["missing trial", f => f.alter(r => r.cases.pop()), /census differs/],
  ["duplicate trial", f => f.alter(r => r.cases.push(r.cases[0])), /duplicate case identities/],
  ["unfinished run", f => f.alter((r, d) => { delete d.endedAt; }), /successful end is absent/],
  ["wrong participant count", f => f.alter((r, d) => { r.invocation.n = d.n = [5]; }), /participant count differs/],
  ["authoring trial override", f => f.alter((r, d) => { r.invocation.trials = d.trials = 1; }), /authoring partition/],
  ["filtered case", f => f.alter((r, d) => { r.invocation.grep = d.grep = "first"; }), /filtered/],
  ["capability loss", f => f.alter((r, d) => { r.invocation.capabilities = d.capabilities = ["local"]; }), /capabilities differ/],
  ["inconclusive", f => f.alter(r => { r.cases[0].status = "inconclusive"; r.cases[0].inconclusive = "no overlap"; }), /unjudged cases/],
  ["disguised TODO", f => f.alter(r => { r.cases[0].todo = "known bug"; }), /unjudged cases/],
  ["mutant source", f => {
    const p = "e2e/.out/partition-0/stack.json", s = JSON.parse(readFileSync(join(f.root, p)));
    s.patches = [{ set: "controls-disabled-oracle" }]; write(f.root, p, s);
  }, /capability patches differ/],
  ["stale stack", f => {
    const p = "e2e/.out/partition-0/stack.json", s = JSON.parse(readFileSync(join(f.root, p)));
    s.fingerprint.sha256 = "b".repeat(64); write(f.root, p, s);
  }, /source differs/],
]) test(`NEGATIVE: partition acceptance refuses ${name}`, t => {
  const f = fixture(t); mutate(f); assert.throws(f.check, message);
});
