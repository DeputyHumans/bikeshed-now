// SPDX-License-Identifier: Apache-2.0
// Append bounded phase timings without changing a measured operation's result (SPEC §12).
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

export async function timePhase(directory, phase, operation, { caseName = null, now = () => performance.now(), emit = row => appendFileSync(join(directory, "timings.jsonl"), JSON.stringify(row) + "\n") } = {}) {
  if (!directory) return operation();
  const started = now();
  let outcome = "failed";
  try {
    const value = await operation();
    outcome = "completed";
    return value;
  } finally {
    // No request bodies, credentials or error messages enter this diagnostic.
    // A full disk must not mask the original result; missing timing is not proof.
    try { emit({ schemaVersion: 1, at: new Date().toISOString(), pid: process.pid, phase, caseName, durationMs: now() - started, outcome, rssBytes: process.memoryUsage().rss }); } catch {}
  }
}
