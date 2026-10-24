// SPDX-License-Identifier: Apache-2.0
// Parallel control evidence rejects missing pairs, stale sources, wrong failures and partial workers without starting product stacks (SPEC §12).

import { EvidenceArtifacts } from "./e2e-artifact-cache.mjs";
import { attachRtdbFixture } from "./e2e-rtdb-test-fixture.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { partitionControls, finalControlSummary, validateControlWorkers, runParallelControls } from "./e2e-controls-parallel.mjs";
import { importCommand } from "./e2e-campaign-evidence.mjs";
import { readControl } from "../e2e/lib/controls.mjs";

const snapshot = { revision: "a".repeat(40), version: "0.1.0", fingerprint: "f".repeat(64), files: 4 };
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const write = (root, path, value) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), typeof value === "string" ? value : JSON.stringify(value)); };
const read = (root, path) => JSON.parse(readFileSync(join(root, path)));

function fixture(t, count = 4) {
  const root = mkdtempSync(join(tmpdir(), "controls-parallel-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sets = Array.from({ length: count }, (_, i) => `controls-synthetic-${i}`);
  const campaign = { acceptance: { ...snapshot, tree: "worktree", requirements: [{ id: "controls", kind: "command", command: "node e2e/run.mjs controls --tree worktree", controlSets: sets, proofs: [] }] }, controls: [], proofs: [] };
  const definition = (set) => ({ set, what: "restore the synthetic bug", target: { suite: "functional", spec: "e2e/specs/functional/synthetic.spec.mjs", case: set }, selection: { case: set }, expect: { message: "intended assertion" } });
  const makeWorker = (assigned, index) => {
    const id = index + 1, path = `e2e/.out/control-worker-${id}/ledger.json`;
    const rows = assigned.map((set) => {
      const def = definition(set), base = { id: `${def.target.spec}::${set}`, file: def.target.spec, name: set, n: null, trial: 1, status: "pass", error: null };
      for (const side of ["green", "red"]) {
        const runId = `${set}-${side}`;
        write(root, `e2e/.out/${runId}/stack.json`, { fingerprint: { baseSha: snapshot.revision, sha256: snapshot.fingerprint }, expectVersion: snapshot.version, patches: side === "red" ? [{ set }] : [] });
        write(root, `e2e/.out/${runId}/invocations/i/results.json`, { runId, invocation: { id: "i" }, malformed: [], cases: [{ ...base, ...(side === "red" ? { status: "fail", error: { message: "intended assertion: synthetic bug" } } : {}) }] });
        attachRtdbFixture(root, { campaign, rel: `e2e/.out/${runId}/invocations/i/results.json` });
      }
      return { set, ok: true, red: { invocationDir: `e2e/.out/${set}-red/invocations/i` } };
    });
    const ledger = { startedAt: "2026-10-15T00:00:00Z", endedAt: "2026-10-15T00:01:00Z", commit: snapshot.revision, tree: "worktree", ok: true, controls: rows, green: assigned.map((set) => ({ sets: [set], invocationDir: `e2e/.out/${set}-green/invocations/i` })) };
    write(root, path, ledger);
    const log = `e2e/.out/control-worker-${id}/command.log`, summary = { ok: true, ledger: path, controls: assigned.map((set) => ({ set, ok: true })) };
    write(root, log, `ordinary control output\n${JSON.stringify(summary, null, 2)}\n`);
    return { id, sets: assigned, finished: true, exitCode: 0, log, path, summary };
  };
  const workers = partitionControls(sets, 3).map(makeWorker);
  const options = { root, readDefinition: definition };
  return { root, sets, campaign, workers, options, definition };
}

test("partitioning is deterministic, exact once and never exceeds three ordinary workers", () => {
  const sets = ["controls-c", "controls-a", "controls-d", "controls-b"];
  assert.deepEqual(partitionControls(sets, 3), [["controls-a", "controls-d"], ["controls-b"], ["controls-c"]]);
  assert.deepEqual(partitionControls(["controls-a"], 3), [["controls-a"]]);
  for (const workers of [0, 4, 1.5, NaN]) assert.throws(() => partitionControls(sets, workers), /1 to 3/);
  assert.throws(() => partitionControls([...sets, sets[0]]), /duplicate/);
  assert.throws(() => partitionControls([]), /nonempty/);
  assert.throws(() => partitionControls(["--ignore-gates"]), /inventory/);
});

test("valid original artifacts import all sets; a summary without a final object is not evidence", (t) => {
  const f = fixture(t), report = validateControlWorkers(f.campaign, f.sets, f.workers, f.options);
  assert.deepEqual({ tests: report.tests, pass: report.pass, fail: report.fail, inconclusive: report.inconclusive, problems: report.problems }, { tests: 4, pass: 4, fail: 0, inconclusive: 0, problems: [] });
  assert.equal(report.controlLedgers.length, 3);
  assert.throws(() => finalControlSummary('"ledger":"invented.json"\n'), /no final/);
  assert.throws(() => finalControlSummary('before\n{\n  "ok": true, "ledger":"invented.json"}\n'), /malformed/);
});

test("missing, duplicate and foreign partitions cannot look like a complete pass", (t) => {
  const f = fixture(t);
  for (const workers of [f.workers.slice(1), [...f.workers, f.workers[0]], [{ ...f.workers[0], sets: ["controls-foreign"] }, ...f.workers.slice(1)]]) {
    const report = validateControlWorkers(f.campaign, f.sets, workers, f.options);
    assert.ok(report.problems.some((p) => /partitions/.test(p))); assert.equal(report.pass, 0);
  }
  assert.equal(validateControlWorkers(f.campaign, f.sets, f.workers, f.options).pass, 4, "restored inventory");
});

test("unfinished ledgers, wrong revisions, duplicate rows and dishonest exits are refused", (t) => {
  const f = fixture(t), first = f.workers[0], original = read(f.root, first.path);
  for (const mutate of [
    (l) => delete l.endedAt,
    (l) => { l.commit = "b".repeat(40); },
    (l) => { l.tree = "HEAD"; },
    (l) => { l.interrupted = "SIGINT"; },
    (l) => { l.controls.push(l.controls[0]); },
  ]) {
    const changed = structuredClone(original); mutate(changed); write(f.root, first.path, changed);
    const result = validateControlWorkers(f.campaign, f.sets, f.workers, f.options);
    assert.ok(result.problems.length); assert.ok(result.pass < f.sets.length);
  }
  write(f.root, first.path, original);
  assert.match(validateControlWorkers(f.campaign, f.sets, [{ ...first, exitCode: 1 }, ...f.workers.slice(1)], f.options).problems.join("\n"), /exit/);
  assert.match(validateControlWorkers(f.campaign, f.sets, [{ ...first, finished: false }, ...f.workers.slice(1)], f.options).problems.join("\n"), /did not finish/);
  assert.deepEqual(validateControlWorkers(f.campaign, f.sets, f.workers, f.options).problems, []);
});

test("actual wrong errors, TODOs, missing mutations and wrong fingerprints cannot pass via ok labels", (t) => {
  const f = fixture(t), set = f.sets[0], resultPath = `e2e/.out/${set}-red/invocations/i/results.json`, stackPath = `e2e/.out/${set}-red/stack.json`;
  const result = read(f.root, resultPath), stack = read(f.root, stackPath);
  for (const change of [
    () => write(f.root, resultPath, { ...result, cases: [{ ...result.cases[0], error: { message: "unrelated startup failure" } }] }),
    () => write(f.root, resultPath, { ...result, cases: [{ ...result.cases[0], todo: "known issue" }] }),
    () => write(f.root, resultPath, { ...result, cases: [{ ...result.cases[0], n: 5 }] }),
    () => write(f.root, stackPath, { ...stack, patches: [] }),
    () => write(f.root, stackPath, { ...stack, fingerprint: { ...stack.fingerprint, sha256: "wrong" } }),
  ]) {
    change(); const report = validateControlWorkers(f.campaign, f.sets, f.workers, f.options);
    assert.equal(report.pass, 3); assert.equal(report.fail, 1); assert.ok(report.problems.length);
    write(f.root, resultPath, result); write(f.root, stackPath, stack);
    assert.equal(validateControlWorkers(f.campaign, f.sets, f.workers, f.options).pass, 4);
  }
});

test("bounded scheduling passes ordinary harness arguments unchanged and captures a verifiable aggregate", async (t) => {
  const f = fixture(t, 7); let active = 0, peak = 0;
  const report = await runParallelControls(f.campaign, "e2e/.out/parallel", {
    ...f.options, workers: 3, discover: () => f.sets, snapshot: () => snapshot,
    runWorker: async ({ id, args, log, append }) => {
      active++; peak = Math.max(peak, active);
      const source = f.workers[id - 1];
      assert.deepEqual(args, ["e2e/run.mjs", "controls", ...source.sets, "--tree", "worktree"]);
      await new Promise((done) => setTimeout(done, 10));
      const bytes = readFileSync(join(f.root, source.log)); write(f.root, log, bytes.toString()); append(bytes); active--;
      return { exitCode: 0, finished: true };
    },
  });
  assert.equal(peak, 3); assert.equal(report.outcome, "PASS"); assert.equal(report.tests, 7); assert.equal(report.pass, 7);
  assert.equal(report.logSha256, digest(readFileSync(join(f.root, report.log))));
  assert.deepEqual(report.controlSets, f.sets); assert.equal(report.controlLedgers.length, 3);
  assert.equal(read(f.root, "e2e/.out/parallel/command.json").exitCode, 0);
});

test("a real trivial child harness writes the captured command output; no shell or product stack is needed", async (t) => {
  const f = fixture(t, 2);
  write(f.root, "e2e/run.mjs", `import {readFileSync} from 'node:fs';\nconst bySet=${JSON.stringify(Object.fromEntries(f.workers.map((w) => [w.sets[0], w.log])))};\nif(process.argv[2] !== 'controls' || process.argv.at(-1) !== 'worktree') process.exit(3);\nprocess.stdout.write('child argv '+JSON.stringify(process.argv.slice(2))+'\\n');\nprocess.stdout.write(readFileSync(bySet[process.argv[3]]));\n`);
  const report = await runParallelControls(f.campaign, "e2e/.out/real-child", { ...f.options, discover: () => f.sets, snapshot: () => snapshot });
  assert.equal(report.outcome, "PASS");
  assert.match(readFileSync(join(f.root, report.log), "utf8"), /child argv/);
  assert.ok(report.workers.every((w) => w.finished && w.exitCode === 0));
});

test("the aggregate imports through the shared command contract and a changed captured log is refused", async (t) => {
  const f = fixture(t, 1), worker = f.workers[0], old = f.sets[0], def = readControl("controls-a08-deletion-gap");
  f.sets = [def.set]; worker.sets = f.sets; f.campaign.acceptance.requirements[0].controlSets = f.sets;
  const ledger = read(f.root, worker.path); ledger.controls[0].set = def.set; ledger.green[0].sets = f.sets; write(f.root, worker.path, ledger);
  worker.summary.controls = [{ set: def.set, ok: true }]; write(f.root, worker.log, `ordinary control output\n${JSON.stringify(worker.summary, null, 2)}\n`);
  for (const side of ["green", "red"]) {
    const path = `e2e/.out/${old}-${side}/invocations/i/results.json`, report = read(f.root, path);
    Object.assign(report.cases[0], { file: def.target.spec, name: def.target.case, id: `${def.target.spec}::${def.target.case}` });
    if (side === "red") report.cases[0].error.message = def.expect.message;
    write(f.root, path, report);
  }
  const stackPath = `e2e/.out/${old}-red/stack.json`, stack = read(f.root, stackPath); stack.patches = [{ set: def.set }]; write(f.root, stackPath, stack);
  const report = await runParallelControls(f.campaign, "e2e/.out/importable", {
    root: f.root, discover: () => f.sets, snapshot: () => snapshot,
    runWorker: async ({ log }) => { write(f.root, log, readFileSync(join(f.root, worker.log), "utf8")); return { exitCode: 0, finished: true }; },
  });
  assert.equal(report.outcome, "PASS");
  const imported = importCommand(f.campaign, "e2e/.out/importable/command.json", { root: f.root, cellId: "controls" });
  assert.deepEqual(imported.candidate.controls.map((control) => control.set), f.sets);
  assert.equal(imported.candidate.acceptance.requirements[0].proofs.length, 1);
  const greenReport = read(f.root, `e2e/.out/${old}-green/invocations/i/results.json`);
  const runtimePath = join(f.root, greenReport.invocation.rtdbRuntime.artifact), originalBytes = readFileSync(runtimePath), finalize = EvidenceArtifacts.prototype.assertUnchanged;
  EvidenceArtifacts.prototype.assertUnchanged = function () { finalize.call(this); writeFileSync(runtimePath, Buffer.concat([originalBytes, Buffer.from("\n")])); };
  try { assert.throws(() => importCommand(f.campaign, "e2e/.out/importable/command.json", { root: f.root, cellId: "controls" }), /evidence changed before final acceptance/, "aggregate command import must finalize runtime bytes too"); }
  finally { EvidenceArtifacts.prototype.assertUnchanged = finalize; writeFileSync(runtimePath, originalBytes); }
  write(f.root, report.log, "changed after capture");
  assert.throws(() => importCommand(f.campaign, "e2e/.out/importable/command.json", { root: f.root, cellId: "controls" }), /digest/);
});

test("source drift, inventory drift and a rejected worker preserve failed reports rather than proving completion", async (t) => {
  const f = fixture(t, 1);
  for (const mode of ["source", "inventory", "worker"]) {
    let reads = 0, discoveries = 0;
    const report = await runParallelControls(f.campaign, `e2e/.out/${mode}`, {
      ...f.options,
      snapshot: () => mode === "source" && reads++ ? { ...snapshot, fingerprint: "changed" } : snapshot,
      discover: () => mode === "inventory" && discoveries++ ? [...f.sets, "controls-added"] : f.sets,
      runWorker: async ({ log }) => {
        if (mode === "worker") throw new Error("synthetic child failure");
        write(f.root, log, readFileSync(join(f.root, f.workers[0].log), "utf8"));
        return { exitCode: 0, finished: true };
      },
    });
    assert.equal(report.outcome, "FAIL"); assert.equal(report.exitCode, 1); assert.ok(report.problems.length);
    assert.equal(read(f.root, `e2e/.out/${mode}/command.json`).outcome, "FAIL");
  }
});

test("unprepared snapshots, a subset inventory and evidence outside .out are refused before spawning", async (t) => {
  const f = fixture(t); let launched = false;
  const options = { ...f.options, discover: () => f.sets, snapshot: () => snapshot, runWorker: async () => { launched = true; } };
  for (const acceptance of [{ ...f.campaign.acceptance, revision: "wrong" }, { ...f.campaign.acceptance, tree: "HEAD" }, { ...f.campaign.acceptance, requirements: [{ ...f.campaign.acceptance.requirements[0], controlSets: f.sets.slice(1) }] }]) {
    await assert.rejects(runParallelControls({ ...f.campaign, acceptance }, "e2e/.out/no-start", options));
  }
  await assert.rejects(runParallelControls(f.campaign, "../outside", options), /under e2e/);
  assert.equal(launched, false);
});

test("aggregate control imports cannot accept source-only runtime evidence", t => {
  const f = fixture(t); delete f.campaign.acceptance.rtdbEngine;
  const result = validateControlWorkers(f.campaign, f.sets, f.workers, f.options);
  assert.equal(result.pass, 0, "every aggregate pair must pass independent runtime verification");
  assert.equal(result.fail, f.sets.length);
  for (const set of f.sets) assert.ok(result.problems.some(problem => problem.startsWith(`${set}:`) && problem.includes("acceptance must explicitly choose")), `${set}: the exact runtime refusal remains visible`);
});
