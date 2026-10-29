// SPDX-License-Identifier: Apache-2.0
// Evidence preparation refuses stale snapshots, misleading failures and invented completion while preserving every finding (SPEC §12).

import { FIRESTORE_MAINTENANCE_DELTA, CONTROLLED_READER_DELTA, CONTROLLED_READER_KIND } from "./e2e-source-derivation.mjs";
import { createHash } from "node:crypto";
import { EvidenceArtifacts } from "./e2e-artifact-cache.mjs";
import { attachRtdbFixture } from "./e2e-rtdb-test-fixture.mjs";
import { syntheticCampaignTemplate } from './e2e-test-campaign.mjs';
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { prepareCampaign, withTree, importRun, importControls, commandCounts, snapshotWorktree, captureCommand, importCommand } from "./e2e-campaign-evidence.mjs";
import { materializeTree } from "../e2e/lib/tree.mjs";
const original = syntheticCampaignTemplate(JSON.parse(readFileSync(new URL("../e2e/campaign.json", import.meta.url))));
const snapshot = { revision: "a".repeat(40), version: "0.1.0", fingerprint: "f".repeat(64), files: 3 };
const write = (root, path, value) => { const file = join(root, path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value)); };
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "campaign-evidence-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const c = structuredClone(original); c.proofs = []; c.controls = []; Object.assign(c.acceptance, snapshot);
  const file = "e2e/specs/functional/synthetic.spec.mjs", name = "Synthetic exact case", base = { id: `${file}::${name}`, file, name, n: null, trial: 1, status: "pass", error: null };
  const def = { set: "controls-synthetic", what: "restore the bug", target: { spec: file, case: name, suite: "functional" }, selection: { case: name }, expect: { message: "intended assertion" } };
  for (const run of ["green", "red"]) {
    write(root, `e2e/.out/${run}/stack.json`, { fingerprint: { baseSha: snapshot.revision, sha256: snapshot.fingerprint, dirty: true }, expectVersion: snapshot.version, patches: run === "red" ? [{ set: def.set }] : [], options: {} });
    const invocation = { id: "i", runId: run, suite: "functional", grep: null, spec: [], n: null, trials: null, capabilities: [], plan: [{ tier: "functional", files: [file] }], startedAt: "2026-10-15T01:00:00Z" };
    write(root, `e2e/.out/${run}/invocations/i/results.json`, { runId: run, invocation, mergedAt: "2026-10-15T01:01:00Z", malformed: [], cases: [{ ...base, ...(run === "red" ? { status: "fail", error: { message: "intended assertion: value differs" } } : {}) }] });
    write(root, `e2e/.out/${run}/invocations/i/results-functional.jsonl`, JSON.stringify({ ...base, ...(run === "red" ? { status: "fail", error: { message: "intended assertion: value differs" } } : {}) }) + "\n");
    write(root, `e2e/.out/${run}/invocations/i/invocation.json`, { ...invocation, endedAt: "2026-10-15T01:01:01Z", exit: run === "red" ? 1 : 0, interrupted: null, stackDown: null });
  }
  for (const run of ["green", "red"]) attachRtdbFixture(root, { campaign: c, rel: `e2e/.out/${run}/invocations/i/results.json` });
  const ledger = { green: [{ sets: [def.set], invocationDir: "e2e/.out/green/invocations/i" }], controls: [{ set: def.set, ok: true, red: { invocationDir: "e2e/.out/red/invocations/i" } }] };
  write(root, "e2e/.out/controls/ledger.json", ledger);
  return { c, root, base: { ...base, at: "2026-10-15T01:00:30.500Z" }, def, ledger, report: "e2e/.out/green/invocations/i/results.json", controls: "e2e/.out/controls/ledger.json" };
}
test("prepared worktree commands preserve all 55 scoped axes and every unresolved finding", () => {
  const { candidate, plan } = prepareCampaign(original, snapshot);
  assert.equal(plan.matrix.length, 55);
  assert.deepEqual(candidate.items, original.items);
  assert.deepEqual(candidate.coverage, original.coverage);
  for (const [i, r] of candidate.acceptance.requirements.entries()) {
    const before = original.acceptance.requirements[i];
    assert.deepEqual({ ...r, command: before.command, ...(r.id === "controls" ? { controlSets: undefined } : {}) }, { ...before, ...(r.id === "controls" ? { controlSets: undefined } : {}) });
    if (r.kind === "e2e-run" || r.id === "controls") assert.match(r.command, / --tree worktree$/);
    else assert.equal(r.command, before.command);
  }
  assert.equal(withTree("node e2e/run.mjs controls --tree HEAD", "worktree"), "node e2e/run.mjs controls --tree worktree");
  assert.throws(() => prepareCampaign(original, snapshot, { tree: "HEAD" }), /frozen worktree/);
});
test("run imports exact case identities and leaves all states unresolved", (t) => {
  const f = fixture(t), result = importRun(f.c, f.report, { root: f.root, cellId: "functional" });
  assert.equal(result.importedCases, 1);
  assert.equal(result.candidate.proofs.find((p) => p.kind === "e2e-case").caseId, f.base.id);
  assert.deepEqual(result.candidate.items, f.c.items);
  assert.deepEqual(result.candidate.coverage, f.c.coverage);
  assert.equal(result.candidate.acceptance.requirements.find((r) => r.id === "functional").proofs.length, 1);
  for (const field of ["revision", "version", "fingerprint"]) { const c = structuredClone(f.c); c.acceptance[field] = "wrong"; assert.throws(() => importRun(c, f.report, { root: f.root }), /differs/); }
});
test("projection dependency setup is positive evidence but a nearby product mutant is refused", (t) => {
  const f = fixture(t), path = "e2e/.out/green/stack.json";
  const stack = JSON.parse(readFileSync(join(f.root, path)));
  write(f.root, path, { ...stack, patches: [{ set: "a12-projection-unavailable" }] });
  assert.equal(importRun(f.c, f.report, { root: f.root }).importedCases, 1);
  write(f.root, path, { ...stack, patches: [{ set: "a12-projection-unavailable-extra" }] });
  assert.throws(() => importRun(f.c, f.report, { root: f.root }), /product mutant/);
});
test("filtered, TODO and inconclusive matrix results cannot be imported as completed cells", (t) => {
  const f = fixture(t), clean = JSON.parse(readFileSync(join(f.root, f.report)));
  for (const patch of [{ status: "todo", todo: "known" }, { status: "inconclusive" }, { status: "pass", notReproduced: true }]) {
    write(f.root, f.report, { ...clean, cases: [{ ...f.base, ...patch }] });
    assert.throws(() => importRun(f.c, f.report, { root: f.root, cellId: "functional" }), /failed or unjudged/);
  }
  write(f.root, f.report, { ...clean, invocation: { ...clean.invocation, grep: "one" } });
  const completionPath = `${dirname(f.report)}/invocation.json`, completion = JSON.parse(readFileSync(join(f.root, completionPath)));
  write(f.root, completionPath, { ...completion, grep: "one" });
  assert.throws(() => importRun(f.c, f.report, { root: f.root, cellId: "functional" }), /cannot use grep/);
});
test("a partial all-pass report cannot import a completed matrix cell", (t) => {
  const f = fixture(t);
  rmSync(join(f.root, dirname(f.report), "invocation.json"));
  assert.throws(() => importRun(f.c, f.report, { root: f.root, cellId: "functional" }), /completed invocation/);
});
test("control imports read actual errors and mutation records, not summary labels or titles", (t) => {
  const f = fixture(t), options = { root: f.root, readDefinition: () => f.def };
  const good = importControls(f.c, f.controls, options); assert.deepEqual(good.imported, [f.def.set]); assert.deepEqual(good.refused, []);
  assert.equal(good.candidate.controls[0].assertion, "intended assertion");
  assert.deepEqual(good.candidate.items, f.c.items);
  const redPath = "e2e/.out/red/invocations/i/results.json", red = JSON.parse(readFileSync(join(f.root, redPath)));
  write(f.root, redPath, { ...red, cases: [{ ...red.cases[0], name: "Synthetic exact case", title: "intended assertion", error: { message: "another failure" } }] });
  assert.match(importControls(f.c, f.controls, options).refused[0]?.reason ?? "", /selected failure/);
  write(f.root, redPath, red);
  write(f.root, "e2e/.out/red/stack.json", { ...JSON.parse(readFileSync(join(f.root, "e2e/.out/red/stack.json"))), patches: [] });
  assert.match(importControls(f.c, f.controls, options).refused[0]?.reason ?? "", /named mutation/);
});
test("duplicate control entries remain refused instead of inflating completion", (t) => {
  const f = fixture(t); f.ledger.controls.push(f.ledger.controls[0]); write(f.root, f.controls, f.ledger);
  const result = importControls(f.c, f.controls, { root: f.root, readDefinition: () => f.def });
  assert.equal(result.imported.length, 1); assert.match(result.refused[0]?.reason ?? "", /duplicate/);
});
test("command counts use final Node and Vitest counters and reject a title-only or partial log", () => {
  assert.deepEqual(commandCounts("# tests 2\n# pass 2\n# fail 0\n# skipped 0\n# todo 0\n# cancelled 0\n Tests  2 passed (2)\n"), { tests: 4, pass: 4, fail: 0, skip: 0, todo: 0, inconclusive: 0 });
  assert.throws(() => commandCounts("ok 1 - tests 99 pass 99\n"), /missing or inconsistent/);
  assert.throws(() => commandCounts("ℹ tests 2\nℹ pass 1\n"), /missing or inconsistent/);
  assert.equal(commandCounts("ℹ tests 2\nℹ pass 1\nℹ cancelled 1\n").inconclusive, 1);
});
test("snapshot and explicit command capture bind the same files as a worktree stack copy", async (t) => {
  const f = fixture(t), git = (args) => execFileSync("git", args, { cwd: f.root, stdio: "pipe" });
  write(f.root, ".gitignore", "e2e/.out/\n"); write(f.root, "package.json", { version: snapshot.version }); write(f.root, "tools/sample.txt", "one\n"); symlinkSync("sample.txt", join(f.root, "tools/link"));
  git(["init", "-q"]); git(["add", ".gitignore", "package.json", "tools/sample.txt", "tools/link"]); git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "fixture"]);
  const s = snapshotWorktree(f.root), copy = await materializeTree({ runId: "evidence-selftest", tree: "worktree", repoRoot: f.root, dest: join(f.root, "e2e/.out/copy"), linkModules: false });
  assert.equal(s.fingerprint, copy.fingerprint.sha256, "the capture fingerprint is the stack's exact source digest");
  Object.assign(f.c.acceptance, s); const cell = f.c.acceptance.requirements.find((r) => r.id === "verify");
  cell.command = `${JSON.stringify(process.execPath)} -e 'console.log("# tests 1\\n# pass 1\\n# fail 0\\n# skipped 0\\n# todo 0\\n# cancelled 0")'`;
  const report = await captureCommand(f.c, "verify", "e2e/.out/capture", { root: f.root });
  assert.equal(report.outcome, "PASS"); assert.equal(report.tests, 1); assert.equal(report.command, cell.command);
  const result = importCommand(f.c, "e2e/.out/capture/command.json", { root: f.root, cellId: "verify" }); assert.equal(result.candidate.proofs.length, 1);
  write(f.root, report.log, "tampered"); assert.throws(() => importCommand(f.c, "e2e/.out/capture/command.json", { root: f.root, cellId: "verify" }), /digest/);
});

test("control import shares green artifacts without sharing target or mutation decisions", t => {
  const f = fixture(t), second = { ...f.def, set: "controls-second", expect: { message: "another intended assertion" } };
  f.ledger.green[0].sets.push(second.set);
  f.ledger.controls.push({ ...f.ledger.controls[0], set: second.set });
  write(f.root, f.controls, f.ledger);
  const before = structuredClone(f.c);
  const result = importControls(f.c, f.controls, { root: f.root, readDefinition: set => set === f.def.set ? f.def : second });
  assert.deepEqual(result.imported, [f.def.set]);
  assert.match(result.refused[0].reason, /named mutation|intended assertion/);
  assert.deepEqual(f.c, before, "the public importer does not mutate its caller's campaign");
});

test("control import refuses a shared artifact changed by a later definition read", t => {
  const f = fixture(t), second = { ...f.def, set: "controls-second" };
  f.ledger.green[0].sets.push(second.set);
  f.ledger.controls.push({ ...f.ledger.controls[0], set: second.set });
  write(f.root, f.controls, f.ledger);
  assert.throws(() => importControls(f.c, f.controls, { root: f.root, readDefinition: set => {
    if (set === second.set) {
      const report = JSON.parse(readFileSync(join(f.root, f.report), "utf8"));
      report.cases[0].status = "fail"; write(f.root, f.report, report);
    }
    return set === f.def.set ? f.def : second;
  } }), /evidence changed during verification/, "no partly cached control import escapes the final byte check");
});

test("campaign preparation explicitly freezes the reviewed unofficial RTDB engine", () => {
  const { candidate, plan } = prepareCampaign(original, snapshot);
  assert.deepEqual(candidate.acceptance.rtdbEngine, {
    kind: "request-context-sync-v1", label: "derived/unofficial diagnostic-append lock",
    firebaseVersion: "15.25.1", databaseVersion: "4.11.2",
    originalSha256: "b70d99344caf17c98b6f910fa8f6edf32a7c016cb1035e8915f70d38901eb97f",
    actualSha256: "919e70261efbd666cd605621deb41f2dbf8c1d042a08b55e937bc06d8d09a18f",
    profileSha256: "ea69a817b0ba05d6193621617ad696700ff354575f87f474ea6ef0926f878b35",
  }, "preparation cannot silently inherit an absent or historical stock policy");
  assert.deepEqual(plan.rtdbEngine, candidate.acceptance.rtdbEngine, "the executable plan displays its explicit runtime policy");
});

test("run and control import require independently verified runtime policy", t => {
  const f = fixture(t); delete f.c.acceptance.rtdbEngine;
  assert.throws(() => importRun(f.c, f.report, { root: f.root }), /acceptance must explicitly choose/, "run imports cannot bypass runtime attestation");
  const result = importControls(f.c, f.controls, { root: f.root, readDefinition: () => f.def });
  assert.deepEqual(result.imported, [], "unattested controls never become accepted pairs");
  assert.match(result.refused[0].reason, /acceptance must explicitly choose/);
});

test("run import finalizes runtime bytes after its last per-proof validation", t => {
  const f = fixture(t), report = JSON.parse(readFileSync(join(f.root, f.report)));
  const runtimePath = join(f.root, report.invocation.rtdbRuntime.artifact), original = EvidenceArtifacts.prototype.assertUnchanged;
  EvidenceArtifacts.prototype.assertUnchanged = function () {
    original.call(this);
    const runtime = JSON.parse(readFileSync(runtimePath)); runtime.changedAfterLastRead = true;
    writeFileSync(runtimePath, JSON.stringify(runtime));
  };
  try { assert.throws(() => importRun(f.c, f.report, { root: f.root }), /evidence changed before final acceptance/, "the public importer must finalize its runtime snapshot"); }
  finally { EvidenceArtifacts.prototype.assertUnchanged = original; }
});

test("control import finalizes runtime bytes after its last pair validation", t => {
  const f = fixture(t), report = JSON.parse(readFileSync(join(f.root, f.report)));
  const runtimePath = join(f.root, report.invocation.rtdbRuntime.artifact), original = EvidenceArtifacts.prototype.assertUnchanged;
  EvidenceArtifacts.prototype.assertUnchanged = function () {
    original.call(this);
    const runtime = JSON.parse(readFileSync(runtimePath)); runtime.changedAfterLastRead = true;
    writeFileSync(runtimePath, JSON.stringify(runtime));
  };
  try { assert.throws(() => importControls(f.c, f.controls, { root: f.root, readDefinition: () => f.def }), /evidence changed before final acceptance/, "the public control importer must finalize its runtime snapshot"); }
  finally { EvidenceArtifacts.prototype.assertUnchanged = original; }
});


for (const controlled of [false, true]) test(`a reviewed ${controlled ? "controlled reader" : "maintenance"} derivative imports its actual fingerprint and rejects borrowed proof identity`, t => {
  const f = fixture(t), hash = bytes => createHash("sha256").update(bytes).digest("hex");
  const manifest = column => {
    const files = [["app/src/unchanged.ts", hash("unchanged product")], ...[...FIRESTORE_MAINTENANCE_DELTA, ...(controlled ? [CONTROLLED_READER_DELTA] : [])].filter(row => row[column] !== null).map(row => [row[0], row[column]])].sort(([a],[b]) => a < b ? -1 : 1).map(([path, sha256]) => ({path, sha256}));
    return { snapshot: { ...snapshot, files: files.length, fingerprint: hash(files.map(row => `${row.path}\0${row.sha256}\n`).join("")) }, files };
  };
  const baseline = manifest(1), candidate = manifest(2);
  const bind = (name, value) => { const artifact = `e2e/.out/derivation/${name}.json`; write(f.root, artifact, value); return { artifact, sha256: hash(readFileSync(join(f.root, artifact))) }; };
  Object.assign(f.c.acceptance, baseline.snapshot, {sourceDerivations:[{kind:controlled ? CONTROLLED_READER_KIND : "firestore-diagnostic-recycle-v1",fingerprint:candidate.snapshot.fingerprint,baseline:bind("baseline",baseline),candidate:bind("candidate",candidate)}]});
  // The independent runtime receipt must name the actual new stack, too.
  const actualCampaign = structuredClone(f.c); Object.assign(actualCampaign.acceptance, candidate.snapshot);
  const stackPath = "e2e/.out/green/stack.json", stack = JSON.parse(readFileSync(join(f.root,stackPath)));
  stack.fingerprint.sha256 = candidate.snapshot.fingerprint; write(f.root,stackPath,stack);
  attachRtdbFixture(f.root,{campaign:actualCampaign,rel:f.report});
  if (controlled) assert.throws(()=>importRun(f.c,f.report,{root:f.root,cellId:"functional"}),/controlled scheduling overlay cannot substitute/);
  const result=importRun(f.c,f.report,{root:f.root,...(controlled ? {} : {cellId:"functional"})});
  assert.ok(result.candidate.proofs.length > 0);
  assert.ok(result.candidate.proofs.every(p=>p.fingerprint===candidate.snapshot.fingerprint));
  assert.equal(result.candidate.acceptance.fingerprint,baseline.snapshot.fingerprint,"baseline is never relabelled");
  f.c.acceptance.sourceDerivations=[];
  assert.throws(()=>importRun(f.c,f.report,{root:f.root}),/source fingerprint differs/);
});
