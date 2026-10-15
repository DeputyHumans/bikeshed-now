// SPDX-License-Identifier: Apache-2.0
// Campaign completion controls: missing work, disguised outcomes, stale evidence and ineffective controls never become a pass (SPEC §12).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { checkCampaign } from "./check-e2e-campaign.mjs";
import { captureLocalLimit, importRun } from "./e2e-campaign-evidence.mjs";
import { C15_WORK, C15_JUDGE, localLimitReference } from "./e2e-local-limit.mjs";
import { PIN } from "./probe-e2e-trigger-queue.mjs";

const imported = JSON.parse(readFileSync(new URL("../e2e/campaign.json", import.meta.url), "utf8"));
const sha = "a".repeat(40);
const version = "0.1.0";
const fingerprint = "f".repeat(64);
const hash = (s) => createHash("sha256").update(s).digest("hex");
const write = (root, file, value) => { const p = join(root, file); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, JSON.stringify(value)); };

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "campaign-check-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const c = structuredClone(imported);
  c.proofs = [];
  c.controls = [];
  Object.assign(c.acceptance, { revision: sha, version, fingerprint });
  let seq = 0;
  for (const r of c.acceptance.requirements) {
    const id = `proof-${seq++}`;
    const artifact = `e2e/.out/${id}/report.json`;
    const p = { id, kind: r.kind, revision: sha, version, fingerprint, artifact, outcome: "PASS" };
    if (r.kind === "command") {
      const log = `${artifact}.log`;
      const logText = `command passed: ${r.command}\n# tests 1\n# pass 1\n# fail 0\n# skipped 0\n# todo 0\n# cancelled 0\n`;
      write(root, artifact, { command: r.command, revision: sha, version, fingerprint, outcome: "PASS", exitCode: 0, tests: 1, fail: 0, skip: 0, todo: 0, inconclusive: 0, log });
      writeFileSync(join(root, log), logText);
      Object.assign(p, { command: r.command, logSha256: hash(logText) });
    } else {
      Object.assign(p, { runId: id, invocation: "invocation-1" });
      const file = `e2e/specs/${r.suite}/${r.spec ?? "synthetic.spec.mjs"}`;
      const cases = [{ id: `${file}::synthetic assertion`, name: "synthetic assertion", file, status: "pass", n: r.n ?? null, trial: 1, todo: null, error: null }];
      const invocation = { id: p.invocation, runId: id, suite: r.suite, n: r.n ? [r.n] : null, spec: r.spec ? [r.spec] : [], grep: null, trials: null, capabilities: r.capabilities ?? [], plan: [{ tier: r.suite, files: [file] }], startedAt: "2026-10-15T01:00:00Z" };
      write(root, artifact, { runId: id, invocation, mergedAt: "2026-10-15T01:01:00Z", malformed: [], cases });
      writeFileSync(join(root, dirname(artifact), "results-final.jsonl"), cases.map(row => JSON.stringify(row)).join("\n") + "\n");
      write(root, `${dirname(artifact)}/invocation.json`, { ...invocation, endedAt: "2026-10-15T01:01:01Z", exit: 0, interrupted: null, stackDown: null });
      write(root, `e2e/.out/${id}/stack.json`, { fingerprint: { baseSha: sha, sha256: fingerprint, dirty: false }, expectVersion: version, patches: (r.options?.patches ?? []).map((set) => ({ set })), options: { emailOff: r.options?.emailOff ?? false, appEnv: { ...Object.fromEntries((r.options?.appEnvPresent ?? []).map((k) => [k, "synthetic"])), ...(r.options?.appEnv ?? {}) } } });
    }
    c.proofs.push(p);
    r.proofs = [id];
  }
  const source = c.proofs.find((p) => p.kind === "e2e-run");
  const report = JSON.parse(readFileSync(join(root, source.artifact), "utf8"));
  const positive = { ...source, id: "positive-case", kind: "e2e-case", caseId: report.cases[0].id };
  c.proofs.push(positive);
  const negative = { ...positive, id: "negative-case", runId: "negative-stack", artifact: "e2e/.out/negative/report.json", outcome: "FAIL" };
  write(root, negative.artifact, { ...report, runId: negative.runId, cases: [{ ...report.cases[0], status: "fail", error: "intended synthetic assertion" }] });
  write(root, `e2e/.out/${negative.runId}/stack.json`, { fingerprint: { baseSha: sha, sha256: fingerprint, dirty: false }, expectVersion: version, patches: [{ set: "controls-synthetic" }] });
  c.proofs.push(negative);
  c.controls.push({ id: "control", set: "controls-synthetic", mutation: "plant the synthetic bug", red: negative.id, green: positive.id, assertion: "intended synthetic assertion" });
  for (const item of [...c.coverage.items, ...c.items, ...c.discoveries]) {
    if (item.state === "historical-closed") continue;
    item.state = "resolved";
    item.resolution = { kind: "refuted", reason: "Synthetic checker fixture only, never product evidence", spec: "SPEC §12", proofs: [positive.id], controls: [] };
  }
  return { c, root, positive, negative, report, rewrite(value) { write(root, positive.artifact, value); } };
}

test("the real ledger validates but the completion gate refuses open coverage, product reports and matrix work", () => {
  const c = structuredClone(imported);
  c.items.find((i) => i.id === "S3").state = "open";
  c.acceptance.requirements[0].proofs = [];
  const result = checkCampaign(c, { validateOnly: true });
  assert.deepEqual(result.errors, []);
  assert.equal(result.complete, false);
  assert.equal(result.counts.coverage, 234);
  assert.equal(result.counts.suspects, 61);
  assert.equal(result.counts.reported, 38);
  const gate = checkCampaign(c);
  assert.equal(gate.complete, false);
  assert.ok(gate.pending.some((p) => p.startsWith("matrix:")));
  assert.ok(gate.pending.some((p) => p.startsWith("S3:")));
});
test("projection dependency setup is allowed for positive proof without admitting adjacent product mutations", (t) => {
  const { c, root, positive, report } = fixture(t);
  const proof = { ...positive, id: "projection-case", runId: "projection-stack", artifact: "e2e/.out/projection-stack/report.json" };
  c.proofs.push(proof);
  write(root, proof.artifact, { ...report, runId: proof.runId, invocation: { ...report.invocation, runId: proof.runId } });
  const stack = { fingerprint: { baseSha: sha, sha256: fingerprint, dirty: false }, expectVersion: version, patches: [{ set: "a12-projection-unavailable" }] };
  write(root, "e2e/.out/projection-stack/stack.json", stack);
  assert.deepEqual(checkCampaign(c, { root }).errors, []);
  write(root, "e2e/.out/projection-stack/stack.json", { ...stack, patches: [{ set: "a12-projection-unavailable-extra" }] });
  assert.match(checkCampaign(c, { root }).errors.join("\n"), /positive evidence contains a product mutant/);
});
test("a partial all-pass report cannot close a full matrix cell", (t) => {
  const { c, root } = fixture(t);
  const proof = c.proofs.find(p => p.kind === "e2e-run");
  rmSync(join(root, dirname(proof.artifact), "invocation.json"));
  const result = checkCampaign(c, { root });
  assert.equal(result.complete, false, "matrix completion requires the invocation's recorded successful end");
  assert.match(result.errors.join("\n"), /completed invocation/);
});

test("negative controls: removing baseline observations, overlap links, a later discovery or an execution variant invalidates the ledger", () => {
  for (const change of [
    (c) => c.coverage.observations.pop(),
    (c) => c.coverage.items.find((i) => i.observations.length > 1).observations.pop(),
    (c) => { c.discoveries = c.discoveries.filter((d) => d.id !== "coverage-new-version-drop"); },
    (c) => c.acceptance.requirements.pop(),
    (c) => c.items.pop(),
  ]) {
    const c = structuredClone(imported); change(c);
    assert.equal(checkCampaign(c, { validateOnly: true }).valid, false);
  }
});

test("complete synthetic evidence is accepted; reopening one item or removing its proof/control blocks completion", (t) => {
  const { c, root } = fixture(t);
  assert.deepEqual(checkCampaign(c, { root }).errors, []);
  assert.equal(checkCampaign(c, { root }).complete, true);
  c.items[0].state = "open";
  assert.equal(checkCampaign(c, { root }).complete, false);
  c.items[0].state = "resolved";
  c.items[0].resolution.kind = "fixed";
  c.items[0].requiredCases = [];
  assert.match(checkCampaign(c, { root }).errors.join("\n"), /negative controls/);
  c.items[0].resolution.controls = ["control"];
  assert.equal(checkCampaign(c, { root }).complete, true);
  c.items[0].resolution.proofs = [];
  assert.match(checkCampaign(c, { root }).errors.join("\n"), /positive proof/);
});

test("negative controls: TODO, skip, inconclusive and not-reproduced rows are never positive case proof", (t) => {
  const { c, root, report, rewrite } = fixture(t);
  for (const mutation of [{ todo: "known defect" }, { status: "skip" }, { inconclusive: "environment" }, { notReproduced: true }, { outcome: "TODO-passed-unexpectedly" }]) {
    rewrite({ ...report, cases: [{ ...report.cases[0], ...mutation }] });
    const result = checkCampaign(c, { root });
    assert.equal(result.complete, false);
    assert.match(result.errors.join("\n"), /not an unqualified PASS/);
  }
  rewrite(report);
  assert.equal(checkCampaign(c, { root }).complete, true);
});

test("negative controls: wrong revision, absent artifacts, wrong assertion and no red failure are refused", (t) => {
  const { c, root, negative } = fixture(t);
  c.acceptance.revision = "b".repeat(40);
  assert.match(checkCampaign(c, { root }).errors.join("\n"), /acceptance revision/);
  c.acceptance.revision = sha;
  const artifact = negative.artifact;
  negative.artifact = "missing.json";
  assert.match(checkCampaign(c, { root }).errors.join("\n"), /cannot verify evidence/);
  negative.artifact = artifact;
  c.controls[0].assertion = "some other assertion";
  assert.match(checkCampaign(c, { root }).errors.join("\n"), /intended assertion/);
  c.controls[0].assertion = "intended synthetic assertion";
  negative.outcome = "PASS";
  assert.match(checkCampaign(c, { root }).errors.join("\n"), /real red FAIL/);
});

test("negative control: smoke alone cannot close a defect with other affected area cases", (t) => {
  const { c, root, positive } = fixture(t);
  const item = c.items.find((i) => i.id === "S3");
  item.resolution = { kind: "fixed", reason: "Synthetic repair", spec: "SPEC §6", proofs: [positive.id], controls: ["control"] };
  assert.ok(item.requiredCases.length > 1);
  assert.match(checkCampaign(c, { root }).errors.join("\n"), /S3: missing affected case/);
});

test("negative controls: a filtered matrix cell, shortened trials or mismatched capability cannot satisfy the full matrix", (t) => {
  const { c, root } = fixture(t);
  const r = c.acceptance.requirements.find((r) => r.id === "concurrency-natural-n20");
  const p = c.proofs.find((p) => p.id === r.proofs[0]);
  const report = JSON.parse(readFileSync(join(root, p.artifact), "utf8"));
  for (const mutation of [{ grep: "one case" }, { trials: 1 }, { capabilities: [] }]) {
    write(root, p.artifact, { ...report, invocation: { ...report.invocation, ...mutation } });
    assert.equal(checkCampaign(c, { root }).complete, false);
  }
  write(root, p.artifact, report);
  assert.equal(checkCampaign(c, { root }).complete, true);
});


test("all three additional CLI capability cells are mandatory and remain unproved until executed", () => {
  assert.equal(imported.acceptance.requirements.filter(r => !["concurrency-thumb-authority-n2", "postcommit-projection-failure", "native-ack-endpoints", "native-ack-operators"].includes(r.id)).length, 51, "all original cells remain beside the added failure variants");
  for (const id of ["cli-uppercase-skill", "cli-underscore-skill", "cli-interval-floor"]) {
    const cell = imported.acceptance.requirements.find((r) => r.id === id);
    assert.equal(cell.spec, "a20-cli.spec.mjs");
    assert.deepEqual(cell.capabilities, cell.options.patches.map((p) => `patch:${p}`));
    const c = structuredClone(imported);
    c.acceptance.requirements = c.acceptance.requirements.filter((r) => r.id !== id);
    assert.ok(checkCampaign(c, { validateOnly: true }).errors.includes(`retain matrix requirement ${id}`), `removing ${id} invalidates the matrix`);
  }
});

test("control assertion text in a title or a different case cannot authenticate the selected failure", (t) => {
  const { c, root, negative, report } = fixture(t);
  const selected = { ...report.cases[0], status: "fail", error: "unrelated assertion", name: "intended synthetic assertion" };
  write(root, negative.artifact, { ...report, runId: negative.runId, cases: [selected, { ...selected, id: "other-case", error: "intended synthetic assertion" }] });
  assert.match(checkCampaign(c, { root }).errors.join("\n"), /selected red case.*intended assertion/);
});

test("an E2E control needs the same exact case and its named patch on the red stack", (t) => {
  const { c, root, positive } = fixture(t);
  c.controls[0].set = "controls-absent-mutation";
  assert.match(checkCampaign(c, { root }).errors.join("\n"), /named mutation.*red stack/);
  c.controls[0].set = "controls-synthetic";
  positive.caseId = "unrelated-case";
  assert.match(checkCampaign(c, { root }).errors.join("\n"), /same exact case/);
});

test("the default-marking matrix command uses exactly the option its proof must contain", () => {
  const cell = imported.acceptance.requirements.find((r) => r.id === "account-default-mark");
  assert.ok(cell.command.includes(`VITE_EXPORT_MARK_ENABLED=${cell.options.appEnv.VITE_EXPORT_MARK_ENABLED}`), "the executable default-marking cell agrees with its recorded option");
});

test("command controls retain real diagnostics without inventing a mutated stack", (t) => {
  const { c, root } = fixture(t);
  const command = "node synthetic-harness-test.mjs";
  for (const [id, outcome, logText, exitCode, fail] of [
    ["command-red", "FAIL", "# Subtest: named command case\n  error: intended command assertion\n  code: 'ERR_ASSERTION'\n# tests 1\n# pass 0\n# fail 1\n# skipped 0\n# todo 0\n# cancelled 0\n", 1, 1],
    ["command-green", "PASS", "ok 1 - named command case\n# tests 1\n# pass 1\n# fail 0\n# skipped 0\n# todo 0\n# cancelled 0\n", 0, 0],
  ]) {
    const artifact = `e2e/.out/${id}/report.json`, log = `${artifact}.log`;
    write(root, artifact, { command, revision: sha, version, fingerprint, outcome, exitCode, tests: 1, fail, skip: 0, todo: 0, inconclusive: 0, log, ...(fail ? { assertionEvidence: { startLine: 2, endLine: 3 } } : {}) });
    writeFileSync(join(root, log), logText);
    c.proofs.push({ id, kind: "command", revision: sha, version, fingerprint, outcome, command, artifact, logSha256: hash(logText) });
  }
  c.controls.push({ id: "command-control", mutation: "restore a harness defect in the isolated source", red: "command-red", green: "command-green", assertion: "intended command assertion" });
  assert.deepEqual(checkCampaign(c, { root }).errors, []);
  const p = c.proofs.find((p) => p.id === "command-red"), report = JSON.parse(readFileSync(join(root, p.artifact)));
  write(root, p.artifact, { ...report, assertionEvidence: undefined });
  assert.match(checkCampaign(c, { root }).errors.join("\n"), /exact diagnostic line bounds/);
  write(root, p.artifact, { ...report, assertionEvidence: { startLine: 1, endLine: 3 } });
  const titleOnly = "# Subtest: intended command assertion\n  error: unrelated failure\n  code: 'ERR_ASSERTION'\n# tests 1\n# pass 0\n# fail 1\n# skipped 0\n# todo 0\n# cancelled 0\n";
  writeFileSync(join(root, report.log), titleOnly); p.logSha256 = hash(titleOnly);
  assert.match(checkCampaign(c, { root }).errors.join("\n"), /command diagnostic does not name the intended assertion/);
});


test("frozen source fingerprints bind clean stacks, proofs and captured command metadata", (t) => {
  const { c, root, positive } = fixture(t);
  assert.equal(checkCampaign(c, { root }).complete, true);
  const stackPath = `e2e/.out/${positive.runId}/stack.json`, stack = JSON.parse(readFileSync(join(root, stackPath)));
  write(root, stackPath, { ...stack, fingerprint: { ...stack.fingerprint, sha256: "e".repeat(64), dirty: false } });
  assert.match(checkCampaign(c, { root }).errors.join("\n"), /stack differs from the frozen source fingerprint/);
  write(root, stackPath, stack);
  positive.fingerprint = "e".repeat(64);
  assert.match(checkCampaign(c, { root }).errors.join("\n"), /evidence differs from the frozen source fingerprint/);
  positive.fingerprint = fingerprint;
  const command = c.proofs.find((p) => p.kind === "command"), report = JSON.parse(readFileSync(join(root, command.artifact)));
  write(root, command.artifact, { ...report, fingerprint: "e".repeat(64) });
  assert.match(checkCampaign(c, { root }).errors.join("\n"), /command source fingerprint differs/);
});

test("command metadata cannot replace the final captured test counters", (t) => {
  const { c, root } = fixture(t), p = c.proofs.find((p) => p.kind === "command");
  const report = JSON.parse(readFileSync(join(root, p.artifact)));
  write(root, p.artifact, { ...report, tests: 99 });
  assert.match(checkCampaign(c, { root }).errors.join("\n"), /tests count differs from the captured log/);
});

test("control matrix accepts genuine aggregate commands but refuses missing, duplicate and unproved sets", (t) => {
  const { c, root } = fixture(t), cell = c.acceptance.requirements.find((r) => r.id === "controls"), p = c.proofs.find((p) => p.id === cell.proofs[0]);
  const report = JSON.parse(readFileSync(join(root, p.artifact)));
  cell.controlSets = ["controls-synthetic"];
  p.command = "node tools/e2e-controls-parallel.mjs --campaign e2e/.out/prepared.json --out e2e/.out/aggregate";
  const ledgerPath = "e2e/.out/aggregate/ledger.json", control = c.controls[0], red = c.proofs.find((p) => p.id === control.red), green = c.proofs.find((p) => p.id === control.green);
  c.acceptance.tree = "worktree";
  const ledger = { ok: true, endedAt: "2026-10-15T00:00:00Z", commit: sha, tree: "worktree", controls: [{ set: control.set, ok: true, red: { invocationDir: dirname(red.artifact) } }], green: [{ sets: [control.set], invocationDir: dirname(green.artifact) }] };
  write(root, ledgerPath, ledger);
  const aggregate = { ...report, command: p.command, controlSets: ["controls-synthetic"], controlLedgers: [ledgerPath] };
  write(root, p.artifact, aggregate);
  assert.equal(checkCampaign(c, { root }).complete, true);
  write(root, p.artifact, { ...aggregate, controlLedgers: [] });
  assert.match(checkCampaign(c, { root }).errors.join("\n"), /requires its actual runner ledgers/);
  write(root, p.artifact, aggregate);
  write(root, ledgerPath, { ...ledger, ok: false });
  assert.match(checkCampaign(c, { root }).errors.join("\n"), /runner ledger is incomplete/);
  write(root, ledgerPath, { ...ledger, controls: [{ ...ledger.controls[0], red: { invocationDir: "e2e/.out/wrong" } }] });
  assert.match(checkCampaign(c, { root }).errors.join("\n"), /does not establish the recorded pair/);
  write(root, ledgerPath, ledger);
  cell.controlSets.push("controls-missing");
  assert.match(checkCampaign(c, { root }).errors.join("\n"), /completed sets differ from the frozen control inventory/);
  cell.controlSets.pop();
  write(root, p.artifact, { ...aggregate, tests: 2, controlSets: ["controls-synthetic", "controls-synthetic"] });
  assert.match(checkCampaign(c, { root }).errors.join("\n"), /duplicate control sets/);
  write(root, p.artifact, { ...aggregate, controlSets: ["controls-unproved"] });
  assert.match(checkCampaign(c, { root }).errors.join("\n"), /control command names an unproved set/);
});


test("expanded concurrency witnesses satisfy canonical affected cases without changing proof identity", (t) => {
  const { c, root, positive, negative, report, rewrite } = fixture(t);
  const scenario = "e2e/specs/concurrency/proof.spec.mjs::same scenario";
  const item = c.items.find((i) => i.id === "S3");
  item.resolution = { kind: "fixed", reason: "Synthetic concurrency repair", spec: "SPEC §16", proofs: [positive.id], controls: ["control"] };
  item.requiredCases = [{ caseId: scenario, n: 5 }];
  const setIdentity = (caseId, n, trial) => {
    for (const p of [positive, negative]) Object.assign(p, { caseId, n, trial });
    const [file, name] = caseId.split("::");
    const row = { ...report.cases[0], id: caseId, file, name, n, trial };
    const invocation = { ...report.invocation, plan: [{ tier: report.invocation.suite, files: [file] }] };
    rewrite({ ...report, invocation, cases: [row] });
    writeFileSync(join(root, dirname(positive.artifact), "results-final.jsonl"), JSON.stringify(row) + "\n");
    write(root, `${dirname(positive.artifact)}/invocation.json`, { ...invocation, endedAt: "2026-10-15T01:01:01Z", exit: 0, interrupted: null, stackDown: null });
    write(root, negative.artifact, { ...report, runId: negative.runId, cases: [{ ...row, status: "fail", error: "intended synthetic assertion" }] });
  };
  setIdentity(`${scenario} [N=5] #3`, 5, 3);
  assert.deepEqual(checkCampaign(c, { root }).errors, [], "a real expanded case proves its canonical scenario and N");
  assert.equal(positive.caseId, `${scenario} [N=5] #3`, "proof retains the exact artifact identity");
  for (const [id, n, trial] of [
    [`${scenario} [N=2] #3`, 5, 3],
    [`${scenario} [N=2] #3`, 2, 3],
    [`${scenario} [N=5] #2`, 5, 3],
    [`${scenario} [N=5]`, 5, 3],
    [`${scenario} [N=5] #3`, 2, 3],
    [`${scenario} other [N=5] #3`, 5, 3],
  ]) {
    setIdentity(id, n, trial);
    assert.match(checkCampaign(c, { root }).errors.join("\n"), /S3: missing affected case/, `contradictory or unrelated witness ${id}/${n}/${trial} must not match`);
  }
  setIdentity(`${scenario} [N=5]`, 5, 1);
  assert.deepEqual(checkCampaign(c, { root }).errors, [], "a single-trial expansion matches without a trial suffix");
});

function limitFixture(t) {
  const f = fixture(t), cell = f.c.acceptance.requirements.find(r => r.id === "concurrency-natural-n20");
  const proof = f.c.proofs.find(p => p.id === cell.proofs[0]), report = JSON.parse(readFileSync(join(f.root, proof.artifact)));
  const file = "e2e/specs/concurrency/c13-feedback.spec.mjs";
  report.mergedAt = "2026-10-15T10:00:00.000Z";
  report.invocation.capabilities = [...new Set([...report.invocation.capabilities, "local", "logs", "mailpit"])];
  report.cases = [];
  const metrics = [];
  for (let trial = 1; trial <= 3; trial++) {
    const suffix = ` [N=20]${trial === 1 ? "" : ` #${trial}`}`;
    const name = C15_WORK + suffix;
    report.cases.push({ id: `${file}::${name}`, file, name, n: 20, trial, status: "pass", error: null });
    report.cases.push({ id: `${file}::${C15_JUDGE}${suffix}`, file, name: C15_JUDGE + suffix, n: 20, trial, status: "inconclusive", error: null, inconclusive: "the sync precondition did not hold: no two onCommentCreated runs overlapped while C15 ran (10 run(s), peak 1 at once; 1 Firestore trigger(s) of any kind at once, while the HTTP functions reached 4; 0 failure line(s)), so claimCommentCooldown's transaction was never contended: I11 held in sequence, not in a race" });
    metrics.push({ ref: "C15", case: name, n: 20, trial, naturalAttempts: [1, 2, 3].map(attempt => ({ attempt, outcome: "window-missed", diagnostic: { triggerRuns: { exact: true, peak: { onCommentCreated: 1 }, runs: { onCommentCreated: 10 }, failed: 0, open: {} } } })) });
  }
  const stackPath = `e2e/.out/${proof.runId}/stack.json`, stack = JSON.parse(readFileSync(join(f.root, stackPath)));
  stack.toolchain = { firebase: { version: PIN.firebase } }; write(f.root, stackPath, stack);
  const probePath = "e2e/.out/local-limit/probe.json";
  const probe = { schemaVersion: 1, kind: "unsupported-local-trigger-overlap", toolchain: { ...PIN }, structure: { core: 0, maximum: 4, queue: "unbounded LinkedBlockingQueue", delivery: "blocking HttpRequest.execute" }, behavior: { installedConfiguration: { core: 0, maximum: 4, active: 1, queued: 3 }, counterfactualCoreFour: { core: 4, maximum: 4, active: 4, queued: 0 } }, source: { revision: sha, version, fingerprint }, command: "node tools/e2e-campaign-evidence.mjs capture-local-limit", observedAt: "2026-10-15T11:00:00.000Z" };
  report.invocation.runId = proof.runId;
  const completed = { ...structuredClone(report.invocation), endedAt: "2026-10-15T10:00:01.000Z", exit: 3, interrupted: null, stackDown: null };
  function flush() {
    write(f.root, proof.artifact, report); write(f.root, probePath, probe);
    write(f.root, `${dirname(proof.artifact)}/invocation.json`, completed);
    writeFileSync(join(f.root, dirname(proof.artifact), "c13-feedback.jsonl"), metrics.map(r => JSON.stringify(r)).join("\n") + "\n");
    proof.outcome = "LOCAL-LIMIT"; proof.localLimit = localLimitReference(f.root, probePath, proof.artifact);
  }
  flush();
  return { ...f, cell, proof, report, probe, probePath, metrics, stack, completed, flush };
}

test("a pinned local limit preserves raw INC cases and full completion remains false", t => {
  const f = limitFixture(t), result = checkCampaign(f.c, { root: f.root });
  assert.deepEqual(result.errors, []);
  assert.equal(result.localComplete, true);
  assert.equal(result.complete, false);
  assert.equal(result.unresolvedDeploymentWitnesses.length, 1);
  assert.equal(result.unresolvedDeploymentWitnesses[0].cases.length, 3);
  assert.ok(f.report.cases.filter(c => c.name.startsWith(C15_JUDGE)).every(c => c.status === "inconclusive"));
  const imported = importRun(f.c, f.proof.artifact, { root: f.root, cellId: f.cell.id, localLimitArtifact: f.probePath });
  const run = imported.candidate.proofs.find(p => p.id === `run-${f.proof.runId}-${f.proof.invocation}`);
  assert.equal(run.outcome, "LOCAL-LIMIT");
  assert.equal(run.localLimit.observations.length, 3);
  assert.equal(imported.importedCases, 3, "only ordinary work PASS cases become case proofs");
  assert.equal(imported.unfinished.length, 3, "the original incomplete cases remain reported");
});

test("local limits reject arbitrary INC, unrelated cases and failed ordinary assertions", t => {
  const f = limitFixture(t), clean = structuredClone(f.report);
  for (const mutate of [
    r => { r.cases[1].inconclusive = "server timed out"; },
    r => { r.cases[1].id = r.cases[1].id.replace("C15 I11", "C14 I11"); r.cases[1].name = r.cases[1].name.replace("C15 I11", "C14 I11"); },
    r => { r.cases[0].status = "fail"; r.cases[0].error = "I11 duplicate email"; },
    r => { r.cases[1].todo = "known bug"; },
    r => { r.cases.push({ ...r.cases[1], id: "unrelated", name: "unrelated" }); },
  ]) {
    Object.assign(f.report, structuredClone(clean)); mutate(f.report); f.flush();
    assert.equal(checkCampaign(f.c, { root: f.root }).localComplete, false);
    assert.throws(() => importRun(f.c, f.proof.artifact, { root: f.root, cellId: f.cell.id, localLimitArtifact: f.probePath }));
  }
});

test("local limits reject colliding case keys and inconsistent report identities", t => {
  const f = limitFixture(t), clean = structuredClone(f.report);
  for (const mutate of [
    r => { r.cases.push({ ...r.cases[1], file: "e2e/specs/concurrency/other.spec.mjs", status: "fail", error: "unrelated product failure", inconclusive: null }); },
    r => { r.cases[1].name = "unrelated observer"; },
    r => { const row = { ...r.cases[0], id: "other.spec.mjs::another passing observer", file: "other.spec.mjs", name: "another passing observer" }; r.cases.push(row, { ...row }); },

    r => { r.cases.push({ ...r.cases[1], status: "fail", error: "duplicate judge failure", inconclusive: null }); },
  ]) {
    Object.assign(f.report, structuredClone(clean)); mutate(f.report); f.flush();
    assert.equal(checkCampaign(f.c, { root: f.root }).localComplete, false);
    assert.throws(() => importRun(f.c, f.proof.artifact, { root: f.root, cellId: f.cell.id, localLimitArtifact: f.probePath }));
  }
});

test("local limitation proof is pinned to versions, bytes, frozen source and a completed run", t => {
  const f = limitFixture(t), clean = structuredClone(f.probe);
  for (const mutate of [
    p => { p.toolchain.firebase = "different"; }, p => { p.toolchain.firestore = "different"; }, p => { p.toolchain.sha256 = "0".repeat(64); },
    p => { p.source.revision = "b".repeat(40); }, p => { p.source.version = "old"; }, p => { p.source.fingerprint = "0".repeat(64); },
    p => { p.observedAt = "2026-10-15T09:00:00.000Z"; }, p => { p.behavior.installedConfiguration.active = 4; },
  ]) {
    Object.assign(f.probe, structuredClone(clean)); mutate(f.probe); f.flush();
    assert.equal(checkCampaign(f.c, { root: f.root }).localComplete, false);
  }
});

test("local limitation requires every N/trial axis, capabilities and exact retained attempts", t => {
  const f = limitFixture(t), report = structuredClone(f.report), metrics = structuredClone(f.metrics);
  for (const mutate of [
    () => f.report.cases.pop(), () => { f.report.invocation.n = [10]; }, () => { f.report.invocation.capabilities = []; },
    () => { f.report.invocation.trials = 1; }, () => { f.metrics[0].naturalAttempts.pop(); },
    () => { f.metrics[0].naturalAttempts[0].diagnostic.triggerRuns.exact = false; },
    () => { f.metrics[0].naturalAttempts[0].diagnostic.triggerRuns.peak.onCommentCreated = 2; },
    () => { f.metrics[0].naturalAttempts[0].diagnostic.triggerRuns.failed = 1; },
  ]) {
    Object.assign(f.report, structuredClone(report)); f.metrics.splice(0, f.metrics.length, ...structuredClone(metrics)); mutate(); f.flush();
    assert.equal(checkCampaign(f.c, { root: f.root }).localComplete, false);
  }
});

test("local limitation artifacts and exact observation references cannot be substituted", t => {
  const f = limitFixture(t);
  f.proof.localLimit.observations = ["another case"];
  assert.match(checkCampaign(f.c, { root: f.root }).errors.join("\n"), /observation identities/);
  f.flush(); writeFileSync(join(f.root, f.probePath), "{}");
  assert.match(checkCampaign(f.c, { root: f.root }).errors.join("\n"), /digest differs/);
  f.flush(); writeFileSync(join(f.root, f.proof.localLimit.measurements.artifact), "{}\n");
  assert.match(checkCampaign(f.c, { root: f.root }).errors.join("\n"), /digest differs/);
});

test("local limits reject partial, interrupted or mismatched invocation completion", t => {
  const f = limitFixture(t), clean = structuredClone(f.completed);
  for (const mutate of [
    c => { delete c.endedAt; }, c => { c.exit = 0; }, c => { c.exit = 1; },
    c => { c.interrupted = "SIGTERM"; }, c => { c.stackDown = "gone"; },
    c => { c.endedAt = "2026-10-15T12:00:00.000Z"; }, c => { c.n = [2]; },
  ]) {
    Object.assign(f.completed, structuredClone(clean)); mutate(f.completed); f.flush();
    assert.equal(checkCampaign(f.c, { root: f.root }).localComplete, false);
  }
});

test("capturing a local boundary runs the probe and refuses source changes", async t => {
  const f = limitFixture(t), source = { revision: sha, version, fingerprint }; let calls = 0;
  const captured = await captureLocalLimit(f.c, "e2e/.out/captured-limit.json", { root: f.root, snapshot: () => source, probe: async () => { calls++; return f.probe; } });
  assert.equal(calls, 1); assert.deepEqual(captured.source, source);
  let reads = 0;
  await assert.rejects(captureLocalLimit(f.c, "e2e/.out/changed-limit.json", { root: f.root, snapshot: () => ++reads === 1 ? source : { ...source, fingerprint: "changed" }, probe: async () => f.probe }), /source changed/);
  await assert.rejects(captureLocalLimit(f.c, "e2e/.out/stale-limit.json", { root: f.root, snapshot: () => ({ ...source, version: "old" }), probe: async () => f.probe }), /source version differs/);
});

test("a matrix cell cannot use unselected N rows as execution proof", t => {
  const f = fixture(t), cell = f.c.acceptance.requirements.find(r => r.id === "concurrency-natural-n20"), proof = f.c.proofs.find(p => p.id === cell.proofs[0]);
  const report = JSON.parse(readFileSync(join(f.root, proof.artifact))); report.invocation.n = [2];
  write(f.root, proof.artifact, report);
  const completion = JSON.parse(readFileSync(join(f.root, dirname(proof.artifact), "invocation.json")));
  write(f.root, `${dirname(proof.artifact)}/invocation.json`, { ...completion, n: [2] });
  assert.match(checkCampaign(f.c, { root: f.root }).errors.join("\n"), /N=20 was not executed/);
  assert.throws(() => importRun(f.c, proof.artifact, { root: f.root, cellId: cell.id }), /matrix N differs/);
});


test("the new thumbnail authority cell preserves its N2 default trials and cannot be removed", () => {
  const id = "concurrency-thumb-authority-n2";
  const cell = imported.acceptance.requirements.find(r => r.id === id);
  assert.ok(cell, "thumbnail authority matrix cell is required");
  assert.equal(cell.n, 2);
  assert.equal(cell.planTrials, true);
  assert.equal(cell.spec, "c17-identity.spec.mjs");
  assert.deepEqual(cell.options.patches, ["amplify-thumb-authority"]);
  assert.ok(cell.capabilities.includes("patch:amplify-thumb-authority"));
  const c = structuredClone(imported);
  c.acceptance.requirements = c.acceptance.requirements.filter(r => r.id !== id);
  assert.ok(checkCampaign(c, { validateOnly: true }).errors.includes(`retain matrix requirement ${id}`), "removing thumbnail authority must invalidate the matrix");
});

for (const [id, spec, patch] of [
  ["postcommit-projection-failure", "a12-versions.spec.mjs", "a12-projection-unavailable"],
  ["native-ack-endpoints", "a12-versions.spec.mjs", "amplify-native-ack-loss"],
  ["native-ack-operators", "a12-operator-ack.spec.mjs", "amplify-native-ack-loss"],
]) test(`${id} keeps its complete spec and required fault capability`, () => {
  const cell = imported.acceptance.requirements.find(r => r.id === id);
  assert.ok(cell, `${id}: matrix cell is required`);
  assert.equal(cell.suite, "functional");
  assert.equal(cell.spec, spec);
  assert.deepEqual(cell.options.patches, [patch]);
  assert.deepEqual(cell.capabilities, ["gates", `patch:${patch}`]);
  assert.equal(cell.command, `node e2e/run.mjs run --suite functional --spec ${spec} --patches ${patch}`);
  const c = structuredClone(imported);
  c.acceptance.requirements = c.acceptance.requirements.filter(r => r.id !== id);
  assert.ok(checkCampaign(c, { validateOnly: true }).errors.includes(`retain matrix requirement ${id}`), `${id}: removing the variant must invalidate the matrix`);
});
