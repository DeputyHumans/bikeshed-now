// SPDX-License-Identifier: Apache-2.0
// Self-test: concurrent invocations on one run get their own directories, results and evidence, and never see each other's (SPEC §12).

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { OUT_DIR } from "../lib/paths.mjs";
import { INVOCATION_ID_RE, createInvocation, evidenceRoot, nodeTestArgs, readInvocationMeta } from "../lib/invocation.mjs";
import { listInvocations, mergeRun, runDirOf } from "../lib/report.mjs";

const runId = `selftest-inv-${process.pid}`;
const runDir = join(OUT_DIR, runId);
after(() => rmSync(runDir, { recursive: true, force: true }));

function racer(count, startAt) {
  const helper = fileURLToPath(new URL("./helpers/claim-dirs.mjs", import.meta.url));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [helper, runDir, String(count), String(startAt)], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.on("close", (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(`racer exited ${code}: ${err}`))));
  });
}

test("eight processes claiming invocations and same-named evidence at once never share a directory", async () => {
  mkdirSync(runDir, { recursive: true });
  const startAt = Date.now() + 1500;
  const all = await Promise.all(Array.from({ length: 8 }, () => racer(25, startAt)));
  const invs = all.flatMap((r) => r.invocations);
  const evs = all.flatMap((r) => r.evidence);
  assert.equal(new Set(invs).size, invs.length, "every invocation directory is its own");
  assert.equal(new Set(evs).size, evs.length, `every evidence directory is its own (${evs.length - new Set(evs).size} shared)`);
  for (const d of invs) {
    const meta = readInvocationMeta(d);
    assert.ok(INVOCATION_ID_RE.test(meta.id), meta.id);
    assert.equal(d.endsWith(meta.id), true);
  }
});

test("two invocations on one run: each merges only its own results; a run id with two needs naming one", () => {
  const dir = join(OUT_DIR, `${runId}-m`);
  try {
    mkdirSync(dir, { recursive: true });
    const a = createInvocation(dir, { runId: `${runId}-m`, suite: "functional", plan: [{ tier: "functional", files: ["e2e/specs/functional/a.spec.mjs"] }] });
    const rec = (name, status) => JSON.stringify({ id: `e2e/specs/functional/a.spec.mjs::${name}`, file: "e2e/specs/functional/a.spec.mjs", name, path: [name], status, suite: "functional" });
    writeFileSync(join(a.dir, "results-functional.jsonl"), `${rec("A-case-0", "pass")}\n${rec("A-case-1", "pass")}\n`);
    assert.equal(runDirOf(`${runId}-m`), a.dir, "one invocation: the run id names it");
    const b = createInvocation(dir, { runId: `${runId}-m`, suite: "functional" });
    writeFileSync(join(b.dir, "results-functional.jsonl"), `${rec("B-case-0", "pass")}\n`);
    assert.notEqual(a.dir, b.dir);
    assert.deepEqual(mergeRun(a.dir).results.cases.map((c) => c.name), ["A-case-0", "A-case-1"]);
    assert.deepEqual(mergeRun(b.dir).results.cases.map((c) => c.name), ["B-case-0"]);
    assert.equal(readFileSync(join(a.dir, "results-functional.jsonl"), "utf8").split("\n").filter(Boolean).length, 2, "B never touched A's file");
    assert.throws(() => runDirOf(`${runId}-m`), /has 2 invocations; name one/);
    assert.equal(runDirOf(`${runId}-m/${b.id}`), b.dir);
    assert.deepEqual(listInvocations(dir), [a.id, b.id].sort());
    assert.equal(mergeRun(a.dir).results.invocation.plan[0].tier, "functional", "results.json records the invocation's selection");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("evidenceRoot is the invocation's directory, and refuses one outside the run", () => {
  const target = { runDir };
  assert.equal(evidenceRoot(target, {}), runDir);
  assert.equal(evidenceRoot(target, { E2E_INVOCATION_DIR: join(runDir, "invocations", "x") }), join(runDir, "invocations", "x"));
  assert.throws(() => evidenceRoot(target, { E2E_INVOCATION_DIR: join(OUT_DIR, "elsewhere") }), /not inside run/);
});

test("nodeTestArgs: force-exit always, both reporters, the name pattern", () => {
  const args = nodeTestArgs({ files: ["a.spec.mjs"], resultsFile: "/r.jsonl", reporter: "./rep.mjs", concurrency: 2, timeout: 1000, grep: "^x$" });
  assert.ok(args.includes("--test-force-exit"), "a body that never settles cannot keep the run alive");
  assert.deepEqual(args.slice(-1), ["a.spec.mjs"]);
  for (const a of ["--test-concurrency=2", "--test-timeout=1000", "--test-reporter=./rep.mjs", "--test-reporter-destination=/r.jsonl", "--test-name-pattern=^x$"]) assert.ok(args.includes(a), a);
  assert.ok(!existsSync("/r.jsonl"));
});
