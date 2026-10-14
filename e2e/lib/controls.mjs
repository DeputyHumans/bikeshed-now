// SPDX-License-Identifier: Apache-2.0
// Negative controls: one patch set per oracle family, the case it must turn red, and the verdict on a red/green pair (SPEC §12).

/**
 * A control is a directory `e2e/patches/controls-<name>/` holding one or more
 * `*.patch` files and a `control.json`:
 *
 *   {
 *     "oracle":  "DECOR",                       the oracle family it proves
 *     "what":    "the editor leaves a bshd- class on a paragraph",
 *     "target":  { "spec": "e2e/specs/functional/smoke.spec.mjs",
 *                  "case": "<the scenario's exact name>",   or an expanded case,
 *                                               "<scenario> [N=<k>]" (see EXPANDED)
 *                  "suite": "functional" },     optional: smoke | functional |
 *                                               concurrency (default functional)
 *     "stack":   ["--email-off"],               optional: stack options both
 *                                               sides are built with (lib/options.mjs:
 *                                               --email-off, --app-env K=V, --rtdb-proxy,
 *                                               --gates, --patches amplify-<name>; an
 *                                               amplify set goes on before the control's)
 *     "expect":  { "message": "<a RegExp source the failure message must match>" }
 *   }
 *
 * A patch applies to the stack's TREE (git apply in the copy), which also
 * holds the harness's own staged files, e.g. .e2e/egress-guard.mjs: a control
 * may patch those to prove an oracle sees the harness's own guard missing.
 *
 * `run.mjs controls [<set>…]` runs, for each set, the target case on a stack
 * built from HEAD WITH the set applied (RED: the case must FAIL with that
 * message) and once, for every target, on a stack built WITHOUT any (GREEN:
 * the case must PASS). Both outputs go to a ledger under
 * e2e/.out/controls-<stamp>[-<rand4>]/ (makeControlsDir: one directory per
 * invocation, even for two started in the same second). A patched stack is built fresh for each set and
 * never reverted in place: the copy is built once, so a patch reverted after
 * the build would change nothing that runs.
 *
 * One set per family, so a red case names the patch that made it red.
 *
 * EXPANDED. A scenario with `n: [2, 5, 10, 20]` declares one name and runs
 * as "<name> [N=2]", "<name> [N=5]" … (and "… [N=2] #k" with k trials). A
 * control may name one of those cases, "<scenario> [N=<k>]" (a trailing
 * " #1" is accepted and means the same): when the spec does not declare
 * that name verbatim but declares "<scenario>", both of its runs pass
 * `--n <k> --trials 1`, so the case runs once, under that N, by the name
 * "<scenario> [N=<k>]", which the --grep selects and the verdict reads. A
 * name the spec declares verbatim is always taken as written. Trial #2 or
 * later is refused: with one trial no case carries it. targetSelection()
 * decides this; assertTargetDeclared() returns it, and run.mjs keeps it on
 * the control as `selection` for greenGroups, the run arguments and
 * findTarget. A literal string in double or single quotes counts as
 * declaring a name.
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { OUT_DIR, PATCHES_DIR, REPO_ROOT } from "./paths.mjs";
import { parseStackOptionArgs } from "./options.mjs";

export const CONTROL_SUITES = Object.freeze(["smoke", "functional", "concurrency"]);

/** `20261011-051259z` — the stamp a controls directory is named by (one-second resolution). */
export function controlsStamp(now = new Date()) {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "z").toLowerCase().replace(/t/, "-");
}

/**
 * Make this invocation's own output directory and return its path:
 * `controls-<stamp>`, or `controls-<stamp>-<rand4>` when another invocation
 * already holds that name. The directory is CREATED exclusively (mkdir of the
 * leaf, never recursive), so two invocations that start in the same second
 * can never share one and overwrite each other's ledger.json and logs.
 */
export function makeControlsDir(root = OUT_DIR, now = new Date()) {
  mkdirSync(root, { recursive: true });
  const stamp = controlsStamp(now);
  for (let i = 0; i < 50; i++) {
    const suffix = i === 0 ? "" : `-${Array.from(randomBytes(4), (b) => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join("")}`;
    const dir = join(root, `controls-${stamp}${suffix}`);
    try {
      mkdirSync(dir);
      return dir;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
  }
  throw new Error(`makeControlsDir: no free controls-${stamp}-* directory under ${root}`);
}

// The same escaping scenario() uses for a rerun's --grep (kept here so run.mjs
// does not load node:test to build a control's selection).
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const CONTROL_PREFIX = "controls-";

/** Every control set, sorted. */
export function listControlSets(root = PATCHES_DIR) {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((n) => n.startsWith(CONTROL_PREFIX) && statSync(join(root, n)).isDirectory())
    .sort();
}

/** Read and check one set's control.json. */
export function readControl(set, root = PATCHES_DIR) {
  if (!set.startsWith(CONTROL_PREFIX)) throw new Error(`${set} is not a control set (${CONTROL_PREFIX}*)`);
  const dir = join(root, set);
  const file = join(dir, "control.json");
  if (!existsSync(file)) throw new Error(`${set}: no control.json`);
  const c = JSON.parse(readFileSync(file, "utf8"));
  for (const k of ["oracle", "what"]) if (typeof c[k] !== "string" || !c[k].trim()) throw new Error(`${set}: control.json needs "${k}"`);
  if (typeof c.target?.spec !== "string" || typeof c.target?.case !== "string") throw new Error(`${set}: control.json needs target.spec and target.case`);
  if (typeof c.expect?.message !== "string" || !c.expect.message) throw new Error(`${set}: control.json needs expect.message`);
  new RegExp(c.expect.message);
  const suite = c.target.suite ?? "functional";
  if (!CONTROL_SUITES.includes(suite)) throw new Error(`${set}: target.suite must be one of ${CONTROL_SUITES.join(", ")}`);
  const stack = c.stack ?? [];
  if (!Array.isArray(stack) || !stack.every((a) => typeof a === "string")) throw new Error(`${set}: control.json "stack" is a list of stack option arguments`);
  parseStackOptionArgs(stack); // throws on anything but the stack options (and an amplify-* --patches)
  const patches = readdirSync(dir).filter((n) => n.endsWith(".patch")).sort();
  if (patches.length === 0) throw new Error(`${set}: no *.patch files`);
  return { set, dir, ...c, target: { ...c.target, suite }, stack, patches };
}

/**
 * Controls whose clean (GREEN) side can share one stack: same suite, same
 * stack options, same selection arguments (an expanded target's `--n <k>
 * --trials 1`; none for a literal one). Each group is {suite, stack, args,
 * controls}.
 */
export function greenGroups(controls) {
  const groups = new Map();
  for (const c of controls) {
    const args = c.selection?.args ?? [];
    const key = JSON.stringify([c.target.suite, c.stack, args]);
    if (!groups.has(key)) groups.set(key, { suite: c.target.suite, stack: c.stack, args, controls: [] });
    groups.get(key).controls.push(c);
  }
  return [...groups.values()];
}

/** The --grep that selects exactly these case names. */
export function grepFor(names) {
  return `^(?:${[...new Set(names)].map(escapeRe).join("|")})$`;
}

/** "<scenario> [N=<k>]" with an optional " #<t>": the case a scenario with `n` expands to. */
export const EXPANDED_CASE_RE = /^(.+) \[N=([1-9]\d*)\](?: #([1-9]\d*))?$/;

/** {scenario, n, trial (null without " #t")} of an expanded case name, or null. */
export function parseExpandedCase(name) {
  const m = typeof name === "string" ? EXPANDED_CASE_RE.exec(name) : null;
  return m ? { scenario: m[1], n: Number(m[2]), trial: m[3] === undefined ? null : Number(m[3]) } : null;
}

/** Whether `src` holds `name` as a string literal, in double or single quotes. */
export function declaresName(src, name) {
  if (src.includes(JSON.stringify(name))) return true;
  const single = `'${name.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n")}'`;
  return src.includes(single);
}

/**
 * What a control's runs select, from its spec's source `src`:
 *   {case, scenario, n, trial, expanded, args}
 * `case` is the name the runs produce and the verdict looks for; `args` go
 * to both runs. A name `src` declares verbatim is literal (n null, no args).
 * Otherwise an expanded name whose scenario `src` declares selects that N:
 * args `--n <k> --trials 1`, case "<scenario> [N=<k>]". Throws when the spec
 * declares neither, or when the name asks for a trial past #1.
 */
export function targetSelection(control, src) {
  const name = control.target.case;
  if (declaresName(src, name)) return { case: name, scenario: name, n: null, trial: null, expanded: false, args: [] };
  const x = parseExpandedCase(name);
  if (x && declaresName(src, x.scenario)) {
    const runName = `${x.scenario} [N=${x.n}]`;
    if (x.trial !== null && x.trial !== 1) throw new Error(`${control.set}: target case ${JSON.stringify(name)} names trial #${x.trial}, but a control's runs are one trial (--trials 1), whose case is named ${JSON.stringify(runName)}`);
    return { case: runName, scenario: x.scenario, n: x.n, trial: x.trial, expanded: true, args: ["--n", String(x.n), "--trials", "1"] };
  }
  throw new Error(`${control.set}: ${control.target.spec} declares no case named ${JSON.stringify(name)}${x ? ` (nor a scenario named ${JSON.stringify(x.scenario)} that expands to it)` : ""}`);
}

/**
 * Throw unless the target case is declared in its spec file: by that exact
 * name, or as the scenario an expanded name comes from. Returns the
 * selection (targetSelection), which run.mjs keeps on the control.
 */
export function assertTargetDeclared(control) {
  const file = join(REPO_ROOT, control.target.spec);
  if (!existsSync(file)) throw new Error(`${control.set}: target spec ${control.target.spec} does not exist`);
  return targetSelection(control, readFileSync(file, "utf8"));
}

/** The name the target case runs under: the selection's, else the control's own. */
export function targetCaseName(control) {
  return control.selection?.case ?? control.target.case;
}

/**
 * The `run` arguments of a GREEN group's clean stack: its suite, stack
 * options and selection arguments, every target's spec and a --grep for
 * exactly their cases.
 */
export function greenRunArgs(group, { tree = "HEAD" } = {}) {
  const specs = [...new Set(group.controls.map((c) => c.target.spec))];
  return ["--tree", tree, "--suite", group.suite, ...group.stack, ...(group.args ?? []), ...specs.flatMap((s) => ["--spec", s]), "--grep", grepFor(group.controls.map(targetCaseName))];
}

/** The `run` arguments of a control's RED stack: as its clean side, plus `--patches <set>`. */
export function redRunArgs(control, { tree = "HEAD" } = {}) {
  return ["--tree", tree, "--suite", control.target.suite, ...control.stack, ...(control.selection?.args ?? []), "--spec", control.target.spec, "--grep", grepFor([targetCaseName(control)]), "--patches", control.set];
}

/** The record of the target case among an invocation's cases (by the name its runs give it). */
export function findTarget(cases, control) {
  const name = targetCaseName(control);
  return cases.find((r) => r.file === control.target.spec && r.name === name) ?? null;
}

/**
 * The verdict on one control.
 *   red    the target's record on the PATCHED stack
 *   green  the target's record on the clean stack
 * ok only when green passed and red failed with the expected message.
 */
export function controlVerdict(control, { red, green }) {
  const problems = [];
  const re = new RegExp(control.expect.message);
  if (!green) problems.push("green: the target case did not run on the clean stack");
  else if (green.status !== "pass") problems.push(`green: the target case is ${green.status} on the clean stack, not pass${green.error?.message ? ` (${green.error.message.split("\n")[0].slice(0, 200)})` : ""}`);
  if (!red) problems.push("red: the target case did not run on the patched stack");
  else if (red.status !== "fail") problems.push(`red: the target case is ${red.status} with the patch applied — the oracle did not see the bug`);
  else if (!re.test(red.error?.message ?? "")) problems.push(`red: it failed, but not with /${control.expect.message}/: ${(red.error?.message ?? "").split("\n")[0].slice(0, 300)}`);
  return { ok: problems.length === 0, problems };
}
