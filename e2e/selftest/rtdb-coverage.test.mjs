// SPDX-License-Identifier: Apache-2.0
// Challenge the quiescent-boundary, identical-rules and evidence-preservation guards around local RTDB coverage recycling (SPEC §12).

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { CoverageBoundary, RTDB_COVERAGE_PIN, assertCoverageBoundary, coverageMaintenanceEligible, recycleRtdbCoverage } from "../lib/rtdb-coverage.mjs";
import { tempDir } from "./helpers/tmp.mjs";

function fixture() {
  const root = tempDir("e2e-rtdb-coverage-"), tree = join(root, "tree"), dir = join(root, "invocation");
  mkdirSync(tree); mkdirSync(dir);
  const rules = Buffer.from('{"rules":{".read":false,".write":false}}\n');
  writeFileSync(join(tree, "firebase.json"), JSON.stringify({ database: { rules: "database.rules.json" } }));
  writeFileSync(join(tree, "database.rules.json"), rules);
  const target = { kind: "local", runId: "fixture", projectId: "demo-bikeshed", capabilities: new Set(["rtdb-rules"]), databaseURL: "http://127.0.0.1:38128?ns=demo-bikeshed", stack: { treeDir: tree, ports: { database: 38128 } } };
  const state = { invocation: { runId: target.runId, pid: 123, parallelism: { concurrency: 1 }, maintenance: { rtdbCoverage: true }, locks: { concurrency: { mode: "exclusive" } } }, locks: { exclusive: { pid: 123, runId: target.runId, tier: "concurrency", mode: "exclusive" }, shared: [] }, browsers: [] };
  const boundary = new CoverageBoundary(); boundary.enter();
  const calls = [], coverage = JSON.stringify({ rules: rules.toString(), report: { expression: { values: [{ value: "unique payload", count: 12 }] } } });
  let stored = rules, retained = true;
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, ...options });
    const path = new URL(url).pathname;
    if (path === "/.settings/rules.json") {
      if (options.method === "PUT") { const next = Buffer.from(options.body); if (!next.equals(stored)) retained = false; stored = next; return new Response("{}"); }
      return new Response(stored);
    }
    if (path === "/.inspect/coverage.json") return new Response(retained ? coverage : JSON.stringify(JSON.stringify({ rules: stored.toString(), report: { expression: { values: [] } } })), { headers: { "content-type": "application/json" } });
    if (path === "/.json") return new Response('{"error":"Permission denied"}', { status: 401 });
    throw new Error(`unexpected path ${path}`);
  };
  const options = { boundary, caseName: "next measured case", invocationDir: dir, inspect: () => state, pin: async () => RTDB_COVERAGE_PIN, fetchImpl };
  return { target, state, boundary, calls, rules, root, tree, dir, coverage, options };
}

test("recycling archives exact coverage and restores exact rules after a whitespace-only round trip before the next body", async () => {
  const f = fixture(); let row;
  await assert.doesNotReject(async () => { row = await recycleRtdbCoverage(f.target, f.options); }, "valid quiescent round trip completes");
  const mutations = f.calls.filter(c => c.method);
  assert.equal(mutations.length, 2); assert.equal(new URL(mutations[0].url).pathname, "/.settings/rules.json");
  assert.equal(mutations[0].method, "PUT"); assert.deepEqual(Buffer.from(mutations[0].body), Buffer.concat([f.rules, Buffer.from("\n")]));
  assert.deepEqual(Buffer.from(mutations[1].body), f.rules);
  assert.deepEqual(row.freshCoverage.retainedValues, 0);
  assert.equal(f.calls[1].url.includes("/.inspect/coverage.json"), true, "coverage is captured before the rules replacement");
  const archived = readFileSync(join(f.dir, row.coverage.artifact));
  assert.equal(gunzipSync(archived).toString(), f.coverage);
  assert.equal(row.coverage.sha256, createHash("sha256").update(archived).digest("hex"));
  assert.equal(row.coverage.sourceBytes, Buffer.byteLength(f.coverage));
  assert.equal(row.rulesSha256, createHash("sha256").update(f.rules).digest("hex"));
  assert.deepEqual(readFileSync(join(f.dir, "maintenance.jsonl"), "utf8").trim().split("\n").map(x => JSON.parse(x).event), ["rtdb-coverage-recycle-start", "rtdb-coverage-recycled"]);
  assert.equal(f.boundary.ready(), false, "the same empty boundary is not recycled repeatedly");
});

test("only a live serial exclusive local invocation without any browser may recycle", () => {
  for (const mutate of [
    f => { f.boundary.unsafe = true; }, f => { f.boundary.active = 2; },
    f => { f.target.kind = "prod"; }, f => { f.target.capabilities.clear(); },
    f => { f.state.invocation.runId = "another"; }, f => { f.state.invocation.maintenance.rtdbCoverage = false; },
    f => { f.state.invocation.parallelism.concurrency = 2; }, f => { f.state.invocation.locks.concurrency.mode = "shared"; },
    f => { f.state.invocation.endedAt = "finished"; }, f => { f.state.locks.exclusive.pid = 456; },
    f => { f.state.locks.exclusive.runId = "another"; }, f => { f.state.locks.shared.push({ pid: 456 }); },
    f => { f.state.browsers.push({ mark: "123.1.789.1.01234567" }); },
    f => { f.state.browsers.push({ mark: "456.1.789.1.01234567" }); },
  ]) {
    const f = fixture(); mutate(f);
    assert.throws(() => assertCoverageBoundary({ target: f.target, boundary: f.boundary, ...f.state }), /maintenance refused/);
  }
});

test("unfinished bodies, unfinished cleanup and pending requests prevent all subsequent recycling", () => {
  for (const patch of [{ settled: false }, { closed: false }, { pending: 1 }]) {
    const b = new CoverageBoundary(); b.enter(); b.leave({ settled: true, closed: true, usedBrowsers: true, ...patch }); b.enter();
    assert.equal(b.ready(), false);
  }
  const b = new CoverageBoundary(); b.enter(); b.enter(); assert.equal(b.ready(), false, "concurrent body never qualifies");
  b.leave({ settled: true, closed: true, usedBrowsers: true }); assert.equal(b.ready(), true);
  b.recycled(); b.leave({ settled: true, closed: true, usedBrowsers: false }); b.enter(); assert.equal(b.ready(), false, "a read-only judge creates no new browser coverage");
  b.leave({ settled: true, closed: true, usedBrowsers: true }); b.enter(); assert.equal(b.ready(), true);
});

test("a changed rule, failed coverage archive or changed boundary refuses before any mutation", async () => {
  for (const mode of ["rules", "archive", "boundary", "source"]) {
    const f = fixture(), original = f.options.fetchImpl; let inspections = 0, attemptedPuts = 0;
    f.options.inspect = () => { if (++inspections === 2 && mode === "boundary") f.state.locks.exclusive.pid = 9; return f.state; };
    f.options.fetchImpl = async (url, options) => {
      if (options?.method === "PUT") attemptedPuts++;
      if (mode === "rules" && url.includes("/.settings/")) return new Response("different");
      if (url.includes("/.inspect/")) {
        if (mode === "archive") return new Response("not found", { status: 404 });
        if (mode === "source") writeFileSync(join(f.tree, "database.rules.json"), "changed");
      }
      return original(url, options);
    };
    await assert.rejects(recycleRtdbCoverage(f.target, f.options), /maintenance refused/);
    assert.equal(attemptedPuts, 0, `${mode} cannot mutate rules`);
  }
});

test("failed or inconsistent reinstall and a lost rules denial fail after recording mutation intent", async () => {
  for (const mode of ["put", "temporary", "restore", "after", "fresh", "fresh-rules", "fresh-empty", "fresh-large", "denial"]) {
    const f = fixture(), original = f.options.fetchImpl; let wrote = false, puts = 0;
    f.options.fetchImpl = async (url, options) => {
      if (options?.method === "PUT") { wrote = true; puts++; if ((mode === "put" && puts === 1) || (mode === "restore" && puts === 2)) { await original(url, options); return new Response("failed", { status: 500 }); } }
      if (wrote && url.includes("/.inspect/")) {
        if (mode === "fresh") return new Response(f.coverage, { headers: { "content-type": "application/json" } });
        if (mode === "fresh-rules") return new Response(JSON.stringify({ rules: "wrong", report: { values: [] } }));
        if (mode === "fresh-empty") return new Response(JSON.stringify({ rules: f.rules.toString(), report: {} }));
        if (mode === "fresh-large") return new Response("x".repeat(1024 * 1024 + 1));
      }
      if (puts === 1 && mode === "temporary" && url.includes("/.settings/") && !options?.method) return new Response("changed");
      if (puts === 2 && mode === "after" && url.includes("/.settings/") && !options?.method) return new Response("changed");
      if (mode === "denial" && new URL(url).pathname === "/.json") return new Response("{}");
      return original(url, options);
    };
    await assert.rejects(recycleRtdbCoverage(f.target, f.options), /maintenance refused/);
    const journal = readFileSync(join(f.dir, "maintenance.jsonl"), "utf8").trim().split("\n").map(x => JSON.parse(x));
    assert.equal(journal.length, 1); assert.equal(journal[0].event, "rtdb-coverage-recycle-start");
    assert.equal(readdirSync(join(f.dir, "rtdb-coverage")).length, 1, "pre-mutation diagnostic survives failure");
    assert.equal(f.boundary.needed, true, "a failed reset is never reported completed");
    assert.equal(puts, 2, "an exact-byte restoration is attempted even when the temporary request fails");
  }
});

test("the installed pinned Database tracker retains strings while an actual replacement starts empty", async t => {
  const { firebaseTools } = await import("../lib/prerequisites.mjs");
  if (!firebaseTools({ optional: true })) { t.skip("firebase-tools is not installed; no installed-runtime proof"); return; }
  const { probeRtdbCoverage, assertRetentionBehavior } = await import("../../tools/probe-e2e-rtdb-coverage.mjs");
  const proof = await probeRtdbCoverage();
  assert.deepEqual(proof.toolchain, RTDB_COVERAGE_PIN);
  assertRetentionBehavior(proof.behavior);
  for (const field of Object.keys(proof.behavior)) assert.throws(() => assertRetentionBehavior({ ...proof.behavior, [field]: -1 }), /retains every distinct string/);
});

test("the runner enables maintenance only for the serial local exclusive concurrency tier", () => {
  for (const kind of ["local", "prod"]) for (const tier of ["smoke", "functional", "concurrency"]) for (const mode of ["shared", "exclusive"]) for (const parallel of [1, 2]) {
    assert.equal(coverageMaintenanceEligible({ kind }, tier, mode, parallel), kind === "local" && tier === "concurrency" && mode === "exclusive" && parallel === 1, `${kind}/${tier}/${mode}/${parallel}`);
  }
});
