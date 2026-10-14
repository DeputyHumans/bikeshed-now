// SPDX-License-Identifier: Apache-2.0
// Self-test: `report --merge` reads every invocation of a run as one table — latest outcome that ran, its invocation, FLAKY — and compare is unchanged (SPEC §12).

/**
 * Three invocations of one run are written the way run.mjs writes them
 * (createInvocation + results-<tier>.jsonl), as parallel agents attached to a
 * shared stack would leave them, then merged through the library and through
 * run.mjs. No stack, no browser.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { E2E_DIR, OUT_DIR, ensureDir } from "../lib/paths.mjs";
import { createInvocation, newInvocationId, INVOCATIONS_DIR } from "../lib/invocation.mjs";
import { classify as classifyOne, classifyMerged, compareRuns, mergeInvocations, mergeRun, runDirOf, runRootOf } from "../lib/report.mjs";
import { mkdirSync } from "node:fs";

const runId = `selftest-merge-${process.pid}`;
const runDir = join(OUT_DIR, runId);
const env = () => {
  const e = { ...process.env };
  delete e.NODE_TEST_CONTEXT;
  return e;
};
const rec = (spec, name, status, extra = {}) => ({ id: `e2e/specs/functional/${spec}::${name}`, file: `e2e/specs/functional/${spec}`, name, path: [name], suite: "functional", runId, status, at: extra.at ?? new Date().toISOString(), ...extra });
const invs = [];

/** One invocation directory with these records, its id forced to sort in order. */
function invocation(stamp, meta, records) {
  const id = newInvocationId(new Date(stamp), 4242);
  const dir = join(runDir, INVOCATIONS_DIR, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "invocation.json"), JSON.stringify({ id, runId, startedAt: new Date(stamp).toISOString(), suite: "functional", plan: [{ tier: "functional", files: [...new Set(records.map((r) => r.file))] }], spec: meta.spec ?? [], grep: null, n: null, exit: meta.exit ?? 0 }));
  writeFileSync(join(dir, "results-functional.jsonl"), records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  invs.push({ id, dir });
  return { id, dir };
}

before(() => {
  ensureDir(runDir);
  // A: the comments area. B: the export area, plus a rerun of one comment case. C: comments again.
  invocation("2026-10-10T10:00:00Z", { spec: ["comments"] }, [
    rec("comments.spec.mjs", "comment on a passage", "pass"),
    rec("comments.spec.mjs", "reply in a thread", "fail", { error: { message: "no reply" } }),
    rec("comments.spec.mjs", "resolve a thread", "pass"),
    rec("comments.spec.mjs", "mail on comment", "skip", { skipReason: "needs mailpit" }),
    rec("comments.spec.mjs", "known S3 here", "todo", { todo: "known defect S3", outcome: "failed-as-expected" }),
  ]);
  invocation("2026-10-10T10:05:00Z", { spec: ["export"] }, [
    rec("export.spec.mjs", "export a zip", "pass"),
    rec("export.spec.mjs", "export a pdf", "inconclusive", { inconclusive: "spread 41 ms" }),
    rec("comments.spec.mjs", "reply in a thread", "pass"),
  ]);
  invocation("2026-10-10T10:10:00Z", { spec: ["comments"] }, [
    rec("comments.spec.mjs", "comment on a passage", "pass"),
    rec("comments.spec.mjs", "reply in a thread", "fail", { error: { message: "no reply again" } }),
    rec("comments.spec.mjs", "resolve a thread", "skip", { skipReason: "N=5 not selected" }),
    rec("comments.spec.mjs", "mail on comment", "pass"),
    rec("comments.spec.mjs", "known S3 here", "todo", { todo: "known defect S3", outcome: "passed-unexpectedly" }),
  ]);
});

const extraRuns = [];
after(() => {
  rmSync(runDir, { recursive: true, force: true });
  for (const d of extraRuns) rmSync(d, { recursive: true, force: true });
});

/** A run of its own for one test: `add(stamp, pid, records)` writes one invocation into it. */
function scratchRun(label) {
  const id = `selftest-merge-${label}-${process.pid}`;
  const dir = join(OUT_DIR, id);
  rmSync(dir, { recursive: true, force: true });
  ensureDir(dir);
  extraRuns.push(dir);
  const add = (stamp, pid, records) => {
    const invId = newInvocationId(new Date(stamp), pid);
    const d = join(dir, INVOCATIONS_DIR, invId);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "invocation.json"), JSON.stringify({ id: invId, runId: id, startedAt: new Date(stamp).toISOString(), suite: "functional", plan: [{ tier: "functional", files: [...new Set(records.map((r) => r.file))] }], spec: [], grep: null, n: null, exit: 0 }));
    writeFileSync(join(d, "results-functional.jsonl"), records.map((r) => JSON.stringify({ ...r, runId: id })).join("\n") + "\n");
    return { id: invId, dir: d };
  };
  return { id, dir, add };
}

const byName = (results) => Object.fromEntries(results.cases.map((c) => [c.name, c]));

test("one table across every invocation: the latest outcome that RAN, the invocation that produced it", () => {
  const { results, summary, dir } = mergeInvocations(runId);
  assert.equal(dir, runDir);
  assert.equal(results.invocations.length, 3);
  assert.equal(results.cases.length, 7, "every case id once");
  const c = byName(results);
  assert.deepEqual([c["comment on a passage"].status, c["comment on a passage"].invocation], ["pass", invs[2].id]);
  assert.deepEqual([c["export a zip"].status, c["export a zip"].invocation], ["pass", invs[1].id]);
  assert.deepEqual([c["export a pdf"].status, c["export a pdf"].inconclusive], ["inconclusive", "spread 41 ms"]);
  assert.deepEqual([c["reply in a thread"].status, c["reply in a thread"].invocation, c["reply in a thread"].error.message], ["fail", invs[2].id, "no reply again"]);
  assert.deepEqual([c["resolve a thread"].status, c["resolve a thread"].invocation], ["pass", invs[0].id], "a later SKIP does not hide the pass that ran");
  assert.deepEqual([c["mail on comment"].status, c["mail on comment"].invocation], ["pass", invs[2].id], "a later run replaces an earlier skip");
  assert.deepEqual(c["reply in a thread"].history.map((h) => [h.invocation, h.label]), [[invs[0].id, "fail"], [invs[1].id, "pass"], [invs[2].id, "fail"]]);
  assert.deepEqual(summary.counts, { pass: 4, fail: 1, inconclusive: 1, todo: 1, skip: 0 });
});

test("FLAKY: outcomes that ran differed between invocations — a skip is not an outcome", () => {
  const { results, summary } = mergeInvocations(runId);
  const c = byName(results);
  assert.equal(c["reply in a thread"].flaky, true, "fail → pass → fail");
  assert.equal(c["known S3 here"].flaky, true, "failed-as-expected in one, passed-unexpectedly in another");
  assert.equal(c["resolve a thread"].flaky, false, "pass then skip is not flaky");
  assert.equal(c["mail on comment"].flaky, false, "skip then pass is not flaky");
  assert.equal(c["comment on a passage"].flaky, false, "pass twice");
  assert.deepEqual(summary.flaky.map((f) => f.id.split("::")[1]).sort(), ["known S3 here", "reply in a thread"]);
  const md = readFileSync(join(runDir, "merged.md"), "utf8");
  assert.match(md, /\| e2e\/specs\/functional\/comments\.spec\.mjs::reply in a thread \| fail \| [^|]+ \| \*\*FLAKY\*\*: fail → pass → fail \|/);
  assert.match(md, /2 FLAKY/);
  assert.match(md, /## Invocations/);
});

test("classify --merge resolves an id against the merged view and keeps it at the run level; an invocation's own still shows", () => {
  const own = mergeRun(invs[1].dir);
  assert.ok(own, "an invocation still merges on its own");
  const c = classifyMerged(runId, "reply in a thread", "P", "reply lost under load");
  assert.deepEqual([c.class, c.invocation, c.flaky], ["P", invs[2].id, true]);
  assert.ok(existsSync(join(runDir, "classifications.json")));
  const { results } = mergeInvocations(runId);
  assert.equal(byName(results)["reply in a thread"].classification.note, "reply lost under load");
  assert.ok(!results.summary.unclassified.some((id) => id.endsWith("reply in a thread")));
  assert.throws(() => classifyMerged(runId, "comments.spec.mjs", "H", "ambiguous"), /cases match/);
});

test("run.mjs: report --merge prints the table; classify --merge records; a plain report on a multi-invocation run still refuses", () => {
  const rep = spawnSync(process.execPath, [join(E2E_DIR, "run.mjs"), "report", runId, "--merge"], { encoding: "utf8", env: env() });
  assert.equal(rep.status, 0, rep.stderr);
  assert.match(rep.stdout, /merged across 3 invocation\(s\)/);
  assert.match(rep.stdout, /\*\*FLAKY\*\*/);
  const plain = spawnSync(process.execPath, [join(E2E_DIR, "run.mjs"), "report", runId], { encoding: "utf8", env: env() });
  assert.notEqual(plain.status, 0);
  assert.match(plain.stderr, /3 invocations.*--merge/s);
  const cls = spawnSync(process.execPath, [join(E2E_DIR, "run.mjs"), "classify", "--merge", runId, "known S3 here", "U", "flaky", "defect"], { encoding: "utf8", env: env() });
  assert.equal(cls.status, 0, cls.stderr);
  assert.equal(JSON.parse(cls.stdout).note, "flaky defect");
  assert.equal(runRootOf(`${runId}/${invs[0].id}`), runDir, "an invocation reference names its run");
  assert.throws(() => runDirOf(runId), /--merge/);
});

test("compare is unchanged: it still compares two invocations, not merged views", () => {
  const cmp = compareRuns(invs[0].dir, invs[2].dir);
  assert.deepEqual(cmp.lost.map((x) => x.id.split("::")[1]), ["resolve a thread"], "pass → skip is still LOST between two invocations");
  assert.deepEqual(cmp.regressions, []);
});

test("the latest outcome is the one that FINISHED last (the record's own time), not the one whose invocation STARTED last", () => {
  const run = scratchRun("order");
  // A starts first but runs the case late; B starts later and runs it early.
  const A = run.add("2026-10-10T10:00:00Z", 4242, [
    rec("order.spec.mjs", "late pass", "pass", { at: "2026-10-10T10:40:00.000Z" }),
    rec("order.spec.mjs", "no time", "fail", { at: undefined, error: { message: "first" } }),
  ]);
  const B = run.add("2026-10-10T10:05:00Z", 4242, [
    rec("order.spec.mjs", "late pass", "fail", { at: "2026-10-10T10:06:00.000Z", error: { message: "early fail" } }),
    rec("order.spec.mjs", "no time", "pass", { at: undefined }),
  ]);
  // Started in the same second: the ids then sort by "p<pid>" as TEXT, so p10 sorts before p9.
  const P9 = run.add("2026-10-10T11:00:00Z", 9, [rec("order.spec.mjs", "same second", "fail", { at: "2026-10-10T11:00:30.000Z", error: { message: "older" } })]);
  const P10 = run.add("2026-10-10T11:00:00Z", 10, [rec("order.spec.mjs", "same second", "pass", { at: "2026-10-10T11:00:50.000Z" })]);
  assert.ok(P10.id < P9.id, "the trap is set: p10's invocation id sorts first");
  for (const r of [A, B, P9, P10]) assert.ok(r.id);
  const { results } = mergeInvocations(run.id);
  const c = byName(results);
  assert.deepEqual([c["late pass"].status, c["late pass"].invocation], ["pass", A.id], "A's 10:40 pass is newer than B's 10:06 fail");
  assert.deepEqual(c["late pass"].history.map((h) => [h.invocation, h.status]), [[B.id, "fail"], [A.id, "pass"]], "history in the order the outcomes happened");
  assert.deepEqual([c["same second"].status, c["same second"].invocation], ["pass", P10.id], "not decided by the pid's spelling");
  assert.deepEqual([c["no time"].status, c["no time"].invocation], ["pass", B.id], "without a record time, invocation order decides");
  const pinned = classifyMerged(run.id, "late pass", "U", "pinned to the newest outcome");
  assert.equal(pinned.invocation, A.id, "classify --merge pins the outcome that is really the latest");
});

test("a run-level classification applies only while it matches the latest outcome; a newer outcome shows it STALE and the case unclassified", () => {
  const run = scratchRun("stale");
  const B = run.add("2026-10-10T10:05:00Z", 4242, [rec("stale.spec.mjs", "save a draft", "fail", { at: "2026-10-10T10:06:00.000Z", error: { message: "timeout: machine overloaded" } })]);
  const made = classifyMerged(run.id, "save a draft", "E", "machine overloaded at 10:06");
  assert.deepEqual([made.invocation, made.status, made.recordAt], [B.id, "fail", "2026-10-10T10:06:00.000Z"], "the classification records the outcome it was made against");
  let { results } = mergeInvocations(run.id);
  assert.equal(byName(results)["save a draft"].classification?.class, "E", "it applies to the outcome it was made against");
  assert.deepEqual(results.summary.unclassified, []);

  // A parallel agent's new invocation fails the same case for a different reason.
  const C = run.add("2026-10-10T10:20:00Z", 4242, [rec("stale.spec.mjs", "save a draft", "fail", { at: "2026-10-10T10:21:00.000Z", error: { message: "TypeError: product crashed" } })]);
  ({ results } = mergeInvocations(run.id));
  const c = byName(results)["save a draft"];
  assert.deepEqual([c.invocation, c.error.message], [C.id, "TypeError: product crashed"]);
  assert.equal(c.classification, null, "the old label does not cover the new failure");
  assert.deepEqual([c.staleClassification?.stale, c.staleClassification?.class, c.staleClassification?.invocation], [true, "E", B.id], "shown, marked stale, with what it was made against");
  assert.deepEqual(results.summary.unclassified.map((id) => id.split("::")[1]), ["save a draft"], "the new failure is back in triage");
  assert.deepEqual(results.summary.staleClassifications.map((x) => [x.id.split("::")[1], x.madeAgainst, x.latest]), [["save a draft", B.id, C.id]]);
  const md = readFileSync(join(run.dir, "merged.md"), "utf8");
  assert.match(md, /\| e2e\/specs\/functional\/stale\.spec\.mjs::save a draft \| fail \| [^|]+ \|  \| STALE: E: machine overloaded at 10:06 \(made against [^)]+\) \|/);

  // An invocation's own classification of the latest outcome applies; the stale run-level one stays visible.
  mergeRun(C.dir);
  classifyOne(C.dir, "save a draft", "P", "crash in save");
  ({ results } = mergeInvocations(run.id));
  assert.deepEqual([byName(results)["save a draft"].classification?.class, byName(results)["save a draft"].staleClassification?.class], ["P", "E"]);
  assert.deepEqual(results.summary.unclassified, []);

  // Re-classifying at the run level makes it current again.
  classifyMerged(run.id, "save a draft", "P", "product crash, reproduced");
  ({ results } = mergeInvocations(run.id));
  assert.deepEqual([byName(results)["save a draft"].classification?.note, byName(results)["save a draft"].staleClassification], ["product crash, reproduced", undefined]);
  assert.deepEqual(results.summary.staleClassifications, []);
});
