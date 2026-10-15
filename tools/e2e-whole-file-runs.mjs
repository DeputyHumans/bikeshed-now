// SPDX-License-Identifier: Apache-2.0
// Verify the three complete current-file runs required by the original A08/A11 stability findings (SPEC §12).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { scanScenarios } from "../e2e/lib/budget.mjs";
import { readResults } from "../e2e/lib/report.mjs";
import { verifyCompletedRun } from "./e2e-run-completion.mjs";
import { snapshotWorktree } from "./e2e-campaign-evidence.mjs";

export const STABILITY_FILES = Object.freeze({
  "deep:a08-review:13": "e2e/specs/functional/a08-review.spec.mjs",
  "deep:a11-live:10": "e2e/specs/functional/a11-live.spec.mjs",
});
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const need = (ok, why) => { if (!ok) throw new Error(`whole-file stability: ${why}`); };
const purePass = c => c.status === "pass" && !c.error && !c.todo && !c.inconclusive && !c.notReproduced && !c.skipReason && (!c.outcome || c.outcome === "PASS");
function artifact(root, path) {
  need(typeof path === "string" && !isAbsolute(path) && !relative(root, resolve(root, path)).startsWith(".."), "artifact must stay repository-relative");
  return resolve(root, path);
}
function names(source) {
  const lines = source.split("\n"), scan = scanScenarios(source, { caseDefaultMs: 1 });
  const names = scan.calls.map(call => {
    const match = /^scenario\(("(?:[^"\\]|\\.)*")\s*,/.exec(lines[call.line - 1]);
    need(call.topLevel && match, "changed dynamic declaration needs a reviewed inventory");
    return JSON.parse(match[1]);
  });
  need(names.length > 0 && new Set(names).size === names.length, "current scenario inventory is empty or duplicated");
  return names;
}

/** This verifies evidence only: no stack, scenario body or canonical write is performed. */
export function verifyWholeFileRuns(campaign, { item, reports }, { root = ROOT, snapshot = snapshotWorktree } = {}) {
  const file = STABILITY_FILES[item]; need(file, "only the two original three-run obligations are supported");
  need(Array.isArray(reports) && reports.length === 3 && new Set(reports.map(p => artifact(root, p))).size === 3, "three distinct complete invocation reports are required");
  const source = readFileSync(resolve(root, file)), expected = names(source.toString()).map(name => `${file}::${name}`).sort(), identities = new Set(), runs = [];
  const a = campaign.acceptance;
  need(/^[a-f0-9]{40}$/.test(a.revision) && /^[a-f0-9]{64}$/.test(a.fingerprint) && a.version, "frozen acceptance source is absent");
  const before = snapshot(root);
  for (const field of ["revision", "version", "fingerprint"]) need(before[field] === a[field], "current source differs from the frozen acceptance");
  for (const path of reports) {
    const bytes = readFileSync(artifact(root, path)), report = JSON.parse(bytes), dir = dirname(path), inv = report.invocation;
    need(!dir.includes("/scratch/") && inv?.suite === "functional" && !inv.grep && inv.trials === null && inv.n === null, "scratch, filtered or authoring run cannot establish whole-file stability");
    verifyCompletedRun(report, artifact(root, path));
    const identity = `${report.runId}/${inv.id}`; need(!identities.has(identity), "duplicate completed invocation identity"); identities.add(identity);
    const stackPath = `e2e/.out/${report.runId}/stack.json`, stackBytes = readFileSync(artifact(root, stackPath)), stack = JSON.parse(stackBytes);
    need(stack.fingerprint?.baseSha === a.revision && stack.fingerprint.sha256 === a.fingerprint && stack.expectVersion === a.version && (stack.patches ?? []).length === 0, "run differs from the frozen clean product");
    const rows = report.cases.filter(c => c.file === file);
    assert.deepEqual(rows.map(c => c.id).sort(), expected, "whole-file stability: report omits or replaces a current scenario");
    need(rows.every(purePass), "every current case in the whole file must be an unqualified PASS");
    const record = p => ({ artifact: p, sha256: hash(readFileSync(artifact(root, p))) });
    runs.push({ runId: report.runId, invocation: inv.id, report: { artifact: path, sha256: hash(bytes) }, completion: record(`${dir}/invocation.json`), stack: { artifact: stackPath, sha256: hash(stackBytes) }, reporter: readResults(artifact(root, dir)).files.map(name => record(`${dir}/${name}`)), cases: rows.map(c => c.id) });
  }
  assert.deepEqual(snapshot(root), before, "whole-file stability: source changed while verifying evidence");
  return { kind: "three-current-whole-file-runs", item, file, sourceSha256: hash(source), revision: a.revision, version: a.version, fingerprint: a.fingerprint, runs, originalObligationUnchanged: true };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { campaign: { type: "string" }, item: { type: "string" }, report: { type: "string", multiple: true, default: [] } } });
  need(values.campaign && values.item, "--campaign, --item and three --report paths are required");
  const campaign = JSON.parse(readFileSync(artifact(ROOT, values.campaign)));
  process.stdout.write(JSON.stringify(verifyWholeFileRuns(campaign, { item: values.item, reports: values.report }), null, 2) + "\n");
}
