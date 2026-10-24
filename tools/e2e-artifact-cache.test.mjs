// SPDX-License-Identifier: Apache-2.0
// Artifact cache controls preserve per-path integrity, duplicate cases and operation isolation (SPEC §12).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EvidenceArtifacts } from "./e2e-artifact-cache.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "evidence-cache-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "report.json");
  writeFileSync(path, JSON.stringify({ cases: [{ id: "one", n: 2, trial: 1, status: "pass" }] }));
  const reads = [];
  const cache = new EvidenceArtifacts({ read: file => { reads.push(file); return readFileSync(file); } });
  return { root, path, cache, reads };
}

test("one artifact is parsed once across many proofs and rehashed once at completion", t => {
  const { root, path, cache, reads } = fixture(t), report = cache.json(path);
  for (let i = 0; i < 2000; i++) assert.equal(cache.json(join(root, ".", "report.json")), report);
  assert.equal(reads.length, 1, "the shared report has one initial byte read");
  cache.assertUnchanged();
  assert.equal(reads.length, 2, "the shared report has one independent final digest check");
});

test("cached parsing cannot hide content changed before the acceptance boundary", t => {
  const { path, cache } = fixture(t);
  cache.json(path);
  writeFileSync(path, JSON.stringify({ cases: [{ id: "one", n: 2, trial: 1, status: "fail" }] }));
  assert.throws(() => cache.assertUnchanged(), /evidence changed during verification/, "changed evidence cannot be accepted from the cached object");
});

test("a different representation checks the captured digest before adding a cache entry", t => {
  const { path, cache } = fixture(t);
  cache.json(path);
  writeFileSync(path, "tampered");
  assert.throws(() => cache.text(path), /evidence changed during verification/);
});

test("a later verification starts fresh and observes changed bytes", t => {
  const { path, cache } = fixture(t);
  assert.equal(cache.json(path).cases[0].status, "pass");
  cache.assertUnchanged();
  writeFileSync(path, JSON.stringify({ cases: [{ id: "one", status: "fail" }] }));
  assert.equal(new EvidenceArtifacts().json(path).cases[0].status, "fail", "no cache crosses verification operations");
});

test("case indexing retains duplicates and distinguishes id, N and trial", t => {
  const { cache } = fixture(t);
  const one = { id: "same", n: 2, trial: 1 }, duplicate = { ...one }, five = { ...one, n: 5 }, trial = { ...one, trial: 2 };
  const report = { cases: [one, duplicate, five, trial] };
  assert.deepEqual(cache.cases(report, one), [one, duplicate], "duplicate exact identities remain visible");
  assert.deepEqual(cache.cases(report, five), [five]);
  assert.deepEqual(cache.cases(report, trial), [trial]);
  assert.deepEqual(cache.cases(report, { ...one, id: "missing" }), []);
});

test("case indexes belong to their report object and preserve default N/trial semantics", t => {
  const { cache } = fixture(t);
  const first = { id: "same", status: "pass" }, second = { id: "same", status: "fail" };
  assert.deepEqual(cache.cases({ cases: [first] }, { id: "same", n: null, trial: 1 }), [first]);
  assert.deepEqual(cache.cases({ cases: [second] }, { id: "same" }), [second]);
});
