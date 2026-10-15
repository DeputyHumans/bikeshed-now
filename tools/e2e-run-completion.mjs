// SPDX-License-Identifier: Apache-2.0
// Bind a full passing E2E report to its completed invocation, planned files and unique case identities (SPEC §12).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readResults } from "../e2e/lib/report.mjs";

const need = (ok, message) => { if (!ok) throw new Error(`completed invocation: ${message}`); };

/** A merged report may exist before the runner has finished; it is not completion. */
export function verifyCompletedRun(report, reportPath) {
  let done;
  try { done = JSON.parse(readFileSync(join(dirname(reportPath), "invocation.json"), "utf8")); }
  catch (error) { throw new Error(`completed invocation: cannot read completion metadata: ${error.message}`); }
  for (const key of ["id", "runId", "suite", "spec", "grep", "n", "trials", "capabilities", "plan"]) {
    assert.deepEqual(done[key], report.invocation?.[key], `completed invocation: ${key} differs from report`);
  }
  need(done.runId === report.runId, "run identity differs");
  const start = Date.parse(done.startedAt), end = Date.parse(done.endedAt), merged = Date.parse(report.mergedAt);
  need(Number.isFinite(start) && Number.isFinite(end) && Number.isFinite(merged) && end >= start && merged >= start, "successful end is absent or an end/report precedes its start");
  need(done.exit === 0 && done.interrupted === null && done.stackDown === null, "run did not finish successfully without interruption or stack failure");
  const cases = report.cases ?? [];
  const keys = cases.map(c => `${c.id}::${c.n ?? "-"}::${c.trial ?? 1}`);
  need(new Set(keys).size === cases.length, "duplicate case identities");
  need(cases.every(c => typeof c.file === "string" && typeof c.name === "string" && c.id === `${c.file}::${c.name}`), "case identity differs from its file and name");
  const planned = done.plan?.flatMap(tier => tier.files ?? []) ?? [];
  need(planned.length > 0 && new Set(planned).size === planned.length, "planned files are absent or duplicated");
  const observed = new Set(cases.map(c => c.file));
  need(planned.every(file => observed.has(file)) && [...observed].every(file => planned.includes(file)), "report does not cover exactly its planned files");
  // The runner merges before recording its successful end. A report merged
  // earlier may contain only passes yet omit later cases in the same file.
  const final = readResults(dirname(reportPath));
  need(final.files.length > 0 && final.malformed.length === 0, "final reporter records are absent or malformed");
  const rawCases = cases.map(({ classification, ...row }) => row).sort((a, b) => a.id.localeCompare(b.id));
  assert.deepEqual(rawCases, final.records.sort((a, b) => a.id.localeCompare(b.id)), "completed invocation: final reporter records differ from report");
  return done;
}
