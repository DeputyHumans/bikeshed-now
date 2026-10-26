// SPDX-License-Identifier: Apache-2.0
// Challenge Firestore diagnostic recycling without weakening quiescence, rules, evidence retention or enforcement (SPEC §12).

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { CoverageBoundary } from "../lib/rtdb-coverage.mjs";
import { FIRESTORE_COVERAGE_PIN, recycleFirestoreCoverage } from "../lib/firestore-coverage.mjs";
import { tempDir } from "./helpers/tmp.mjs";

function fixture() {
  const root = tempDir("e2e-firestore-coverage-"), tree = join(root, "tree"), dir = join(root, "invocation");
  mkdirSync(tree); mkdirSync(dir);
  const rules = "rules_version = '2'; service cloud.firestore { match /databases/{db}/documents { match /{path=**} { allow read, write: if false; } } }\n";
  writeFileSync(join(tree, "firebase.json"), JSON.stringify({ firestore: { rules: "firestore.rules" } }));
  writeFileSync(join(tree, "firestore.rules"), rules);
  const target = { kind: "local", runId: "fixture", projectId: "demo-bikeshed", capabilities: new Set(["rtdb-rules"]), firestoreUrl: "http://127.0.0.1:38128", stack: { treeDir: tree, ports: { firestore: 38128 } } };
  const state = { invocation: { runId: target.runId, pid: 123, parallelism: { concurrency: 1 }, maintenance: { rtdbCoverage: true }, locks: { concurrency: { mode: "exclusive" } } }, locks: { exclusive: { pid: 123, runId: target.runId, tier: "concurrency", mode: "exclusive" }, shared: [] }, browsers: [] };
  const boundary = new CoverageBoundary(); boundary.enter();
  const source = { files: [{ name: "security.rules", content: rules }] }, calls = [];
  const coverage = JSON.stringify({ rules: source, report: [{ sourcePosition: { line: 1 }, values: [{ value: { stringValue: "retained private fixture payload" }, count: 5 }] }] });
  let retained = true;
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, ...options });
    if (/\/documents\/__(?:[^/]+)__\//.test(url)) return Response.json({ error: { status: "INVALID_ARGUMENT" } }, { status: 400 });
    if (url.endsWith(":securityRules")) {
      if (options.method === "PUT") { assert.deepEqual(JSON.parse(options.body), { rules: source, ignore_errors: false }); retained = false; return Response.json({ issues: [{ severity: "WARNING", description: "Unused function: canEdit." }] }); }
      return Response.json({ rules: source });
    }
    if (url.endsWith(":ruleCoverage")) return new Response(retained ? coverage : JSON.stringify({ rules: source, report: [{ sourcePosition: { line: 1 } }] }), { headers: { "content-type": "application/json" } });
    if (url.includes("/e2e_maintenance_probe/missing")) return Response.json({ error: { status: "PERMISSION_DENIED" } }, { status: 403 });
    throw new Error(`unexpected request ${url}`);
  };
  const options = { boundary, caseName: "next case", invocationDir: dir, inspect: () => state, pin: async () => FIRESTORE_COVERAGE_PIN, fetchImpl };
  return { root, tree, dir, target, state, boundary, rules, source, calls, coverage, options };
}

test("Firestore recycling archives exact diagnostics and reapplies the identical rules once", async () => {
  const f = fixture(), row = await recycleFirestoreCoverage(f.target, f.options);
  const mutations = f.calls.filter(c => c.method);
  assert.equal(mutations.length, 1);
  assert.equal(mutations[0].method, "PUT");
  assert.deepEqual(JSON.parse(mutations[0].body), { rules: f.source, ignore_errors: false });
  const archived = readFileSync(join(f.dir, row.coverage.artifact));
  assert.equal(gunzipSync(archived).toString(), f.coverage);
  assert.equal(row.coverage.sha256, createHash("sha256").update(archived).digest("hex"));
  assert.equal(row.coverage.sourceBytes, Buffer.byteLength(f.coverage));
  assert.equal(row.rulesSha256, createHash("sha256").update(f.rules).digest("hex"));
  assert.equal(row.freshCoverage.retainedValues, 0);
  assert.equal(row.anonymousProbeStatus, 403);
  assert.deepEqual(row.warnings, [{ severity: "WARNING", description: "Unused function: canEdit." }], "successful compiler warnings are preserved, not treated as errors");
  assert.equal(f.boundary.ready(), true, "Firestore must leave the shared boundary ready for RTDB recycling");
  assert.deepEqual(readFileSync(join(f.dir, "maintenance.jsonl"), "utf8").trim().split("\n").map(s => JSON.parse(s).event), ["firestore-coverage-recycle-start", "firestore-coverage-recycled"]);
});

test("Firestore recycling refuses a live browser, unsafe boundary, foreign project or unpinned runtime", async () => {
  for (const mutate of [f => f.state.browsers.push({ mark: "live" }), f => { f.boundary.unsafe = true; }, f => { f.target.projectId = "demo-another"; }, f => { f.options.pin = async () => { throw Error("unpinned runtime"); }; }]) {
    const f = fixture(); mutate(f);
    await assert.rejects(recycleFirestoreCoverage(f.target, f.options), /maintenance refused|unpinned runtime/);
    assert.equal(f.calls.length, 0, "refusal precedes all network requests");
  }
});

test("changed rules, archive failure, changed boundary or staged source refuse before mutation", async () => {
  for (const mode of ["rules", "archive", "boundary", "source"]) {
    const f = fixture(), original = f.options.fetchImpl; let inspections = 0;
    f.options.inspect = () => { if (++inspections === 2 && mode === "boundary") f.state.locks.exclusive.pid = 999; return f.state; };
    f.options.fetchImpl = async (url, options) => {
      if (mode === "rules" && url.endsWith(":securityRules")) return Response.json({ rules: { files: [{ content: "changed" }] } });
      if (url.endsWith(":ruleCoverage")) {
        if (mode === "archive") return new Response("failed", { status: 500 });
        if (mode === "source") writeFileSync(join(f.tree, "firestore.rules"), "changed");
      }
      return original(url, options);
    };
    await assert.rejects(recycleFirestoreCoverage(f.target, f.options), /maintenance refused/);
    assert.equal(f.calls.filter(c => c.method).length, 0, `${mode} must not mutate rules`);
  }
});

test("failed reapply, changed rules, retained values, malformed fresh coverage and enforcement drift cannot complete maintenance", async () => {
  for (const mode of ["put", "issues", "after", "retained", "nested-retained", "empty", "large", "fresh-rules", "denial"]) {
    const f = fixture(), original = f.options.fetchImpl; let wrote = false;
    f.options.fetchImpl = async (url, options) => {
      if (options?.method === "PUT") {
        wrote = true;
        if (mode === "put") return new Response("failed", { status: 500 });
        if (mode === "issues") return Response.json({ issues: [{ severity: "ERROR" }] });
      }
      if (wrote && !options?.method && url.endsWith(":securityRules") && mode === "after") return Response.json({ rules: {} });
      if (wrote && url.endsWith(":ruleCoverage")) {
        if (mode === "retained") return Response.json(JSON.parse(f.coverage));
        if (mode === "nested-retained") return Response.json({ rules: f.source, report: [{ sourcePosition: { line: 1 }, children: [{ values: [{ value: "retained" }] }] }] });
        if (mode === "empty") return Response.json({ rules: f.source, report: [] });
        if (mode === "large") return new Response("x".repeat(1024 * 1024 + 1));
        if (mode === "fresh-rules") return Response.json({ rules: {}, report: [{ sourcePosition: { line: 1 } }] });
      }
      if (wrote && mode === "denial" && url.includes("/e2e_maintenance_probe/missing")) return new Response("{}", { status: 404 });
      return original(url, options);
    };
    await assert.rejects(recycleFirestoreCoverage(f.target, f.options), /maintenance refused/, mode);
    const journal = readFileSync(join(f.dir, "maintenance.jsonl"), "utf8").trim().split("\n").map(s => JSON.parse(s));
    assert.equal(journal.length, 1, `${mode} must retain only the started event`);
    assert.ok(readFileSync(join(f.dir, journal[0].coverage.artifact)).length > 0, "pre-mutation diagnostics survive failure");
  }
});
