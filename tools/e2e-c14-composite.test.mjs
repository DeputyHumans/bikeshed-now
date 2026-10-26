// SPDX-License-Identifier: Apache-2.0
// Challenge every positive axis, measurement, completion and control binding of the C14 local safety assessment (SPEC §12, §19).
import { attachRtdbFixture } from "./e2e-rtdb-test-fixture.mjs";
import { syntheticCampaignTemplate } from './e2e-test-campaign.mjs';
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PLAN_TRIALS } from "../e2e/lib/budget.mjs";
import { captureComposite, compositeReference, verifyCompositeArtifact, verifyComposite, COMPOSITE_ITEM, C14_FILE, C14_CASES, C14_CONTROLS } from "./e2e-c14-composite.mjs";
import { captureCompositeEvidence, importRun, importPartitions } from "./e2e-campaign-evidence.mjs";
import { verifyPartitions, partitionCellDigest, partitionDigest } from "./e2e-partitions.mjs";
import { checkCampaign } from "./check-e2e-campaign.mjs";
import { C15_WORK, C15_JUDGE } from "./e2e-local-limit.mjs";
import { PIN } from "./probe-e2e-trigger-queue.mjs";
import { cloudQualificationFixture } from "./e2e-cloud-qualification-fixture.mjs";

const source = { revision: "a".repeat(40), version: "0.1.0", fingerprint: "f".repeat(64) };
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const refusal = "Resolve all comments before publishing a new version.";
const newer = "This document has a newer version. Reload, then suggest the edit on it.";
const original = syntheticCampaignTemplate(JSON.parse(readFileSync(new URL("../e2e/campaign.json", import.meta.url))));
const write = (root, file, value) => { mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), typeof value === "string" ? value : JSON.stringify(value, null, 2) + "\n"); };
const rowCase = (name, n, trial, status = "pass", extra = {}) => { const full = `${name} [N=${n}] #${trial}`; return { id: `${C14_FILE}::${full}`, name: full, file: C14_FILE, n, trial, status, at: "2026-10-15T01:30:00.000Z", ...extra }; };
const snapshot = doc => ({ currentVersion: "v1", liveEpoch: { present: true, value: "initial" }, draft: { entry: "index.html", storagePrefix: `docs/${doc}/draft/one` }, versions: [{ id: "v1", metadata: { entry: "index.html" }, objects: [{ key: `docs/${doc}/v1/index.html`, size: 3, sha256: "1".repeat(64) }] }], draftObjects: [{ key: `docs/${doc}/draft/one/index.html`, size: 4, sha256: "2".repeat(64) }] });
function measured(kind, n, trial, doc, caseName, attempt = 1) {
  const won = kind === "comment-held" || kind === "suggestion-held", before = snapshot(doc), after = structuredClone(before);
  if (won) { after.currentVersion = "v2"; after.draft = null; after.draftObjects = []; after.versions.push({ id: "v2", metadata: { entry: "index.html" }, objects: [{ key: `docs/${doc}/v2/index.html`, size: 4, sha256: "2".repeat(64) }] }); }
  const answers = [], threads = [];
  const add = (i, web) => { if (web && won) { answers.push({ who: `web${i}`, what: "web thread", status: 200, isError: true, text: "PERMISSION_DENIED" }); return; } const id = `${doc}-${web ? "web" : "agent"}-${i}`, version = web || !won ? "v1" : "v2", anchor = { elementId: `p${i}`, exact: `passage ${i}` }; answers.push({ who: `${web ? "web" : "agent"}${i}`, what: web ? "web thread" : kind === "natural" && i % 2 ? "suggest_edit" : "add_comment", status: 200, isError: false, text: "created", json: { threadId: id, version, ...(web ? { expectedAnchor: anchor, expectedBody: "body" } : {}) } }); threads.push({ annId: id, version, kind: "comment", channel: web ? "web" : "mcp", open: true, anchor, bodies: web ? ["body"] : [] }); };
  if (kind === "suggestion-held") for (let i = 0; i < n; i++) answers.push({ who: `agent${i}`, what: "suggest_edit", status: 200, isError: true, text: newer, json: null });
  else if (kind === "natural") { for (let i = 0; i < n; i++) add(i, false); for (let i = 0; i < n; i++) add(i, true); }
  else for (let i = 0; i < n; i++) add(i, kind === "commit-held-web");
  return { ref: "C14 composite", schemaVersion: 1, n, trial, case: caseName, kind, docId: doc, attempt, outcome: won ? "published" : "refused", judged: true, before, after, commit: { who: "publisher", what: "commit_draft", status: 200, isError: !won, text: won ? "published" : refusal, json: won ? { versionId: "v2" } : null, ...(won ? { currentWhileHeld: "v2" } : {}) }, state: { current: won ? "v2" : "v1", versions: won ? ["v1", "v2"] : ["v1"], hasDraft: !won, threads }, answers, race: kind === "natural" ? { kind: "sync-t", spreadMs: 0, overlapMarginMs: 20 } : { kind: "gate", gate: kind === "comment-held" ? "comment-before-write" : kind === "suggestion-held" ? "suggest-after-count" : "commit-before-tx", held: kind.startsWith("commit-held") ? 1 : n, released: kind.startsWith("commit-held") ? 1 : n } };
}
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "c14-composite-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const campaign = structuredClone(original); campaign.acceptance.requirements.push(...campaign.acceptance.deferredRequirements); delete campaign.acceptance.concurrencyScope; delete campaign.acceptance.deferredRequirements; campaign.proofs = []; campaign.controls = []; Object.assign(campaign.acceptance, source, { tree: "worktree" });
  campaign.acceptance.requirements.forEach(r => { r.proofs = []; if (r.id === "controls") r.controlSets = []; });
  const item = campaign.items.find(i => i.id === COMPOSITE_ITEM); item.state = "in-progress";
  const manifest = { natural: [], forced: [], controlLedgers: ["e2e/.out/control-ledger.json"] }, runs = [];
  const stack = patches => ({ fingerprint: { baseSha: source.revision, sha256: source.fingerprint, dirty: true }, expectVersion: source.version, patches });
  for (const axis of ["natural", "forced"]) for (const n of [2, 5, 10, 20]) {
    const id = `${axis}-${n}`, path = `e2e/.out/${id}/invocations/i/results.json`, dir = dirname(path), cases = [], rows = [];
    for (let trial = 1; trial <= PLAN_TRIALS[n]; trial++) {
      const work = rowCase(C14_CASES.natural, n, trial); cases.push(work, rowCase(C14_CASES.conditional, n, trial, "inconclusive", { inconclusive: `the commit was refused (${refusal}): feedback reached v1 first, so no version replaced v1 in this race and nothing could be left behind on it` }), rowCase(C14_CASES.browser, n, trial));
      const attempts = [];
      for (let attempt = 1; attempt <= 3; attempt++) { const row = measured("natural", n, trial, `${id}-${trial}-${attempt}`, work.name, attempt); rows.push(row); attempts.push({ attempt, outcome: "window-missed", diagnostic: { state: row.state, answers: row.answers, commit: row.commit, published: false } }); rows.push({ ref: "request burst", n, trial, case: work.name, label: "feedback and commit", timing: Array.from({ length: 2 * n + 1 }, (_, i) => ({ i, who: [...row.answers, row.commit][i].who, what: [...row.answers, row.commit][i].what, status: 200, error: null, firedAt: 100, sentAt: 101, firstByteAt: 121, endAt: 122 })), overlap: { ok: true } }); rows.push({ ref: "C14 SYNC-T", n, trial, case: work.name, naturalAttempts: structuredClone(attempts) }); }
      if (axis === "forced") for (const kind of ["comment-held", "suggestion-held", "commit-held-agent", "commit-held-web"]) { const c = rowCase(C14_CASES[kind], n, trial); cases.push(c); rows.push(measured(kind, n, trial, `${id}-${trial}-${kind}`, c.name)); }
    }
    const invocation = { id: "i", runId: id, suite: "concurrency", spec: axis === "natural" ? [] : ["c13-feedback"], grep: null, trials: null, n: [n], capabilities: ["local", "storage-preconditions", "rtdb-proxy", ...(axis === "forced" ? ["gates", "patch:amplify-c13-feedback"] : [])], plan: [{ tier: "concurrency", files: [C14_FILE] }], startedAt: "2026-10-15T01:00:00Z" };
    const report = { runId: id, invocation, cases, malformed: [], mergedAt: "2026-10-15T02:00:00Z" }, done = { ...invocation, endedAt: "2026-10-15T02:00:01Z", exit: 3, interrupted: null, stackDown: null };
    const run = { axis, n, path, dir, report, done, rows }; runs.push(run); manifest[axis].push(path);
    write(root, `e2e/.out/${id}/stack.json`, stack(axis === "natural" ? [] : ["amplify-c08-mint-races", "amplify-c13-feedback"]));
  }
  const saveRun = run => { write(root, run.path, run.report); write(root, `${run.dir}/invocation.json`, run.done); write(root, `${run.dir}/results-concurrency.jsonl`, run.report.cases.map(c => JSON.stringify(c)).join("\n") + "\n"); write(root, `${run.dir}/c13-feedback.jsonl`, run.rows.map(c => JSON.stringify(c)).join("\n") + "\n"); };
  runs.forEach(saveRun);
  for (const run of runs) { const prepared = attachRtdbFixture(root, { campaign, rel: run.path, report: run.report, done: run.done }); Object.assign(run.done, prepared.done); }
  runs.forEach(saveRun);
  const ledger = { ok: true, endedAt: "2026-10-15T02:00:01Z", commit: source.revision, tree: source.revision, controls: [], green: [] };
  for (const set of C14_CONTROLS) {
    const targetName = `Synthetic exact ${set} [N=2]`, c = { id: `${C14_FILE}::${targetName}`, name: targetName, file: C14_FILE, n: 2, trial: 1, status: "pass" };
    write(root, `e2e/patches/${set}/control.json`, { oracle: "synthetic fixture only", what: set, target: { spec: C14_FILE, suite: "concurrency", case: targetName }, stack: [], expect: { message: `^intended ${set}$` } }); write(root, `e2e/patches/${set}/mutant.patch`, "synthetic fixture only\n");
    const control = { id: set, set, mutation: "synthetic fixture only", assertion: `intended ${set}` };
    for (const color of ["red", "green"]) {
      const id = `${set}-${color}`, dir = `e2e/.out/${id}/invocations/i`, path = `${dir}/results.json`, proof = { ...source, id, kind: "e2e-case", outcome: color === "red" ? "FAIL" : "PASS", artifact: path, runId: id, invocation: "i", caseId: c.id, n: 2, trial: 1 };
      write(root, path, { runId: id, invocation: { id: "i" }, malformed: [], cases: [{ ...c, ...(color === "red" ? { status: "fail", error: { message: control.assertion } } : {}) }] }); write(root, `e2e/.out/${id}/stack.json`, stack(color === "red" ? [set] : [])); campaign.proofs.push(proof); control[color] = id;
    }
    for (const color of ["red", "green"]) attachRtdbFixture(root, { campaign, rel: `e2e/.out/${set}-${color}/invocations/i/results.json` });
    campaign.controls.push(control); ledger.controls.push({ set, ok: true, red: { invocationDir: `e2e/.out/${set}-red/invocations/i` } }); ledger.green.push({ sets: [set], invocationDir: `e2e/.out/${set}-green/invocations/i` });
  }
  write(root, manifest.controlLedgers[0], ledger);
  const capture = () => captureComposite(campaign, manifest, { root, source, observedAt: "2026-10-15T03:00:00Z" });
  return { root, campaign, manifest, runs, saveRun, capture, ledger };
}

test("all original positive N/trials and actual control pairs qualify separately from the raw natural observation", t => {
  const f = fixture(t), artifact = f.capture(), result = verifyCompositeArtifact(f.campaign, artifact, { root: f.root });
  assert.equal(result.axes.length, 42); assert.equal(result.observations.length, 42); assert.ok(result.axes.every(a => !a.naturalPublisherFirstObserved));
  assert.equal(f.campaign.items.find(i => i.id === COMPOSITE_ITEM).state, "in-progress");
  assert.ok(f.runs.every(run => run.report.cases.some(c => c.status === "inconclusive")));
});

for (const [label, change, message] of [
  ["missing N", f => f.manifest.natural.pop(), /all scoped natural/],
  ["duplicate N", f => f.manifest.forced[3] = f.manifest.forced[2], /all scoped natural/],
  ["missing trial", f => { f.runs[0].report.cases.pop(); }, /missing\/duplicate/],
  ["authoring trial override", f => { f.runs[0].report.invocation.trials = f.runs[0].done.trials = 1; }, /authoring/],
  ["wrong forced patch order", f => { const path = "e2e/.out/forced-2/stack.json", stack = JSON.parse(readFileSync(join(f.root, path))); stack.patches.reverse(); write(f.root, path, stack); }, /wrong positive patch/],
  ["filter", f => { f.runs[0].report.invocation.grep = f.runs[0].done.grep = "one"; }, /authoring/],
  ["interrupted run", f => { f.runs[0].done.interrupted = "SIGINT"; }, /did not finish/],
  ["missing end", f => { delete f.runs[0].done.endedAt; }, /end is absent/],
  ["mixed browser callers omitted", f => { f.runs[0].rows[0].answers[2].what = "add_comment"; }, /request kinds differ/],
  ["transport failure", f => { f.runs[0].rows[0].answers[0].status = 500; }, /transport failure/],
  ["duplicate caller", f => { f.runs[0].rows[0].answers[0].who = f.runs[0].rows[0].answers[1].who; }, /omit a caller/],
  ["another request timing", f => { f.runs[0].rows[1].timing[0].who = "not-the-caller"; }, /different requests/],
  ["different state versions", f => { f.runs[0].rows[0].state.versions = ["v1", "v2"]; }, /version inventories differ/],
  ["different draft state", f => { f.runs[0].rows[0].state.hasDraft = false; }, /draft presence differs/],
  ["generic refusal", f => { f.runs[0].rows[0].commit.text = "server failed"; }, /generic error/],
  ["truncated refusal", f => { f.runs[0].rows[0].commit.text = "1 suggested edit is waiting for a decision."; }, /generic error/],
  ["metadata-only proof", f => { f.runs[0].rows[0].before.draftObjects = []; }, /actual draft entry bytes/],
  ["lost draft bytes", f => { f.runs[0].rows[0].after.draftObjects[0].sha256 = "3".repeat(64); }, /exact draft object bytes/],
  ["lost version metadata", f => { f.runs[0].rows[0].after.versions[0].metadata.entry = "different.html"; }, /exact metadata/],
  ["unrelated INC", f => { f.runs[0].report.cases[1].inconclusive = "no browser joined"; }, /unrelated incomplete/],
  ["relabel natural INC", f => { f.runs[0].report.cases[1] = { ...f.runs[0].report.cases[1], status: "pass", inconclusive: null }; }, /unrelated incomplete/],
  ["one omitted attempt", f => { f.runs[0].rows.splice(0, 1); }, /attempts are missing/],
  ["snapshot from another document", f => { f.runs[0].rows[3].docId = f.runs[0].rows[0].docId; }, /object inventory/],
  ["missing attempt prefix", f => { f.runs[0].rows.splice(2, 1); }, /per-attempt diagnostics/],
  ["changed attempt prefix", f => { f.runs[0].rows[2].naturalAttempts[0].diagnostic.commit.text = "invented"; }, /cumulative attempt diagnostics/],
  ["wide launch spread", f => { f.runs[0].rows[0].race.spreadMs = 16; }, /did not actually overlap/],
  ["missing request timing", f => { f.runs[0].rows[1].timing.pop(); }, /timing inventory/],
  ["invented overlap", f => { f.runs[0].rows[1].timing[0].sentAt = 121; }, /simultaneous overlap/],
  ["missing forced v2", f => { f.runs[4].rows.find(r => r.kind === "comment-held").commit.currentWhileHeld = "v1"; }, /v2 was not observed/],
  ["early refusal substituted", f => { f.runs[4].rows.find(r => r.kind === "commit-held-agent").race.gate = "before-upload"; }, /wrong gate/],
  ["missing held caller", f => { f.runs[4].rows.find(r => r.kind === "suggestion-held").race.held = 1; }, /wrong gate/],
  ["stale source", f => { f.campaign.acceptance.version = "different"; }, /source derivation: version differs/],
  ["original scope removed", f => { f.campaign.items.find(i => i.id === COMPOSITE_ITEM).requiredCases.pop(); }, /every original/],
  ["original item closed", f => { f.campaign.items.find(i => i.id === COMPOSITE_ITEM).state = "resolved"; }, /must remain in-progress/],
  ["missing control", f => { f.campaign.controls.pop(); }, /missing imported control/],
  ["capture before control completion", f => { f.ledger.endedAt = "2026-10-15T04:00:00Z"; write(f.root, f.manifest.controlLedgers[0], f.ledger); }, /unfinished or uses another source/],
  ["invalid control ledger", f => { f.ledger.controls[0].ok = false; write(f.root, f.manifest.controlLedgers[0], f.ledger); }, /missing, duplicated or invalid/],
]) test(`composite rejects ${label}`, t => { const f = fixture(t); change(f); f.runs.forEach(f.saveRun); assert.throws(f.capture, message); });

test("bound digests, complete final records and precise control errors cannot be substituted", t => {
  const f = fixture(t), artifact = f.capture(), first = artifact.runs[0];
  writeFileSync(join(f.root, first.measurements.artifact), "changed");
  assert.throws(() => verifyCompositeArtifact(f.campaign, artifact, { root: f.root }), /digest differs/);
  f.runs.forEach(f.saveRun);
  const red = artifact.controls[0].red.report, report = JSON.parse(readFileSync(join(f.root, red.artifact))); report.cases[0].error.message = "setup timeout"; write(f.root, red.artifact, report); red.sha256 = hash(readFileSync(join(f.root, red.artifact)));
  assert.throws(() => verifyCompositeArtifact(f.campaign, artifact, { root: f.root }), /intended assertion/);
});

test("import keeps the original item and raw INC while recording only the named run assessment", t => {
  const f = fixture(t), artifact = f.capture(), path = "e2e/.out/composite.json"; write(f.root, path, artifact);
  const result = importRun(f.campaign, f.runs[0].path, { root: f.root, cellId: "concurrency-natural-n2", compositeArtifact: path });
  const proof = result.candidate.proofs.find(p => p.kind === "e2e-run" && p.outcome === "COMPOSITE-SAFETY"); assert.ok(proof);
  const got = verifyComposite(result.candidate, proof, { report: f.runs[0].report, stack: JSON.parse(readFileSync(join(f.root, `e2e/.out/natural-2/stack.json`))) }, { root: f.root });
  assert.equal(got.observations.length, 10); assert.equal(result.unfinished.length, 10);
  assert.deepEqual(result.candidate.items, f.campaign.items);
  assert.ok(!result.candidate.proofs.some(p => p.kind === "e2e-case" && p.caseId?.includes(C14_CASES.conditional)));
  assert.throws(() => importRun(f.campaign, f.runs[0].path, { root: f.root, cellId: "concurrency-natural-n2" }), /failed or unjudged/);
});


// Fill unrelated cells with deliberately synthetic evidence solely to test the
// completion boundary. These artifacts never leave the temporary directory.
function finishOtherObligations(f) {
  const c = f.campaign;
  for (const cell of c.acceptance.requirements) {
    if (/^concurrency-(?:natural|c13)-n/.test(cell.id)) continue;
    const id = `synthetic-${cell.id}`, artifact = `e2e/.out/${id}/results.json`;
    const p = { ...source, id, kind: cell.kind, artifact, outcome: "PASS" };
    if (cell.kind === "command") {
      const log = `${artifact}.log`, text = `# tests 1\n# pass 1\n# fail 0\n# skipped 0\n# todo 0\n# cancelled 0\n`;
      write(f.root, log, text); write(f.root, artifact, { ...source, command: cell.command, outcome: "PASS", exitCode: 0, tests: 1, fail: 0, skip: 0, todo: 0, inconclusive: 0, log }); Object.assign(p, { command: cell.command, logSha256: hash(text) });
    } else {
      const file = `e2e/specs/${cell.suite}/${cell.spec ?? "synthetic.spec.mjs"}`, name = "synthetic assertion";
      const cases = [{ file, name, id: `${file}::${name}`, status: "pass", n: cell.n ?? null, trial: 1 }];
      const invocation = { id: "i", runId: id, suite: cell.suite, spec: cell.spec ? [cell.spec] : [], n: cell.n ? [cell.n] : null, trials: null, grep: null, capabilities: cell.capabilities ?? [], plan: [{ tier: cell.suite, files: [file] }], startedAt: "2026-10-15T01:00:00Z" };
      write(f.root, artifact, { runId: id, invocation, mergedAt: "2026-10-15T02:00:00Z", malformed: [], cases });
      write(f.root, `${dirname(artifact)}/invocation.json`, { ...invocation, endedAt: "2026-10-15T02:00:01Z", exit: 0, interrupted: null, stackDown: null });
      write(f.root, `${dirname(artifact)}/results-final.jsonl`, cases.map(row => JSON.stringify(row)).join("\n") + "\n");
      write(f.root, `e2e/.out/${id}/stack.json`, { fingerprint: { baseSha: source.revision, sha256: source.fingerprint }, expectVersion: source.version, patches: cell.options?.patches ?? [], options: { emailOff: cell.options?.emailOff ?? false, appEnv: { ...Object.fromEntries((cell.options?.appEnvPresent ?? []).map(k => [k, "synthetic"])), ...(cell.options?.appEnv ?? {}) } } });
      Object.assign(p, { runId: id, invocation: "i" });
    }
    if (cell.kind === "e2e-run") attachRtdbFixture(f.root, { campaign: c, rel: artifact });
    c.proofs.push(p); cell.proofs = [id];
  }
  const positive = c.controls[0].green;
  for (const item of [...c.coverage.items, ...c.items, ...c.discoveries]) {
    if (item.state === "historical-closed" || item.id === COMPOSITE_ITEM) continue;
    item.state = "resolved"; item.resolution = { kind: "refuted", reason: "Synthetic checker fixture only, never product evidence", spec: "SPEC §12", proofs: [positive], controls: [] };
  }
}
function importCompositeRuns(f, artifactPath, extra = {}) {
  for (const run of f.runs) f.campaign = importRun(f.campaign, run.path, { root: f.root, cellId: `concurrency-${run.axis === "natural" ? "natural" : "c13"}-n${run.n}`, compositeArtifact: artifactPath, ...extra }).candidate;
}

test("local acceptance can be complete while full completion and the original natural obligation stay incomplete", t => {
  const f = fixture(t); finishOtherObligations(f);
  const path = "e2e/.out/composite.json"; write(f.root, path, f.capture()); importCompositeRuns(f, path);
  const result = checkCampaign(f.campaign, { root: f.root });
  assert.deepEqual(result.errors, []); assert.equal(result.localComplete, true); assert.equal(result.complete, false);
  assert.deepEqual(result.pending, [`${COMPOSITE_ITEM}: in-progress`]); assert.deepEqual(result.localPending, []);
  assert.deepEqual(result.localAdjudications, [COMPOSITE_ITEM]); assert.equal(result.unresolvedNaturalWitnesses.length, 1);
  const cloud = cloudQualificationFixture(f.root, source.version);
  f.campaign.acceptance.raceEvidencePolicy = { mode: "controlled-with-red-green", reason: "Explicit synthetic controlled-race approval", cloud: cloud.ref, reviewedOverlays: cloud.reviewedOverlays };
  const qualified = checkCampaign(f.campaign, { root: f.root });
  assert.equal(qualified.releaseComplete, true); assert.equal(qualified.complete, false);
  assert.deepEqual(qualified.pending, result.pending);
  assert.deepEqual(qualified.unresolvedNaturalWitnesses, result.unresolvedNaturalWitnesses);
  const proof = f.campaign.proofs.find(p => p.outcome === "COMPOSITE-SAFETY"); delete proof.composite;
  const missing = checkCampaign(f.campaign, { root: f.root });
  assert.equal(missing.localComplete, false, "an outcome label cannot replace the bound assessment");
  assert.equal(missing.releaseComplete, false, "cloud evidence cannot replace the C14 assessment");
});

test("one named assessment cannot exempt another original open obligation", t => {
  const f = fixture(t); finishOtherObligations(f);
  const path = "e2e/.out/composite.json"; write(f.root, path, f.capture()); importCompositeRuns(f, path);
  f.campaign.items.find(i => i.id === "S3").state = "in-progress";
  const result = checkCampaign(f.campaign, { root: f.root });
  assert.equal(result.localComplete, false); assert.deepEqual(result.localPending, ["S3: in-progress"]);
});

test("C14 assessment and pinned C15 limitation qualify only their own raw observations in the same completed run", t => {
  const f = fixture(t); finishOtherObligations(f);
  for (const run of f.runs) {
    run.report.invocation.capabilities.push("logs", "mailpit"); run.done.capabilities = structuredClone(run.report.invocation.capabilities);
    for (let trial = 1; trial <= PLAN_TRIALS[run.n]; trial++) {
      const work = rowCase(C15_WORK, run.n, trial);
      run.report.cases.push(work, rowCase(C15_JUDGE, run.n, trial, "inconclusive", { inconclusive: "the sync precondition did not hold: no two onCommentCreated runs overlapped while C15 ran (10 run(s), peak 1 at once; 1 Firestore trigger(s) of any kind at once; 0 failure line(s)), so claimCommentCooldown's transaction was never contended" }));
      run.rows.push({ ref: "C15", case: work.name, n: run.n, trial, naturalAttempts: [1, 2, 3].map(attempt => ({ attempt, outcome: "window-missed", diagnostic: { triggerRuns: { exact: true, peak: { onCommentCreated: 1 }, runs: { onCommentCreated: 10 }, failed: 0, open: {} } } })) });
    }
    const stackPath = `e2e/.out/${run.report.runId}/stack.json`, stack = JSON.parse(readFileSync(join(f.root, stackPath))); stack.toolchain = { firebase: { version: PIN.firebase } }; write(f.root, stackPath, stack); f.saveRun(run);
  }
  const probe = "e2e/.out/local-limit.json", path = "e2e/.out/composite.json";
  write(f.root, probe, { schemaVersion: 1, kind: "unsupported-local-trigger-overlap", toolchain: PIN, structure: { core: 0, maximum: 4, queue: "unbounded LinkedBlockingQueue", delivery: "blocking HttpRequest.execute" }, behavior: { installedConfiguration: { core: 0, maximum: 4, active: 1, queued: 3 }, counterfactualCoreFour: { core: 4, maximum: 4, active: 4, queued: 0 } }, source, command: "node tools/e2e-campaign-evidence.mjs capture-local-limit", observedAt: "2026-10-15T03:00:00Z" });
  write(f.root, path, f.capture());
  assert.throws(() => importCompositeRuns(f, path), /failed or unjudged/, "the C14 artifact does not qualify a C15 INC");
  importCompositeRuns(f, path, { localLimitArtifact: probe });
  const result = checkCampaign(f.campaign, { root: f.root });
  assert.deepEqual(result.errors, []); assert.equal(result.localComplete, true); assert.equal(result.complete, false);
  assert.equal(result.unresolvedNaturalWitnesses.length, 1); assert.equal(result.unresolvedDeploymentWitnesses.length, 8);
  for (const p of f.campaign.proofs.filter(p => p.outcome === "COMPOSITE-SAFETY")) assert.ok(p.localLimit.observations.every(id => id.includes(C15_JUDGE)));
  const p = f.campaign.proofs.find(p => p.outcome === "COMPOSITE-SAFETY"); p.localLimit.observations.push("unrelated");
  assert.equal(checkCampaign(f.campaign, { root: f.root }).localComplete, false, "neither assessment can broaden the other's exact identities");
});

test("capture refuses source drift and writes only an ignored proposal after unchanged-source verification", t => {
  const f = fixture(t), path = "e2e/.out/captured-composite.json";
  const result = captureCompositeEvidence(f.campaign, f.manifest, path, { root: f.root, snapshot: () => source });
  assert.equal(result.kind, "composite-c14-serialization-safety");
  let calls = 0;
  assert.throws(() => captureCompositeEvidence(f.campaign, f.manifest, path, { root: f.root, snapshot: () => calls++ ? { ...source, fingerprint: "e".repeat(64) } : source }), /source changed/);
  assert.throws(() => captureCompositeEvidence(f.campaign, f.manifest, "e2e/campaign.json", { root: f.root, snapshot: () => source }), /proposals belong under/);
});


test("a rounded zero margin requires a genuinely positive raw wire overlap", t => {
  const f = fixture(t), run = f.runs[0];
  for (const row of run.rows) {
    if (row.kind === "natural") row.race.overlapMarginMs = 0;
    if (row.ref === "request burst") for (const request of row.timing) request.firstByteAt = 101.02;
  }
  f.saveRun(run); assert.doesNotThrow(f.capture, "strictly positive raw overlap remains valid after display rounding");
  run.rows.find(r => r.ref === "request burst").timing[0].firstByteAt = 101;
  f.saveRun(run); assert.throws(f.capture, /simultaneous overlap/);
});

function changeRuntime(f, reportPath, change) {
  const report = JSON.parse(readFileSync(join(f.root, reportPath))), ref = report.invocation.rtdbRuntime;
  const runtime = JSON.parse(readFileSync(join(f.root, ref.artifact))); change(runtime);
  write(f.root, ref.artifact, runtime); ref.sha256 = hash(readFileSync(join(f.root, ref.artifact)));
  const completionPath = `${dirname(reportPath)}/invocation.json`, done = JSON.parse(readFileSync(join(f.root, completionPath)));
  done.rtdbRuntime = structuredClone(ref); write(f.root, completionPath, done); write(f.root, reportPath, report);
}

test("composite capture independently verifies every auxiliary run and control runtime", t => {
  const f = fixture(t), path = f.runs[1].path;
  changeRuntime(f, path, runtime => { runtime.after.heapMb = 512; });
  assert.throws(f.capture, /RTDB attestation: after observed Database heap differs/, "an auxiliary positive run cannot inherit the selected run's valid JVM");
  changeRuntime(f, path, runtime => { runtime.after.heapMb = 1024; });
  const controlPath = `e2e/.out/${C14_CONTROLS[0]}-red/invocations/i/results.json`;
  changeRuntime(f, controlPath, runtime => { runtime.after.mark = "another-stack"; });
  assert.throws(f.capture, /RTDB attestation: after JVM belongs to another stack/, "each auxiliary control must prove its own runtime");
  changeRuntime(f, controlPath, runtime => { runtime.after.mark = `mark-${C14_CONTROLS[0]}-red`; });
  assert.doesNotThrow(f.capture, "restored actual byte-backed runtime fixtures qualify");
});

test("standalone composite verification finalizes its runtime artifact snapshot", t => {
  const f = fixture(t), artifact = f.capture(), controls = artifact.controls;
  const runtimePath = join(f.root, f.runs[0].report.invocation.rtdbRuntime.artifact);
  controls[Symbol.iterator] = function* () {
    for (let i = 0; i < this.length; i++) yield this[i];
    const runtime = JSON.parse(readFileSync(runtimePath)); runtime.changedAfterLastRead = true;
    writeFileSync(runtimePath, JSON.stringify(runtime));
  };
  assert.throws(() => verifyCompositeArtifact(f.campaign, artifact, { root: f.root }), /evidence changed before final acceptance/, "standalone verification cannot omit the final byte check");
});


test("complete-file partitions retain verified composite qualifications and raw inconclusive cases", t => {
  const f = fixture(t), cell = f.campaign.acceptance.requirements.find(r => r.id === "concurrency-natural-n2");
  for (const run of f.runs.filter(r => r.report.runId.startsWith("natural-"))) {
    run.report.invocation.spec = run.done.spec = [C14_FILE];
    run.report.invocation.capabilities = run.done.capabilities = [...new Set([...run.done.capabilities, ...(cell.capabilities ?? [])])];
    f.saveRun(run);
  }
  const artifact = f.capture(), compositePath = "e2e/.out/composite.json";
  write(f.root, compositePath, artifact);
  const first = artifact.runs.find(r => r.axis === "natural" && r.n === 2), path = first.report.artifact;
  const report = JSON.parse(readFileSync(join(f.root, path)));
  const inventory = [{ file: C14_FILE, sha256: "a".repeat(64), cases: report.cases.map(({id,n,trial}) => ({id,n,trial})) }];
  const manifest = { schemaVersion: 1, kind: "concurrency-partitions", cell: cell.id, source,
    requirementSha256: partitionCellDigest(cell), inventory,
    reports: [{ artifact: path, sha256: partitionDigest(readFileSync(join(f.root, path))),
      qualification: { outcome: "COMPOSITE-SAFETY", composite: compositeReference(f.root, compositePath, path) } }] };
  const check = () => verifyPartitions(f.campaign, cell, manifest, {root:f.root,inventory});
  assert.equal(check()[0].proof.outcome, "COMPOSITE-SAFETY");
  write(f.root, "e2e/.out/partitions.json", manifest);
  const imported = importPartitions(f.campaign, "e2e/.out/partitions.json", {root:f.root,inventory}).candidate;
  const proof = imported.proofs.find(p => p.partition);
  assert.equal(proof.outcome, "COMPOSITE-SAFETY");
  assert.deepEqual(proof.composite, manifest.reports[0].qualification.composite);
  assert.equal(imported.items.find(i => i.id === COMPOSITE_ITEM).state, "in-progress");
  assert.ok(JSON.parse(readFileSync(join(f.root,path))).cases.some(c=>c.status==="inconclusive"));
  manifest.reports[0].qualification.outcome="PASS";
  assert.throws(check,/unsupported partition qualification/);
  manifest.reports[0].qualification.outcome="COMPOSITE-SAFETY";
  manifest.reports[0].qualification.composite.sha256="0".repeat(64);
  assert.throws(check,/digest differs/);
});

test("approved ten-participant scope requires exactly all six lower natural and forced axes", t => {
  const f = fixture(t);
  f.campaign.acceptance.concurrencyScope = structuredClone(original.acceptance.concurrencyScope);
  f.campaign.acceptance.deferredRequirements = f.campaign.acceptance.requirements.filter(r => r.n === 20);
  f.campaign.acceptance.requirements = f.campaign.acceptance.requirements.filter(r => r.n !== 20);
  for (const axis of ['natural', 'forced']) f.manifest[axis] = f.manifest[axis].filter(p => !p.includes('-20/'));
  const artifact = captureComposite(f.campaign, f.manifest, { root: f.root, source });
  assert.equal(artifact.runs.length, 6);
  assert.ok(artifact.original.requiredCases.some(r => r.n === 20));
  artifact.runs = artifact.runs.filter(r => !(r.axis === 'forced' && r.n === 10));
  assert.throws(() => verifyCompositeArtifact(f.campaign, artifact, { root: f.root }), /all scoped natural and forced N cells/);
});
