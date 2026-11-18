// SPDX-License-Identifier: Apache-2.0
// The content bucket's lifecycle rule: staged uploads and built downloads go after a day (SPEC §4, §24, ADR 0037).

/**
 * Two prefixes in the content bucket hold what nothing names for long:
 * `staging/`, where a large file waits for the publish that names it, and
 * `downloads/`, where a large version's zip is built once. A lifecycle rule
 * deletes both a day after each object was made. It is the cleanup, not a
 * scheduled job: Storage does it, and nothing here has to remember to.
 *
 * A bucket's lifecycle is replaced whole by an update, so the existing rules
 * are read, ours are added where missing, and the result is written and read
 * back. Nothing is ever added for `docs/`: a storage-class change there would
 * turn every server-side copy into a rewrite that drops its precondition.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runner } from "./media.mjs";

export const LIFECYCLE_PREFIXES = Object.freeze(["staging/", "downloads/"]);

/** Our rule: delete what is under these prefixes once it is a day old. */
export function lifecycleRule() {
  return { action: { type: "Delete" }, condition: { age: 1, matchesPrefix: [...LIFECYCLE_PREFIXES] } };
}

function isOurs(rule) {
  const prefixes = rule?.condition?.matchesPrefix;
  return rule?.action?.type === "Delete" && rule?.condition?.age === 1 && Array.isArray(prefixes) &&
    [...prefixes].sort().join("\n") === [...LIFECYCLE_PREFIXES].sort().join("\n");
}

/** The rules a bucket should have: whatever it has, and ours once. */
export function mergedRules(existing) {
  const rules = Array.isArray(existing) ? existing : [];
  return rules.some(isOurs) ? rules : [...rules, lifecycleRule()];
}

/**
 * Make sure the content bucket deletes staged uploads and built downloads
 * after a day. Reads, merges, writes only when something is missing, and
 * verifies; a dry run prints the commands and runs none.
 */
export function ensureContentLifecycle(options, dependencies) {
  const { project, bucket } = options;
  if (!bucket) throw new Error("the content bucket is not known");
  const cloud = runner(options, dependencies);
  const url = `gs://${bucket}`;
  const describe = () => cloud.json(["storage", "buckets", "describe", url, "--raw"]);
  const before = describe();
  const rules = mergedRules(before?.lifecycle?.rule);
  if (!cloud.dryRun && rules === before?.lifecycle?.rule) {
    cloud.log("  lifecycle: staged uploads and built downloads already go after a day.");
    return { changed: false };
  }
  let temp;
  try {
    const file = cloud.dryRun ? "<lifecycle.json>" : join(temp = mkdtempSync(join(tmpdir(), "bikeshed-lifecycle-")), "lifecycle.json");
    const body = { rule: rules };
    if (cloud.dryRun) cloud.log(`  # lifecycle file: ${JSON.stringify(body)}`);
    else writeFileSync(file, JSON.stringify(body));
    cloud.command(["storage", "buckets", "update", url, `--lifecycle-file=${file}`]);
  } finally {
    if (temp) rmSync(temp, { recursive: true, force: true });
  }
  if (!cloud.dryRun) {
    const after = describe();
    const kept = (Array.isArray(before?.lifecycle?.rule) ? before.lifecycle.rule : []).every((r) =>
      (after?.lifecycle?.rule ?? []).some((a) => JSON.stringify(a) === JSON.stringify(r)));
    if (!kept || !(after?.lifecycle?.rule ?? []).some(isOurs)) {
      throw new Error(`the lifecycle of ${url} did not converge; inspect it before running again`);
    }
  }
  cloud.log(cloud.dryRun ? "  lifecycle dry-run complete; no commands executed." : "  lifecycle: staged uploads and built downloads now go after a day.");
  return { changed: true };
}
