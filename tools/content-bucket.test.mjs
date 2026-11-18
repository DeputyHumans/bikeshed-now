// SPDX-License-Identifier: Apache-2.0
// The content bucket deletes staged uploads and built downloads after a day, and keeps every rule it had (SPEC §24, ADR 0037).

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ensureContentLifecycle, lifecycleRule, mergedRules } from "../scripts/lib/content-bucket.mjs";

/** gcloud, as far as describe and update: the bucket's lifecycle lives here. */
function fakeGcloud(initial) {
  let lifecycle = initial;
  const calls = [];
  const run = (_tool, argv) => {
    calls.push(argv.filter((a) => !a.startsWith("--project") && !a.startsWith("--account") && a !== "--quiet" && a !== "--verbosity=error"));
    if (argv[2] === "describe") return { status: 0, stdout: JSON.stringify(lifecycle ? { lifecycle } : {}) };
    if (argv[2] === "update") {
      const file = argv.find((a) => a.startsWith("--lifecycle-file=")).slice("--lifecycle-file=".length);
      lifecycle = JSON.parse(readFileSync(file, "utf8"));
      return { status: 0, stdout: "" };
    }
    throw new Error(`unexpected gcloud ${argv.join(" ")}`);
  };
  return { run, calls, now: () => lifecycle };
}

const options = { project: "demo-bikeshed", bucket: "demo-bikeshed-content", account: "op@example.com" };
const theirs = { action: { type: "SetStorageClass", storageClass: "NEARLINE" }, condition: { age: 365, matchesPrefix: ["archive/"] } };

test("our rule is added once, after whatever rules the bucket already had", () => {
  assert.deepEqual(mergedRules(undefined), [lifecycleRule()]);
  assert.deepEqual(mergedRules([theirs]), [theirs, lifecycleRule()]);
  const done = [theirs, lifecycleRule()];
  assert.equal(mergedRules(done), done, "nothing to write when it is there");
  assert.deepEqual(lifecycleRule(), { action: { type: "Delete" }, condition: { age: 1, matchesPrefix: ["staging/", "downloads/"] } });
});

test("a bucket without the rule gets it, keeps its own, and is read back", () => {
  const g = fakeGcloud({ rule: [theirs] });
  const result = ensureContentLifecycle(options, { run: g.run, log: () => {} });
  assert.deepEqual(result, { changed: true });
  assert.deepEqual(g.now().rule, [theirs, lifecycleRule()]);
  assert.deepEqual(g.calls.map((c) => c.slice(0, 3)), [["storage", "buckets", "describe"], ["storage", "buckets", "update"], ["storage", "buckets", "describe"]]);
});

test("a bucket with the rule is left alone, and a dry run touches nothing", () => {
  const g = fakeGcloud({ rule: [lifecycleRule()] });
  assert.deepEqual(ensureContentLifecycle(options, { run: g.run, log: () => {} }), { changed: false });
  assert.equal(g.calls.length, 1);
  const lines = [];
  ensureContentLifecycle({ ...options, dryRun: true, account: undefined }, { run: () => { throw new Error("ran gcloud in a dry run"); }, log: (l) => lines.push(l) });
  assert.ok(lines.some((l) => l.includes('"matchesPrefix":["staging/","downloads/"]')));
});

test("a real run needs an account, as every operator command does", () => {
  assert.throws(() => ensureContentLifecycle({ ...options, account: "" }, { run: () => ({ status: 0, stdout: "{}" }) }), /--account is required/);
});
