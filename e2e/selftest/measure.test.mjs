// SPDX-License-Identifier: Apache-2.0
// Self-test: measure() keeps a case's measurement rows in the invocation's <name>.jsonl whatever the outcome, redacted, never in a file the harness reads as its own, never outside e2e/.out (SPEC §12).

/**
 * The reason measure() exists: a PASSING case leaves no evidence directory
 * (unless E2E_EVIDENCE=always) and the reporter keeps no diagnostic line
 * but `evidence=` and `outcome=`, so the numbers of a serial control or of a
 * fixed build were lost. The last case runs a generated spec through `node
 * --test` with the real reporter, the way run.mjs runs one, and reads what
 * survived. No browser, no stack.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { createInvocation, nodeTestArgs } from "../lib/invocation.mjs";
import { E2E_DIR, E2E_TMP, OUT_DIR, REPO_ROOT, ensureDir } from "../lib/paths.mjs";
import { MEASURE_NAME_RE, RESERVED_MEASURE_NAMES, WITHHELD, measure, measureFile } from "../lib/evidence.mjs";
import { mergeRun } from "../lib/report.mjs";

const runId = `selftest-measure-${process.pid}`;
const runDir = join(OUT_DIR, runId);
let inv;
let tmp;

before(() => {
  inv = ensureDir(join(runDir, "invocations", "inv-a"), "inv");
  tmp = mkdtempSync(join(ensureDir(E2E_TMP, "E2E_TMP"), "selftest-measure-"));
});

after(() => {
  rmSync(runDir, { recursive: true, force: true });
  rmSync(tmp, { recursive: true, force: true });
});

const lines = (file) => readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const ctx = { name: "C4 positive control (serial), unpatched [N=2] #2", n: 2, trial: 2 };

test("measure appends one line per row to <invocation>/<name>.jsonl, with the case's name, N and trial", () => {
  const env = { E2E_INVOCATION_DIR: inv };
  const r1 = measure(ctx, "c04-first-join", { scenario: "C4 serial", latency: "rtt0", copies: 1 }, { env });
  const r2 = measure(ctx, "c04-first-join", { scenario: "C4 serial", latency: "rtt150", copies: 1, settledMs: 2100 }, { env });
  const other = measure({ name: "C10 work [N=2]", n: 2 }, "c10-accepts", { accepted: 2 }, { env });
  const file = join(inv, "c04-first-join.jsonl");
  assert.deepEqual([r1.file, r2.file, r1.withheld, r1.error], [file, file, false, undefined]);
  assert.equal(other.file, join(inv, "c10-accepts.jsonl"), "another name, another file");
  const rows = lines(file);
  assert.equal(rows.length, 2, "appended, never overwritten: both rows are there");
  assert.deepEqual(Object.keys(rows[0]), ["at", "case", "n", "trial", "scenario", "latency", "copies"]);
  assert.deepEqual(rows.map((r) => [r.case, r.n, r.trial, r.latency]), [[ctx.name, 2, 2, "rtt0"], [ctx.name, 2, 2, "rtt150"]]);
  assert.ok(!Number.isNaN(Date.parse(rows[0].at)), `at is a time: ${rows[0].at}`);
  assert.deepEqual(r2.line, rows[1], "the result is the line written");
  assert.deepEqual(lines(other.file).map((r) => [r.case, r.n, r.trial, r.accepted]), [["C10 work [N=2]", 2, null, 2]], "a ctx without a trial says null");
  assert.equal(measureFile("c04-first-join", env), file);
});

test("outside a run nothing is written, but a mistake still throws: a bad name, a row that is not an object or does not serialise, no ctx", () => {
  assert.equal(measure(ctx, "c04-first-join", { copies: 1 }, { env: {} }), null);
  assert.equal(measureFile("c04-first-join", {}), null);
  for (const name of ["", "C04", "a/b", "../up", "x.jsonl", "-x", "a".repeat(65), 7]) {
    assert.throws(() => measure(ctx, name, { copies: 1 }, { env: {} }), (err) => err instanceof TypeError && /a measurement name matches/.test(err.message), `name ${JSON.stringify(name)}`);
  }
  assert.ok(MEASURE_NAME_RE.test("c04-first-join"));
  for (const row of [null, [1, 2], "copies=1", 3]) assert.throws(() => measure(ctx, "c04-first-join", row, { env: {} }), TypeError, `row ${JSON.stringify(row)}`);
  const loop = { copies: 1 };
  loop.self = loop;
  assert.throws(() => measure(ctx, "c04-first-join", loop, { env: {} }), (err) => err instanceof TypeError && /does not serialise/.test(err.message));
  assert.throws(() => measure(null, "c04-first-join", { copies: 1 }, { env: {} }), TypeError);
});

test("the harness's own files are refused: report.mjs reads every results*.jsonl as the reporter's records", () => {
  const env = { E2E_INVOCATION_DIR: inv };
  for (const name of [...RESERVED_MEASURE_NAMES, "results-concurrency", "results-x"]) {
    assert.throws(() => measure(ctx, name, { copies: 1 }, { env }), (err) => err instanceof TypeError && /the harness's own file/.test(err.message), name);
    assert.ok(!existsSync(join(inv, `${name}.jsonl`)), `${name}.jsonl was not written`);
  }
  assert.deepEqual([...RESERVED_MEASURE_NAMES].sort(), ["http", "invocation", "load", "merged", "results", "rss", "summary"]);
});

test("rows are redacted like evidence, and a line in which a credential shape survives is withheld, so the row still counts", () => {
  const env = { E2E_INVOCATION_DIR: inv };
  const jwt = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyMTIzNDU2In0.c2lnbmF0dXJlLXNpZ25hdHVyZQ";
  const r = measure(ctx, "redaction", { idToken: "secret-value-1234", note: `bearer ${jwt}`, link: "/d/doc?k=LinkKey0123456789abcdef", copies: 2 }, { env });
  const text = readFileSync(r.file, "utf8");
  for (const s of ["secret-value-1234", jwt, "LinkKey0123456789abcdef"]) assert.ok(!text.includes(s), `${s.slice(0, 12)}… was redacted`);
  assert.equal(lines(r.file)[0].copies, 2, "the measurement itself is kept");
  // redact() redacts values, not keys: a link with its key used as a row's key survives it, and LEAK_RE withholds the whole line.
  const leaky = measure(ctx, "redaction", { byLink: { "/d/doc?k=LinkKey0123456789abcdef": 1 }, copies: 3 }, { env });
  assert.equal(leaky.withheld, true);
  const rows = lines(r.file);
  assert.equal(rows.length, 2, "the withheld row still counts");
  assert.deepEqual(Object.keys(rows[1]), ["at", "case", "n", "trial", "withheld"]);
  assert.deepEqual([rows[1].case, rows[1].withheld], [ctx.name, WITHHELD]);
  assert.deepEqual(leaky.line, rows[1]);
  assert.ok(!readFileSync(r.file, "utf8").includes("LinkKey0123456789abcdef"), "the link key never reached the file");
});

test("never written outside e2e/.out; an append that fails is returned, not thrown", () => {
  const outside = mkdtempSync(join(tmpdir(), "e2e-measure-out-"));
  try {
    assert.throws(() => measure(ctx, "c04-first-join", { copies: 1 }, { env: { E2E_INVOCATION_DIR: outside } }), /is not inside/);
    assert.ok(!existsSync(join(outside, "c04-first-join.jsonl")), "nothing written outside e2e/.out");
    assert.throws(() => measureFile("c04-first-join", { E2E_INVOCATION_DIR: OUT_DIR }), /is not inside/, "e2e/.out itself is no invocation");
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
  const gone = join(runDir, "invocations", "never-made");
  const r = measure(ctx, "c04-first-join", { copies: 1 }, { env: { E2E_INVOCATION_DIR: gone } });
  assert.equal(r.file, join(gone, "c04-first-join.jsonl"));
  assert.match(r.error, /ENOENT/, "the failed append is in the result: a measurement is never the case's outcome");
});

test("through node --test and the reporter: a PASSING case's rows survive (no evidence directory), a failing case's too, and the run's report reads none of them as results", () => {
  const targetFile = join(tmp, "target.json");
  writeFileSync(targetFile, JSON.stringify({ kind: "local", runId, runDir, origin: "http://127.0.0.1:9", projectId: "demo-bikeshed", capabilities: ["local"], stack: { ports: {} } }));
  const spec = join(tmp, "measure-fixture.spec.mjs");
  writeFileSync(spec, `import assert from "node:assert/strict";
import { scenario } from ${JSON.stringify(pathToFileURL(join(E2E_DIR, "lib", "test.mjs")).href)};
import { measure } from ${JSON.stringify(pathToFileURL(join(E2E_DIR, "lib", "evidence.mjs")).href)};
scenario("a serial control that passes", { n: [2], trials: 2 }, async (ctx) => {
  measure(ctx, "fixture-measure", { scenario: "serial", copies: 1, duplicated: false });
  ctx.t.diagnostic("rate: 0/1 duplicated");
});
scenario("a defect case whose oracle fails", { n: [2], trials: 1 }, async (ctx) => {
  measure(ctx, "fixture-measure", { scenario: "race", copies: 2, duplicated: true });
  assert.equal(2, 1, "I3: the sentinel appears 2 times");
});
`);
  const run = createInvocation(runDir, { runId, suite: "functional", plan: [{ tier: "functional", files: [spec] }], grep: null, n: null });
  const env = { ...process.env, E2E_TARGET: targetFile, E2E_RUN_ID: runId, E2E_SUITE: "functional", E2E_INVOCATION_DIR: run.dir };
  delete env.NODE_TEST_CONTEXT;
  delete env.E2E_N;
  delete env.E2E_TRIALS;
  delete env.E2E_EVIDENCE;
  delete env.E2E_CASE_TIMEOUT_MS;
  const proc = spawnSync(process.execPath, nodeTestArgs({ files: [spec], resultsFile: join(run.dir, "results-functional.jsonl"), reporter: join(E2E_DIR, "lib", "reporter.mjs") }), { cwd: REPO_ROOT, env, encoding: "utf8", timeout: 120_000 });
  assert.notEqual(proc.status, null, `node --test hung (stdout tail: ${proc.stdout?.slice(-600)})`);
  const records = lines(join(run.dir, "results-functional.jsonl")).filter((r) => r.file === spec);
  const status = Object.fromEntries(records.map((r) => [r.name, r.status]));
  assert.deepEqual(status, {
    "a serial control that passes [N=2] #1": "pass",
    "a serial control that passes [N=2] #2": "pass",
    "a defect case whose oracle fails [N=2]": "fail",
  });
  const passing = records.filter((r) => r.status === "pass");
  assert.deepEqual(passing.map((r) => r.evidenceDir ?? null), [null, null], "a pass leaves no evidence directory");
  assert.ok(!JSON.stringify(records).includes("rate: 0/1"), "and the reporter keeps no diagnostic of its own: the reason measure() exists");
  const rows = lines(join(run.dir, "fixture-measure.jsonl"));
  assert.deepEqual(rows.map((r) => [r.case, r.n, r.trial, r.scenario, r.copies]).sort(), [
    ["a defect case whose oracle fails [N=2]", 2, 1, "race", 2],
    ["a serial control that passes [N=2] #1", 2, 1, "serial", 1],
    ["a serial control that passes [N=2] #2", 2, 2, "serial", 1],
  ]);
  const { summary } = mergeRun(run.dir);
  assert.equal(summary.total, 3, `the report counts the 3 cases and no measurement row as a record: ${JSON.stringify(summary.counts)}`);
});
