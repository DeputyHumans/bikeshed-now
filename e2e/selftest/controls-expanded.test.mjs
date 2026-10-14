// SPDX-License-Identifier: Apache-2.0
// Self-test: a negative control may target an expanded case "<scenario> [N=k]", which both of its runs select with --n k --trials 1, and a literal target runs exactly as before (SPEC §12).

/**
 * A scenario with `n` declares one name and runs as "<name> [N=k]" (and
 * "… [N=k] #t" with several trials). assertTargetDeclared used to look for
 * the target's name verbatim in the spec, so a control could never target
 * such a case. The chain this test closes: the selection targetSelection
 * makes → the run arguments run.mjs passes (greenRunArgs / redRunArgs) →
 * the cases scenario() expands to under them (lib/test.mjs expand, with
 * E2E_N and E2E_TRIALS as run.mjs sets them) → the --grep → findTarget.
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { OUT_DIR, REPO_ROOT } from "../lib/paths.mjs";
import {
  assertTargetDeclared, declaresName, findTarget, greenGroups, greenRunArgs, grepFor, listControlSets, parseExpandedCase, readControl, redRunArgs, targetCaseName, targetSelection,
} from "../lib/controls.mjs";
import { TRIALS_ENV, expand } from "../lib/test.mjs";

const SCENARIO = 'C9 a race: every "Shared" peer converges';
const SRC = `scenario(${JSON.stringify(SCENARIO)}, { n: [2, 5, 10, 20] }, async () => {});
scenario('canary: two editors join as "Shared"', { n: [2, 5] }, async () => {});
scenario("C9 canary [N=2]", {}, async () => {});
scenario('it\\'s quoted', {}, async () => {});
`;
const ctl = (name, extra = {}) => ({ set: "controls-x", oracle: "X", what: "w", target: { spec: "e2e/specs/concurrency/x.spec.mjs", case: name, suite: "concurrency" }, stack: [], expect: { message: "m" }, patches: ["10-x.patch"], ...extra });
const withSel = (c, src = SRC) => ({ ...c, selection: targetSelection(c, src) });

const saved = { trials: process.env[TRIALS_ENV], n: process.env.E2E_N };
after(() => {
  for (const [k, env] of [["trials", TRIALS_ENV], ["n", "E2E_N"]]) {
    if (saved[k] === undefined) delete process.env[env];
    else process.env[env] = saved[k];
  }
});

test("parseExpandedCase reads '<scenario> [N=k]' and an optional ' #t'; anything else is not expanded", () => {
  assert.deepEqual(parseExpandedCase(`${SCENARIO} [N=2]`), { scenario: SCENARIO, n: 2, trial: null });
  assert.deepEqual(parseExpandedCase("X [N=20] #1"), { scenario: "X", n: 20, trial: 1 });
  assert.deepEqual(parseExpandedCase("A [N=2] [N=5]"), { scenario: "A [N=2]", n: 5, trial: null }, "the last suffix is the expansion");
  for (const s of ["X", "X [N=0]", "X [N=2]#1", "X[N=2]", "X [N=2] #0", "X [N=x]", " [N=2]", null]) assert.equal(parseExpandedCase(s), null, String(s));
});

test("declaresName: a literal in double or single quotes", () => {
  assert.equal(declaresName(SRC, SCENARIO), true);
  assert.equal(declaresName(SRC, 'canary: two editors join as "Shared"'), true, "single quotes around a name with double quotes (the canary's form)");
  assert.equal(declaresName(SRC, "it's quoted"), true, "an escaped single quote");
  assert.equal(declaresName(SRC, "C9 a race"), false, "a prefix is not a declaration");
});

test("targetSelection: a verbatim name is literal; an expanded one selects its N with one trial; the rest is refused", () => {
  assert.deepEqual(targetSelection(ctl(SCENARIO), SRC), { case: SCENARIO, scenario: SCENARIO, n: null, trial: null, expanded: false, args: [] });
  assert.deepEqual(targetSelection(ctl(`${SCENARIO} [N=2]`), SRC), { case: `${SCENARIO} [N=2]`, scenario: SCENARIO, n: 2, trial: null, expanded: true, args: ["--n", "2", "--trials", "1"] }, "NEGATIVE CONTROL: the verbatim lookup alone refuses this name");
  assert.deepEqual(targetSelection(ctl(`${SCENARIO} [N=5] #1`), SRC), { case: `${SCENARIO} [N=5]`, scenario: SCENARIO, n: 5, trial: 1, expanded: true, args: ["--n", "5", "--trials", "1"] }, "' #1' is the one trial's case, which carries no suffix");
  assert.equal(targetSelection(ctl('canary: two editors join as "Shared" [N=2]'), SRC).case, 'canary: two editors join as "Shared" [N=2]', "a single-quoted scenario expands too");
  assert.deepEqual(targetSelection(ctl("C9 canary [N=2]"), SRC).args, [], "a name declared verbatim is literal even when it looks expanded");
  assert.throws(() => targetSelection(ctl(`${SCENARIO} [N=2] #2`), SRC), /names trial #2, but a control's runs are one trial \(--trials 1\), whose case is named "C9 a race: every \\"Shared\\" peer converges \[N=2\]"/);
  assert.throws(() => targetSelection(ctl("Nope [N=2]"), SRC), /declares no case named "Nope \[N=2\]" \(nor a scenario named "Nope" that expands to it\)/);
  assert.throws(() => targetSelection(ctl("Nope"), SRC), (e) => /declares no case named "Nope"$/.test(e.message));
});

test("the chain: the selection's arguments make scenario() run exactly the case its --grep and findTarget look for", () => {
  const target = { kind: "local", runId: "selftest-ctl-exp", capabilities: new Set(["local"]) };
  const runAs = (args) => {
    const v = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
    if (v("--n") === undefined) delete process.env.E2E_N;
    else process.env.E2E_N = v("--n");
    if (v("--trials") === undefined) delete process.env[TRIALS_ENV];
    else process.env[TRIALS_ENV] = v("--trials");
    return expand(SCENARIO, { n: [2, 5, 10, 20], trials: "plan" }, target).filter((c) => !c.skip).map((c) => c.name);
  };
  for (const name of [`${SCENARIO} [N=2]`, `${SCENARIO} [N=2] #1`, `${SCENARIO} [N=5]`]) {
    const c = withSel(ctl(name));
    const args = redRunArgs(c);
    const ran = runAs(args);
    assert.deepEqual(ran, [c.selection.case], `${name}: one case runs, the one the control names`);
    const re = new RegExp(args[args.indexOf("--grep") + 1]);
    assert.deepEqual(ran.filter((x) => re.test(x)), [c.selection.case], "the --grep selects it");
    assert.equal(findTarget([{ file: c.target.spec, name: ran[0], status: "fail" }], c)?.name, ran[0], "and the verdict finds its record");
  }
  // Why --trials 1 is part of the selection: under the plan's trials no case carries the bare name.
  const planNames = runAs(["--n", "2"]);
  assert.equal(planNames.length, 10);
  assert.deepEqual(planNames.filter((x) => new RegExp(grepFor([`${SCENARIO} [N=2]`])).test(x)), [], "NEGATIVE CONTROL: without --trials 1 the grep selects nothing (10 cases named … #1–#10)");
  // Why findTarget reads the selection: ' #1' is not the name the run gives.
  const one = withSel(ctl(`${SCENARIO} [N=2] #1`));
  const recs = [{ file: one.target.spec, name: `${SCENARIO} [N=2]`, status: "pass" }];
  assert.equal(findTarget(recs, one)?.status, "pass");
  assert.equal(findTarget(recs, { ...one, selection: undefined }), null, "NEGATIVE CONTROL: by the control's own name the record is not found");
  assert.equal(findTarget([{ file: "e2e/specs/other.spec.mjs", name: `${SCENARIO} [N=2]` }], one), null, "another spec's case is not it");
});

test("greenGroups splits by the selection's arguments; a literal target's runs are exactly the old ones", () => {
  const lit = withSel(ctl(SCENARIO, { set: "controls-lit" }));
  const n2a = withSel(ctl(`${SCENARIO} [N=2]`, { set: "controls-n2a" }));
  const n2b = withSel(ctl('canary: two editors join as "Shared" [N=2] #1', { set: "controls-n2b" }));
  const n5 = withSel(ctl(`${SCENARIO} [N=5]`, { set: "controls-n5" }));
  const groups = greenGroups([lit, n2a, n2b, n5]);
  assert.deepEqual(groups.map((g) => [g.suite, g.stack, g.args, g.controls.map((c) => c.set)]), [
    ["concurrency", [], [], ["controls-lit"]],
    ["concurrency", [], ["--n", "2", "--trials", "1"], ["controls-n2a", "controls-n2b"]],
    ["concurrency", [], ["--n", "5", "--trials", "1"], ["controls-n5"]],
  ], "NEGATIVE CONTROL: grouped by (suite, stack) alone, a literal target would run under --n 2 --trials 1");
  const g2 = greenRunArgs(groups[1], { tree: "HEAD" });
  assert.deepEqual(g2.slice(0, 8), ["--tree", "HEAD", "--suite", "concurrency", "--n", "2", "--trials", "1"]);
  assert.equal(g2.at(-1), grepFor([`${SCENARIO} [N=2]`, 'canary: two editors join as "Shared" [N=2]']), "each case by the name its run gives it (no ' #1')");
  assert.deepEqual(redRunArgs(n5, { tree: "abc" }), ["--tree", "abc", "--suite", "concurrency", "--n", "5", "--trials", "1", "--spec", n5.target.spec, "--grep", grepFor([`${SCENARIO} [N=5]`]), "--patches", "controls-n5"]);
  // The arguments run.mjs built inline before this change, for a control with no selection or a literal one.
  const oldGreen = (g, tree) => ["--tree", tree, "--suite", g.suite, ...g.stack, ...[...new Set(g.controls.map((c) => c.target.spec))].flatMap((s) => ["--spec", s]), "--grep", grepFor(g.controls.map((c) => c.target.case))];
  const oldRed = (c, tree) => ["--tree", tree, "--suite", c.target.suite, ...c.stack, "--spec", c.target.spec, "--grep", grepFor([c.target.case]), "--patches", c.set];
  const bare = ctl(SCENARIO, { set: "controls-bare", stack: ["--rtdb-proxy"] });
  for (const c of [bare, lit]) {
    const [g] = greenGroups([c]);
    assert.deepEqual(greenRunArgs(g, { tree: "HEAD" }), oldGreen(g, "HEAD"));
    assert.deepEqual(redRunArgs(c, { tree: "HEAD" }), oldRed(c, "HEAD"));
  }
  assert.equal(targetCaseName(bare), SCENARIO);
});

test("every committed control resolves, and a literal one runs with exactly the arguments it ran with before", () => {
  const oldRed = (c) => ["--tree", "HEAD", "--suite", c.target.suite, ...c.stack, "--spec", c.target.spec, "--grep", grepFor([c.target.case]), "--patches", c.set];
  const sets = listControlSets();
  assert.ok(sets.length > 0);
  for (const set of sets) {
    const c = readControl(set);
    c.selection = assertTargetDeclared(c);
    if (!c.selection.expanded) assert.deepEqual(redRunArgs(c), oldRed(c), set);
    else assert.deepEqual(redRunArgs(c).slice(4 + c.stack.length, 8 + c.stack.length), c.selection.args, `${set}: an expanded target carries its selection`);
  }
});

test("assertTargetDeclared reads the spec file and returns the selection", () => {
  mkdirSync(OUT_DIR, { recursive: true }); // gitignored; a fresh checkout has none yet
  const dir = mkdtempSync(join(OUT_DIR, "selftest-ctl-exp-"));
  try {
    writeFileSync(join(dir, "x.spec.mjs"), SRC);
    const spec = relative(REPO_ROOT, join(dir, "x.spec.mjs"));
    assert.deepEqual(assertTargetDeclared({ ...ctl(`${SCENARIO} [N=2]`), target: { spec, case: `${SCENARIO} [N=2]`, suite: "concurrency" } }).args, ["--n", "2", "--trials", "1"]);
    assert.equal(assertTargetDeclared({ ...ctl(SCENARIO), target: { spec, case: SCENARIO, suite: "concurrency" } }).expanded, false);
    assert.throws(() => assertTargetDeclared({ ...ctl("x"), target: { spec: "e2e/specs/nope.spec.mjs", case: "x" } }), /target spec e2e\/specs\/nope\.spec\.mjs does not exist/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("run.mjs keeps the selection on each control and builds both runs from it (structural pin)", () => {
  const src = readFileSync(join(REPO_ROOT, "e2e", "run.mjs"), "utf8");
  const start = src.indexOf("async function cmdControls(");
  const fn = src.slice(start, src.indexOf("\n}\n", start));
  assert.match(fn, /for \(const c of controls\) c\.selection = assertTargetDeclared\(c\);/);
  assert.match(fn, /const greenArgs = greenRunArgs\(g, \{ tree: values\.tree \}\);/);
  assert.match(fn, /const args = redRunArgs\(c, \{ tree: values\.tree \}\);/, "NEGATIVE CONTROL: the old inline arguments carry no --n/--trials and grep the control's own name");
  assert.match(fn, /findTarget\(casesOf\(red\.report\), c\)/);
  assert.match(fn, /findTarget\(greenCases, c\)/);
  assert.match(fn, /selection: c\.selection,/, "the ledger records what ran");
  assert.doesNotMatch(fn, /grepFor\(\[c\.target\.case\]\)|c\.target\.case\)\)\]/, "no run built from the control's own name");
});
