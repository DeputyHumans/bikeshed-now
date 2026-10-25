// SPDX-License-Identifier: Apache-2.0
// Bind fresh-stack concurrency partitions to the complete executable scenario inventory (SPEC §12).

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";
import { verifyFinishedRun } from "./e2e-run-completion.mjs";
import { verifyLocalLimit } from "./e2e-local-limit.mjs";
import { verifyComposite } from "./e2e-c14-composite.mjs";

const need = (ok, why) => { if (!ok) throw new Error(`partitions: ${why}`); };
export const partitionDigest = bytes => createHash("sha256").update(bytes).digest("hex");
const key = c => JSON.stringify([c.id, c.n ?? null, c.trial ?? 1]);
const pass = c => c.status === "pass" && !c.error && !c.todo && !c.inconclusive && !c.notReproduced && !c.skipReason && (!c.outcome || c.outcome === "PASS");
const skip = c => c.status === "skip" && !c.error && !c.todo && !c.inconclusive && !c.notReproduced;
export function partitionPath(root, path) {
  need(typeof path === "string" && !isAbsolute(path) && !path.includes("\\") && !relative(root, resolve(root, path)).startsWith(".."), "path must stay repository-relative");
  return resolve(root, path);
}

/** Execute declarations with NO target: the existing harness skips every body. */
export function concurrencyInventory(root) {
  const dir = "e2e/specs/concurrency";
  const files = readdirSync(resolve(root, dir), { recursive: true }).filter(p => p.endsWith(".spec.mjs")).map(p => `${dir}/${p}`).sort();
  need(files.length > 0, "no concurrency specs");
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("E2E_") && !["NODE_OPTIONS", "NODE_TEST_CONTEXT"].includes(k)));
  env.E2E_SUITE = "concurrency";
  const output = execFileSync(process.execPath, ["--test", "--test-force-exit", "--test-concurrency=1", "--test-reporter=./e2e/lib/reporter.mjs", ...files], { cwd: root, env, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 120_000 });
  const rows = output.trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  need(rows.length > 0 && rows.every(c => skip(c) && c.skipReason === "no target (E2E_TARGET is not set)"), "inventory must only declare targetless skipped cases");
  need(new Set(rows.map(key)).size === rows.length, "duplicate declarations");
  need(rows.every(c => files.includes(c.file)), "inventory contains an undeclared file");
  return files.map(file => {
    const cases = rows.filter(c => c.file === file).map(({ id, n, trial }) => ({ id, n: n ?? null, trial: trial ?? 1 }));
    need(cases.length > 0, `empty inventory for ${file}`);
    return { file, sha256: partitionDigest(readFileSync(resolve(root, file))), cases };
  });
}

export function partitionCellDigest(cell) {
  const { proofs, ...definition } = cell;
  return partitionDigest(JSON.stringify(definition));
}

/** A manifest never replaces a run: every constituent retains its original report and completion. */
export function verifyPartitions(campaign, cell, manifest, { root, inventory = concurrencyInventory(root) }) {
  need(cell?.kind === "e2e-run" && cell.suite === "concurrency" && !cell.spec && cell.planTrials, "only full concurrency matrix cells can be partitioned");
  need(manifest?.schemaVersion === 1 && manifest.kind === "concurrency-partitions" && manifest.cell === cell.id, "manifest names another matrix cell");
  need(manifest.requirementSha256 === partitionCellDigest(cell), "matrix requirement changed");
  for (const field of ["revision", "version", "fingerprint"]) need(manifest.source?.[field] === campaign.acceptance[field], `stale ${field}`);
  assert.deepEqual(manifest.inventory, inventory, "partitions: executable inventory differs from frozen declarations");
  need(Array.isArray(manifest.reports) && manifest.reports.length === inventory.length, "missing partitions");
  const paths = new Set(), runs = new Set(), seen = new Set(), result = [];
  for (const ref of manifest.reports) {
    need(!paths.has(ref.artifact), "duplicate report"); paths.add(ref.artifact);
    const path = partitionPath(root, ref.artifact), bytes = readFileSync(path);
    need(partitionDigest(bytes) === ref.sha256, "report digest differs");
    const report = JSON.parse(bytes), inv = report.invocation;
    const q = ref.qualification;
    need(!q || ["LOCAL-LIMIT", "COMPOSITE-SAFETY"].includes(q.outcome), "unsupported partition qualification");
    const proof = { id: `run-${report.runId}-${inv.id}`, kind: "e2e-run", artifact: ref.artifact,
      revision: campaign.acceptance.revision, version: campaign.acceptance.version, fingerprint: campaign.acceptance.fingerprint,
      runId: report.runId, invocation: inv.id, outcome: q?.outcome ?? "PASS",
      ...(q?.localLimit ? { localLimit: q.localLimit } : {}), ...(q?.composite ? { composite: q.composite } : {}) };
    verifyFinishedRun(report, path, { expectedExit: q ? 3 : 0 });
    need(report.malformed?.length === 0 && inv.suite === cell.suite && !inv.grep && inv.trials === null, "filtered, malformed or authoring partition");
    need(inv.n?.length === 1 && inv.n[0] === cell.n, "participant count differs");
    const planned = inv.plan.flatMap(p => p.files);
    need(planned.length === 1 && inv.spec?.length === 1 && inv.spec[0] === planned[0], "partition must select one complete file");
    const expected = inventory.find(x => x.file === planned[0]);
    need(expected && !seen.has(expected.file), "unknown or duplicate file"); seen.add(expected.file);
    assert.deepEqual(report.cases.map(key).sort(), expected.cases.map(key).sort(), "partitions: case/N/trial census differs");
    const stack = JSON.parse(readFileSync(partitionPath(root, `e2e/.out/${report.runId}/stack.json`)));
    need(stack.fingerprint?.baseSha === campaign.acceptance.revision && stack.fingerprint.sha256 === campaign.acceptance.fingerprint && stack.expectVersion === campaign.acceptance.version, "partition source differs");
    need((cell.capabilities ?? []).every(cap => inv.capabilities?.includes(cap)), "partition capabilities differ");
    assert.deepEqual((stack.patches ?? []).map(p => p.set ?? p).sort(), [...(cell.options?.patches ?? [])].sort(), "partitions: capability patches differ");
    const observations = [];
    if (proof.outcome === "COMPOSITE-SAFETY") observations.push(...verifyComposite(campaign, proof, { report, stack }, { root }).observations);
    if (proof.outcome === "LOCAL-LIMIT" || proof.localLimit) observations.push(...verifyLocalLimit(campaign, proof, { report, stack }, { root }).observations);
    const observed = c => `${c.id}::${c.n ?? "-"}::${c.trial ?? 1}`;
    need(report.cases.every(c => pass(c) || skip(c) || observations.includes(observed(c))) && report.cases.some(pass), "partition contains failed or unjudged cases");
    const id = proof.id;
    need(!runs.has(id), "duplicate invocation"); runs.add(id);
    result.push({ id, ref, report, stack, proof });
  }
  return result;
}
