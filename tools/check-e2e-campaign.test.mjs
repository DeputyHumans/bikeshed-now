// SPDX-License-Identifier: Apache-2.0
// Campaign completion controls: missing work, disguised outcomes, stale evidence and ineffective controls never become a pass (SPEC §12).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { checkCampaign } from "./check-e2e-campaign.mjs";

const imported = JSON.parse(readFileSync(new URL("../e2e/campaign.json", import.meta.url), "utf8"));
const sha = "a".repeat(40);
const version = "0.1.0";
const hash = (s) => createHash("sha256").update(s).digest("hex");
const write = (root, file, value) => { const p = join(root, file); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, JSON.stringify(value)); };

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "campaign-check-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const c = structuredClone(imported);
  c.proofs = [];
  c.controls = [];
  Object.assign(c.acceptance, { revision: sha, version });
  let seq = 0;
  for (const r of c.acceptance.requirements) {
    const id = `proof-${seq++}`;
    const artifact = `e2e/.out/${id}/report.json`;
    const p = { id, kind: r.kind, revision: sha, version, artifact, outcome: "PASS" };
    if (r.kind === "command") {
      const log = `${artifact}.log`;
      const logText = `command passed: ${r.command}`;
      write(root, artifact, { command: r.command, revision: sha, version, outcome: "PASS", exitCode: 0, tests: 1, fail: 0, skip: 0, todo: 0, inconclusive: 0, log });
      writeFileSync(join(root, log), logText);
      Object.assign(p, { command: r.command, logSha256: hash(logText) });
    } else {
      Object.assign(p, { runId: id, invocation: "invocation-1" });
      const file = `e2e/specs/${r.suite}/${r.spec ?? "synthetic.spec.mjs"}`;
      const cases = [{ id: `${file}::synthetic assertion`, file, status: "pass", n: r.n ?? null, trial: 1, todo: null, error: null }];
      write(root, artifact, { runId: id, invocation: { id: p.invocation, suite: r.suite, spec: r.spec ? [r.spec] : [], grep: null, trials: null, capabilities: r.capabilities ?? [] }, malformed: [], cases });
      write(root, `e2e/.out/${id}/stack.json`, { fingerprint: { baseSha: sha, dirty: false }, expectVersion: version, patches: (r.options?.patches ?? []).map((set) => ({ set })), options: { emailOff: r.options?.emailOff ?? false, appEnv: { ...Object.fromEntries((r.options?.appEnvPresent ?? []).map((k) => [k, "synthetic"])), ...(r.options?.appEnv ?? {}) } } });
    }
    c.proofs.push(p);
    r.proofs = [id];
  }
  const source = c.proofs.find((p) => p.kind === "e2e-run");
  const report = JSON.parse(readFileSync(join(root, source.artifact), "utf8"));
  const positive = { ...source, id: "positive-case", kind: "e2e-case", caseId: report.cases[0].id };
  c.proofs.push(positive);
  const negative = { ...positive, id: "negative-case", artifact: "e2e/.out/negative/report.json", outcome: "FAIL" };
  write(root, negative.artifact, { ...report, cases: [{ ...report.cases[0], status: "fail", error: "intended synthetic assertion" }] });
  c.proofs.push(negative);
  c.controls.push({ id: "control", mutation: "plant the synthetic bug", red: negative.id, green: positive.id, assertion: "intended synthetic assertion" });
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
