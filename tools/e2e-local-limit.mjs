// SPDX-License-Identifier: Apache-2.0
// Recognize only the pinned C15 automatic-trigger limitation while retaining exact incomplete case identities and ordinary passing witnesses (SPEC §14).

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { parseExpandedCase } from "../e2e/lib/controls.mjs";
import { PLAN_TRIALS } from "../e2e/lib/budget.mjs";
import { PIN } from "./probe-e2e-trigger-queue.mjs";

export const LIMIT_ID = "firestore-1.22.0-serial-trigger-delivery";
export const C15_WORK = "C15 feedback storm under a get_changes poller: N participants each open a thread, reply in a shared one and suggest an edit at one instant, then resolve and reopen the shared one together; N threads and N+1 replies, the poller sees every event once (I15), one note per real flip (I10), and at most one notice per person and kind (I11)";
export const C15_JUDGE = "C15 I11 race judge: the storm's notices were decided by onCommentCreated runs that overlapped, so the cooldown claim was contended, and still at most one notice went to each person per document and kind";
const FILE = "e2e/specs/concurrency/c13-feedback.spec.mjs";
const need = (ok, message) => { if (!ok) throw new Error(`local limit: ${message}`); };
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const key = c => `${c.id}::${c.n}::${c.trial}`;
const pass = c => c.status === "pass" && !c.error && !c.todo && !c.inconclusive && !c.notReproduced && !c.skipReason && (!c.outcome || c.outcome === "PASS");
function file(root, path) {
  need(typeof path === "string" && !isAbsolute(path) && !path.includes("\\") && !relative(root, resolve(root, path)).startsWith(".."), "artifact must be repository-relative");
  return resolve(root, path);
}
function scenario(c, name) {
  const expanded = parseExpandedCase(c.id);
  return c.file === FILE && expanded?.scenario === `${FILE}::${name}` && expanded.n === c.n && (expanded.trial ?? 1) === c.trial;
}
function readBound(root, reference) {
  const bytes = readFileSync(file(root, reference?.artifact));
  need(sha(bytes) === reference.sha256, "artifact digest differs");
  return bytes;
}

export function localLimitReference(root, artifact, reportPath) {
  const measurements = `${dirname(reportPath)}/c13-feedback.jsonl`;
  const invocation = `${dirname(reportPath)}/invocation.json`;
  const report = JSON.parse(readFileSync(file(root, reportPath), "utf8"));
  return { id: LIMIT_ID, artifact, sha256: sha(readFileSync(file(root, artifact))),
    observations: report.cases.filter(c => c.status === "inconclusive" && scenario(c, C15_JUDGE)).map(key),
    invocation: { artifact: invocation, sha256: sha(readFileSync(file(root, invocation))) },
    measurements: { artifact: measurements, sha256: sha(readFileSync(file(root, measurements))) } };
}

/** A limitation is not a case proof: its raw case remains INCONCLUSIVE in the immutable report. */
export function verifyLocalLimit(campaign, proof, loaded, { root }) {
  const ref = proof.localLimit, { report, stack } = loaded, a = campaign.acceptance;
  need(proof.kind === "e2e-run" && ["LOCAL-LIMIT", "COMPOSITE-SAFETY"].includes(proof.outcome) && ref?.id === LIMIT_ID, "only a named run-level LOCAL-LIMIT is supported");
  const probe = JSON.parse(readBound(root, ref));
  need(probe.schemaVersion === 1 && probe.kind === "unsupported-local-trigger-overlap", "wrong probe kind");
  assert.deepEqual(probe.toolchain, PIN, "local limit: unpinned CLI, emulator or JAR hash");
  assert.deepEqual(probe.structure, { core: 0, maximum: 4, queue: "unbounded LinkedBlockingQueue", delivery: "blocking HttpRequest.execute" }, "local limit: structural proof differs");
  assert.deepEqual(probe.behavior, { installedConfiguration: { core: 0, maximum: 4, active: 1, queued: 3 }, counterfactualCoreFour: { core: 4, maximum: 4, active: 4, queued: 0 } }, "local limit: behavioral proof differs");
  for (const field of ["revision", "version", "fingerprint"]) need(probe.source?.[field] === a[field], `stale probe ${field}`);
  need(probe.command === "node tools/e2e-campaign-evidence.mjs capture-local-limit", "probe was not captured by the bound command");
  const at = Date.parse(probe.observedAt), merged = Date.parse(report.mergedAt);
  need(Number.isFinite(at) && Number.isFinite(merged) && at >= merged, "probe predates the completed run");
  const invocation = JSON.parse(readBound(root, ref.invocation));
  need(ref.invocation.artifact === `${dirname(proof.artifact)}/invocation.json`, "completion metadata belongs to another invocation");
  for (const field of ["id", "runId", "suite", "spec", "grep", "n", "trials", "capabilities"]) assert.deepEqual(invocation[field], report.invocation[field], `local limit: completed invocation ${field} differs from report`);
  const ended = Date.parse(invocation.endedAt);
  need(Number.isFinite(ended) && ended >= merged && at >= ended && invocation.exit === 3 && invocation.interrupted === null && invocation.stackDown === null, "invocation did not finish normally with only incomplete outcomes before the probe");
  need(stack.toolchain?.firebase?.version === PIN.firebase, "stack uses another Firebase CLI");
  need(report.invocation?.suite === "concurrency" && !report.invocation.grep && report.invocation.trials === null, "only complete plan-trial concurrency runs qualify");
  for (const cap of ["local", "logs", "mailpit"]) need(report.invocation.capabilities?.includes(cap), `missing ${cap} capability`);
  const ns = report.invocation.n;
  need(Array.isArray(ns) && ns.length > 0 && new Set(ns).size === ns.length && ns.every(n => Object.hasOwn(PLAN_TRIALS, n)), "explicit valid N axes required");
  const rows = readBound(root, ref.measurements).toString("utf8").trim().split("\n").map(line => JSON.parse(line));
  need(ref.measurements.artifact === `${dirname(proof.artifact)}/c13-feedback.jsonl`, "measurement belongs to another invocation");
  need(new Set(report.cases.map(key)).size === report.cases.length, "duplicate report case keys");
  need(report.cases.every(c => typeof c.file === "string" && typeof c.name === "string" && c.id === `${c.file}::${c.name}`), "inconsistent report case identity");
  const limited = [];
  for (const n of ns) for (let trial = 1; trial <= PLAN_TRIALS[n]; trial++) {
    const judges = report.cases.filter(c => c.n === n && c.trial === trial && scenario(c, C15_JUDGE));
    const work = report.cases.filter(c => c.n === n && c.trial === trial && scenario(c, C15_WORK));
    need(judges.length === 1 && work.length === 1, `missing or duplicate C15 axis N=${n} trial=${trial}`);
    need(pass(work[0]), `ordinary C15 assertions did not pass N=${n} trial=${trial}`);
    const c = judges[0];
    if (pass(c)) continue;
    need(c.status === "inconclusive" && !c.error && !c.todo && !c.notReproduced && !c.skipReason && !c.outcome && /^the sync precondition did not hold: no two onCommentCreated runs overlapped while C15 ran \(\d+ run\(s\), peak 1 at once;.*; 0 failure line\(s\)\)/.test(c.inconclusive), "unrelated incomplete outcome cannot use this limitation");
    const attempts = rows.filter(r => r.ref === "C15" && r.n === n && r.trial === trial && r.case === work[0].name && r.naturalAttempts).at(-1)?.naturalAttempts;
    need(Array.isArray(attempts) && attempts.length === 3, "all three natural attempts must be retained");
    for (const [i, attempt] of attempts.entries()) {
      const runs = attempt.diagnostic?.triggerRuns;
      need(attempt.attempt === i + 1 && attempt.outcome === "window-missed" && runs?.exact === true && runs.peak?.onCommentCreated === 1 && runs.runs?.onCommentCreated > 0 && runs.failed === 0 && Object.keys(runs.open ?? {}).length === 0, "attempt does not establish exact serial trigger delivery");
    }
    limited.push(key(c));
  }
  need(limited.length > 0, "no unsupported trigger witness was observed");
  assert.deepEqual(ref.observations, limited, "local limit: exact observation identities differ");
  return { observations: limited, unresolvedDeploymentWitness: { id: LIMIT_ID, cases: limited, reason: "Automatic concurrent trigger delivery remains unverified outside the pinned local emulator." } };
}
