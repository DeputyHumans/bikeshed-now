// SPDX-License-Identifier: Apache-2.0
// Evidence preparation refuses stale snapshots, misleading failures and invented completion while preserving every finding (SPEC §12).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { prepareCampaign, withTree, importRun, importControls, commandCounts, snapshotWorktree, captureCommand, importCommand } from "./e2e-campaign-evidence.mjs";
import { materializeTree } from "../e2e/lib/tree.mjs";
const original = JSON.parse(readFileSync(new URL("../e2e/campaign.json", import.meta.url)));
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
  const ledger = { green: [{ sets: [def.set], invocationDir: "e2e/.out/green/invocations/i" }], controls: [{ set: def.set, ok: true, red: { invocationDir: "e2e/.out/red/invocations/i" } }] };
  write(root, "e2e/.out/controls/ledger.json", ledger);
  return { c, root, base, def, ledger, report: "e2e/.out/green/invocations/i/results.json", controls: "e2e/.out/controls/ledger.json" };
}
test("prepared worktree commands preserve all 64 axes and every unresolved finding", () => {
  const { candidate, plan } = prepareCampaign(original, snapshot);
  assert.equal(plan.matrix.length, 64);
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
  write(f.root, "e2e/.out/red/stack.json", { fingerprint: { baseSha: snapshot.revision, sha256: snapshot.fingerprint }, expectVersion: snapshot.version, patches: [] });
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
