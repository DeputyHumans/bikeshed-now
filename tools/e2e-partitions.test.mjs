// SPDX-License-Identifier: Apache-2.0
// Partition evidence controls reject lost files, cases, trials, capabilities and source identities (SPEC §12).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { concurrencyInventory, verifyPartitions, partitionDigest, partitionCellDigest } from "./e2e-partitions.mjs";
import { DRAFT_ADMISSION_DELTA, DRAFT_ADMISSION_KIND, FIRESTORE_BARRIER_DELTA, FIRESTORE_BARRIER_KIND, CONTROLLED_READER_DELTA, CONTROLLED_READER_BARRIER_KIND } from "./e2e-source-derivation.mjs";

const write = (root, path, value) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), typeof value === "string" ? value : JSON.stringify(value)); };
function fixture(t, { names = ["first", "second"], hashes = [] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "e2e-partitions-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = { revision: "a".repeat(40), version: "0.20.4", fingerprint: "f".repeat(64) };
  const campaign = { acceptance: source };
  const cell = { id: "concurrency-natural-n2", kind: "e2e-run", suite: "concurrency", n: 2, planTrials: true, capabilities: ["local", "storage-preconditions"], options: { patches: [] }, proofs: [] };
  const inventory = names.map((name, i) => {
    const file = `e2e/specs/concurrency/${name}.spec.mjs`;
    return { file, sha256: hashes[i] ?? partitionDigest(name), cases: [1, 2].map(trial => ({ id: `${file}::${name} [N=2] #${trial}`, n: 2, trial })) };
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

function reviewedFamily(f, { controlled = false, omitFirst = false, admission = false } = {}) {
  const changes = [...(admission ? DRAFT_ADMISSION_DELTA : FIRESTORE_BARRIER_DELTA), ...(controlled ? [CONTROLLED_READER_DELTA] : [])];
  const common = f.inventory.slice(omitFirst ? 1 : 0).filter(row => !changes.some(([path]) => path === row.file)).map(({ file, sha256 }) => [file, sha256]);
  const manifest = rows => {
    const files = rows.map(([path, sha256]) => ({ path, sha256 })).sort((a, b) => a.path < b.path ? -1 : 1);
    return { files, snapshot: { revision: "a".repeat(40), version: "0.20.4", files: files.length, fingerprint: partitionDigest(files.map(r => `${r.path}\0${r.sha256}\n`).join("")) } };
  };
  const baseline = manifest([...common, ...changes.filter(r => r[1] !== null).map(r => [r[0], r[1]])]);
  const candidate = manifest([...common, ...changes.map(r => [r[0], r[2]])]);
  const bind = (name, value) => {
    const artifact = `e2e/.out/${name}.json`; write(f.root, artifact, value);
    return { artifact, sha256: partitionDigest(readFileSync(join(f.root, artifact))) };
  };
  f.campaign.acceptance = { ...baseline.snapshot, sourceDerivations: [{ kind: admission ? DRAFT_ADMISSION_KIND : controlled ? CONTROLLED_READER_BARRIER_KIND : FIRESTORE_BARRIER_KIND,
    fingerprint: candidate.snapshot.fingerprint, baseline: bind("baseline", baseline), candidate: bind("candidate", candidate) }] };
  f.manifest.source = controlled ? baseline.snapshot : candidate.snapshot;
  for (const [i, source] of [baseline.snapshot, candidate.snapshot].entries()) {
    const path = `e2e/.out/partition-${i}/stack.json`, stack = JSON.parse(readFileSync(join(f.root, path)));
    stack.fingerprint.sha256 = source.fingerprint; write(f.root, path, stack);
  }
  return { baseline, candidate };
}

test("reviewed constituent sources retain their own fingerprints in one collection", t => {
  const f = fixture(t), { baseline, candidate } = reviewedFamily(f);
  assert.deepEqual(f.check().map(row => row.proof.fingerprint), [baseline.snapshot.fingerprint, candidate.snapshot.fingerprint]);
});

test("a controlled constituent cannot hide under a natural collection source", t => {
  const f = fixture(t); reviewedFamily(f, { controlled: true });
  assert.throws(f.check, /controlled scheduling cannot substitute/);
});

test("source-bound inventories reject invented or missing source file hashes", t => {
  const changed = fixture(t); reviewedFamily(changed); changed.manifest.inventory[0].sha256 = "0".repeat(64);
  assert.throws(changed.check, /inventory differs from its actual source/);
  const missing = fixture(t); reviewedFamily(missing, { omitFirst: true });
  assert.throws(missing.check, /inventory differs from its actual source/);
});

test("unchanged case names cannot conceal an unreviewed executable spec change", t => {
  const f = fixture(t); reviewedFamily(f); f.inventory[0].sha256 = "0".repeat(64);
  assert.throws(f.check, /inventory differs beyond a reviewed spec delta/);
});

test("a historical inventory stays bound to its source across the exact reviewed admission repair", t => {
  const [, before, after] = DRAFT_ADMISSION_DELTA.find(([path]) => path.endsWith("c05-structure.spec.mjs"));
  const f = fixture(t, { names: ["c05-structure", "second"], hashes: [before] });
  const { baseline } = reviewedFamily(f, { admission: true });
  f.manifest.source = baseline.snapshot;
  f.inventory[0].sha256 = after;
  assert.equal(f.check().length, 2);
  f.manifest.inventory[0].sha256 = after;
  assert.throws(f.check, /inventory differs from its actual source/);
});

test("a controlled schedule cannot qualify a changed natural executable inventory", t => {
  const [, before, after] = CONTROLLED_READER_DELTA;
  const f = fixture(t, { names: ["c18-scale-ui", "second"], hashes: [before] });
  const { baseline } = reviewedFamily(f, { controlled: true });
  const path = "e2e/.out/partition-1/stack.json", stack = JSON.parse(readFileSync(join(f.root, path)));
  stack.fingerprint.sha256 = baseline.snapshot.fingerprint; write(f.root, path, stack);
  f.inventory[0].sha256 = after;
  assert.throws(f.check, /inventory differs beyond a reviewed spec delta/);
});

for (const [name, mutate, message] of [
  ["missing file", f => f.manifest.reports.pop(), /missing partitions/],
  ["duplicate file", f => { f.manifest.reports[1] = f.manifest.reports[0]; }, /duplicate report/],
  ["changed matrix", f => { f.cell.capabilities.push("new-required-capability"); }, /requirement changed/],
  ["invented inventory", f => { f.manifest.inventory[0].cases.pop(); }, /inventory differs/],
  ["stale source", f => { f.manifest.source = { ...f.manifest.source, fingerprint: "e".repeat(64) }; }, /source fingerprint differs/],
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
  }, /source fingerprint differs/],
]) test(`NEGATIVE: partition acceptance refuses ${name}`, t => {
  const f = fixture(t); mutate(f); assert.throws(f.check, message);
});

// A large, immediately skipped file makes premature process exit observable.
test("targetless inventory drains every declaration before returning", t => {
  const root = mkdtempSync(join(tmpdir(), "e2e-inventory-drain-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = "e2e/specs/concurrency/drain.spec.mjs", count = 12000;
  write(root, file, `import { test } from "node:test";
for (let i = 0; i < ${count}; i++) test("case " + i, { skip: "no target (E2E_TARGET is not set)" }, () => {});
`);
  write(root, "e2e/lib/reporter.mjs", `export default async function* (events) {
for await (const { type, data } of events) if (type === "test:pass" && data.name.startsWith("case ")) yield JSON.stringify({ id: ${JSON.stringify(file)} + "::" + data.name, file: ${JSON.stringify(file)}, n: null, trial: 1, status: "skip", skipReason: data.skip }) + String.fromCharCode(10);
}
`);
  const inventory = concurrencyInventory(root);
  assert.equal(inventory.length, 1);
  assert.equal(inventory[0].cases.length, count);
  assert.deepEqual(inventory[0].cases.map(c => c.id), Array.from({ length: count }, (_, i) => `${file}::case ${i}`));
});
