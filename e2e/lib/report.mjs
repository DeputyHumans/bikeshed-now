// SPDX-License-Identifier: Apache-2.0
// Run reports: merge one invocation's results into results.json and summary.md, compare two, classify failures (SPEC §12).

/**
 *   node e2e/run.mjs report <ref>                 merge, write results.json + summary.md, print the summary
 *   node e2e/run.mjs report <runId> --merge       every invocation of the run in one table (merged.json + merged.md)
 *   node e2e/run.mjs compare <a> <b>              diff by stable id; exit 1 on a regression or a lost pass
 *   node e2e/run.mjs classify <ref> <id> <H|E|P|I|U> <note…>
 *   node e2e/run.mjs classify <runId> --merge <id> <H|E|P|I|U> <note…>
 *
 * <ref> names ONE invocation's results (see invocation.mjs):
 *   <runId>                 the run's only invocation (refused, with the list,
 *                           when there are several)
 *   <runId>/<invId>         that invocation
 *   a directory             an invocation directory, a run directory with
 *                           one invocation, or a directory holding
 *                           results-*.jsonl itself (older runs)
 * A classification is kept in <dir>/classifications.json and merged into
 * results.json, keyed by the case's stable id (an exact id, or a substring
 * matching exactly one).
 *
 * Classes (the plan's triage table): H harness bug, E environment, P confirmed
 * product defect, I matches SPEC/ADR but arguably harmful, U not reproduced.
 *
 * compare: a case that PASSED in <a> and in <b> FAILED is a regression; one
 * that passed and in <b> is gone, skipped, INCONCLUSIVE or a known defect
 * that failed is LOST. Both make compare exit 1 — a baseline compared with a
 * run whose tier never ran must not read "0 PASS → FAIL". The one excuse is a
 * case <b>'s own recorded selection left out (the files it planned per tier,
 * --grep, --n): that is "filtered", and listed.
 *
 * --merge (mergeInvocations): a run with many invocations — one agent per
 * area, all attached to one shared stack — read as ONE table. For each case
 * id, the latest outcome that actually RAN (a skip is "not run", and never
 * hides an earlier outcome) with the invocation that produced it; the
 * outcome history across invocations; and FLAKY when the outcomes that ran
 * differ (pass in one invocation, fail in another; a failing known defect in
 * one and an unexpected pass in another). "Latest" is by the RECORD's own
 * time (`at`, written when the case finished), not by when its invocation
 * started: parallel invocations overlap, and one that started first can run
 * a case last. Invocation order (ids start with the start second, then the
 * pid as text) only breaks ties, and orders records with no `at` (they count
 * as older than any timed record). Written to <runDir>/merged.json and
 * merged.md. A classification made with `classify --merge` is kept in
 * <runDir>/classifications.json with the outcome it was made against
 * (invocation, status, the record's `at`); it wins over an invocation's own
 * only while it still matches the case's latest outcome. Once a newer
 * outcome replaces that one, it is STALE: shown as `staleClassification`
 * (and "STALE:" in merged.md), never as `classification`, and a failing case
 * is back in `unclassified` — the merged view is live while agents keep
 * adding invocations, and an old label must not hide a new failure. compare
 * is unchanged: it compares two invocations.
 *
 * Tier locks: an invocation records per tier the lock it took (invocation.json
 * `locks`, from locks.mjs tierLockMode). summary.md says it on a line of its
 * own (tierLocksLine), and merged.md in each invocation's row, so a
 * concurrency MEASUREMENT run reads EXCLUSIVE and an AUTHORING run SHARED.
 *
 * NOT REPRODUCED (status "not-reproduced", the plan's class U; reporter.mjs):
 * a known defect's trial that never reached the defect's window. Never a
 * pass: compare counts pass → not-reproduced as LOST. Never exit 3. Listed
 * in summary.md under "Not reproduced", and counted per scenario and N with
 * the TODOs by defectRates(): "<scenario> [N=k]: S4 seen in s of K trials",
 * K being the trials that judged the defect (seen, not reproduced, passed
 * unexpectedly), INCONCLUSIVE and FAIL trials named apart as not counted.
 * In the merged view a not-reproduced trial beside one that saw the defect
 * is that race's rate, not FLAKY, and the rates count every invocation's
 * trials.
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { INVOCATIONS_DIR, INVOCATION_ID_RE, readInvocationMeta } from "./invocation.mjs";
import { OUT_DIR, RUN_ID_RE, assertPath } from "./paths.mjs";
import { NOT_REPRODUCED } from "./reporter.mjs";

export const CLASSES = Object.freeze({
  H: "harness bug",
  E: "environment",
  P: "product defect",
  I: "intended but arguably harmful",
  U: "not reproduced to the bar",
});

const RESULTS_RE = /^results(-[\w.-]+)?\.jsonl$/;

function isDir(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function holdsResults(dir) {
  return existsSync(join(dir, "invocation.json")) || readdirSync(dir).some((f) => RESULTS_RE.test(f) || f === "results.json");
}

/** The invocations of a run directory, oldest first. */
export function listInvocations(runDir) {
  const parent = join(runDir, INVOCATIONS_DIR);
  if (!isDir(parent)) return [];
  return readdirSync(parent).filter((n) => INVOCATION_ID_RE.test(n) && isDir(join(parent, n))).sort();
}

/** Resolve a reference to the directory holding ONE invocation's results. */
export function runDirOf(ref) {
  if (!ref) throw new Error("a run id, <runId>/<invId> or a directory is required");
  let dir;
  const m = /^([a-z0-9][a-z0-9-]{3,39})\/(?:invocations\/)?([^/]+)$/.exec(ref);
  if (RUN_ID_RE.test(ref) && !ref.includes("/")) dir = join(OUT_DIR, ref);
  else if (m && INVOCATION_ID_RE.test(m[2]) && !existsSync(resolve(ref))) dir = join(OUT_DIR, m[1], INVOCATIONS_DIR, m[2]);
  else dir = isAbsolute(ref) ? ref : resolve(ref);
  assertPath(dir, "run dir");
  if (!isDir(dir)) throw new Error(`no run directory ${dir}`);
  if (holdsResults(dir)) return dir;
  const invs = listInvocations(dir);
  if (invs.length === 1) return join(dir, INVOCATIONS_DIR, invs[0]);
  if (invs.length === 0) throw new Error(`${dir} holds no results and no invocations`);
  throw new Error(`${dir} has ${invs.length} invocations; name one as <runId>/<invId>, or merge them all with --merge:\n  ${invs.join("\n  ")}`);
}

/** The run directory (the one holding invocations/) a reference names: <runId>, a run dir, or an invocation in it. */
export function runRootOf(ref) {
  if (!ref) throw new Error("a run id or a run directory is required");
  let dir;
  const m = /^([a-z0-9][a-z0-9-]{3,39})\/(?:invocations\/)?([^/]+)$/.exec(ref);
  if (RUN_ID_RE.test(ref) && !ref.includes("/")) dir = join(OUT_DIR, ref);
  else if (m && INVOCATION_ID_RE.test(m[2]) && !existsSync(resolve(ref))) dir = join(OUT_DIR, m[1]);
  else dir = isAbsolute(ref) ? ref : resolve(ref);
  if (basename(dirname(dir)) === INVOCATIONS_DIR && INVOCATION_ID_RE.test(basename(dir))) dir = dirname(dirname(dir));
  assertPath(dir, "run dir");
  if (!isDir(dir)) throw new Error(`no run directory ${dir}`);
  if (listInvocations(dir).length === 0) throw new Error(`${dir} has no invocations to merge`);
  return dir;
}

/** Every record of one invocation, from its results-*.jsonl. Later lines win per id. */
export function readResults(dir) {
  const files = readdirSync(dir).filter((f) => RESULTS_RE.test(f)).sort();
  const byId = new Map();
  const malformed = [];
  for (const f of files) {
    for (const [i, line] of readFileSync(join(dir, f), "utf8").split("\n").entries()) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line);
        if (rec && rec.id) byId.set(rec.id, rec);
      } catch {
        malformed.push(`${f}:${i + 1}`);
      }
    }
  }
  return { records: [...byId.values()], files, malformed };
}

export function readClassifications(dir) {
  const f = join(dir, "classifications.json");
  return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : {};
}

export const STATUSES = Object.freeze(["pass", "fail", "inconclusive", "todo", "skip"]);

/** A trial's suffix in a case name (test.mjs expand: "… [N=2] #3"). */
const TRIAL_SUFFIX_RE = / #\d+$/;
/** The defect a todo record names: test.mjs marks it `known defect <name>`. */
const KNOWN_DEFECT_RE = /^known defect (.+)$/;

/** The defect a record is about: a not-reproduced record's `defect`, a todo's `known defect <name>`, else null. */
function defectOf(r) {
  if (typeof r?.defect === "string" && r.defect) return r.defect;
  const m = typeof r?.todo === "string" ? KNOWN_DEFECT_RE.exec(r.todo) : null;
  return m ? m[1] : null;
}

/**
 * One rate as a sentence: `<defect> seen in s of K trial(s)`, then what else
 * K holds (`(4 not reproduced, 1 passed unexpectedly)`) and the trials that
 * judged nothing (`; not counted: 1 inconclusive, 1 fail`).
 */
function rateText(g) {
  const of = `${g.defect ?? "the known defect"} seen in ${g.seen} of ${g.judged} trial${g.judged === 1 ? "" : "s"}`;
  const inK = [g.notReproduced ? `${g.notReproduced} not reproduced` : null, g.passedUnexpectedly ? `${g.passedUnexpectedly} passed unexpectedly` : null].filter(Boolean);
  const out = [g.inconclusive ? `${g.inconclusive} inconclusive` : null, g.failed ? `${g.failed} fail` : null, g.passed ? `${g.passed} pass` : null].filter(Boolean);
  return `${of}${inK.length ? ` (${inK.join(", ")})` : ""}${out.length ? `; not counted: ${out.join(", ")}` : ""}`;
}

/**
 * A known defect's rate per scenario and N, from the records' outcomes: the
 * trials of one scenario at one N are the top-level records whose id is the
 * same once the trial's ` #k` is cut (`<file>::<scenario> [N=2]`). K
 * (`judged`) is the trials that judged the defect: `seen` (a TODO that
 * failed as expected), `notReproduced`, `passedUnexpectedly`. INCONCLUSIVE,
 * FAIL and plain PASS trials judged nothing and are counted apart; skips are
 * left out. A scenario is listed when any trial is NOT REPRODUCED, or when
 * at least two ran and one of them judged the defect; nothing else is (a
 * one-trial TODO is already in the TODO list). Sorted by scenario.
 * @param {object[]} records reporter records
 * @returns {{scenario: string, file: string|null, name: string, n: number|null, defect: string|null, judged: number, seen: number, notReproduced: number, passedUnexpectedly: number, inconclusive: number, failed: number, passed: number, skipped: number, trials: number, ids: string[], text: string}[]}
 */
export function defectRates(records) {
  const groups = new Map();
  for (const r of Array.isArray(records) ? records : []) {
    if (!r || typeof r.id !== "string") continue;
    if (Array.isArray(r.path) && r.path.length > 1) continue; // a subtest is no trial
    const scenario = r.id.replace(TRIAL_SUFFIX_RE, "");
    let g = groups.get(scenario);
    if (!g) {
      g = { scenario, file: r.file ?? null, name: String(r.name ?? scenario.split("::").pop()).replace(TRIAL_SUFFIX_RE, ""), n: r.n ?? null, defect: null, judged: 0, seen: 0, notReproduced: 0, passedUnexpectedly: 0, inconclusive: 0, failed: 0, passed: 0, skipped: 0, trials: 0, ids: [] };
      groups.set(scenario, g);
    }
    g.defect ??= defectOf(r);
    if (r.status === "skip") {
      g.skipped += 1;
      continue;
    }
    g.trials += 1;
    g.ids.push(r.id);
    if (r.status === NOT_REPRODUCED) g.notReproduced += 1;
    else if (r.status === "todo" && r.outcome === "passed-unexpectedly") g.passedUnexpectedly += 1;
    else if (r.status === "todo") g.seen += 1;
    else if (r.status === "inconclusive") g.inconclusive += 1;
    else if (r.status === "fail") g.failed += 1;
    else if (r.status === "pass") g.passed += 1;
  }
  const out = [];
  for (const g of groups.values()) {
    g.judged = g.seen + g.notReproduced + g.passedUnexpectedly;
    if (!(g.notReproduced > 0 || (g.trials >= 2 && g.judged > 0))) continue;
    g.ids.sort();
    out.push({ ...g, text: rateText(g) });
  }
  return out.sort((a, b) => a.scenario.localeCompare(b.scenario));
}

/** One defectRates() entry as summary.md and run.mjs print it: `<scenario>: <defect> seen in s of K trials …`. */
export function rateLine(rate) {
  return `${rate.scenario}: ${rate.text ?? rateText(rate)}`;
}

/** Counts and lists for a merged run. */
export function summarize(records, classifications = {}) {
  const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  for (const r of records) counts[r.status] = (counts[r.status] ?? 0) + 1;
  const failures = records.filter((r) => r.status === "fail");
  return {
    total: records.length,
    counts,
    unexpectedPasses: records.filter((r) => r.status === "todo" && r.outcome === "passed-unexpectedly").map((r) => r.id),
    unclassified: failures.filter((r) => !classifications[r.id]).map((r) => r.id),
    inconclusive: records.filter((r) => r.status === "inconclusive").map((r) => ({ id: r.id, reason: r.inconclusive })),
    skips: records.filter((r) => r.status === "skip").map((r) => ({ id: r.id, reason: r.skipReason })),
    notReproduced: records.filter((r) => r.status === NOT_REPRODUCED).map((r) => ({ id: r.id, defect: defectOf(r), reason: r.notReproduced ?? null })),
    rates: defectRates(records),
  };
}

/** Merge one invocation: write results.json and summary.md; return {results, summary, dir}. */
export function mergeRun(ref) {
  const dir = runDirOf(ref);
  const { records, files, malformed } = readResults(dir);
  const classifications = readClassifications(dir);
  const merged = records
    .map((r) => ({ ...r, classification: classifications[r.id] ?? null }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const summary = summarize(merged, classifications);
  const invocation = readInvocationMeta(dir);
  const runId = invocation?.runId ?? merged.find((r) => r.runId)?.runId ?? dir.split("/").pop();
  const results = { runId, invocation, dir, mergedAt: new Date().toISOString(), sources: files, malformed, summary, cases: merged };
  writeFileSync(join(dir, "results.json"), JSON.stringify(results, null, 2) + "\n");
  writeFileSync(join(dir, "summary.md"), summaryMarkdown(results));
  return { results, summary, dir };
}

const cell = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");

/**
 * The tier locks an invocation took (invocation.json `locks`: {tier: {mode,
 * authoring, reason, acquiredAt, waitedMs}}) as one line, `Tier locks:
 * functional SHARED · concurrency EXCLUSIVE (measurement run: …)`, or null
 * when it recorded none (an older run). The concurrency tier's reason is
 * given unless `brief`; a wait of a second or more is named, and a lock the
 * run planned but never got (no `acquiredAt`: it was interrupted, timed out
 * waiting, or an earlier tier stopped it) says "never taken".
 * @param {object|null|undefined} locks
 * @param {{brief?: boolean}} [o]
 * @returns {string|null}
 */
export function tierLocksLine(locks, { brief = false } = {}) {
  if (!locks || typeof locks !== "object") return null;
  const parts = Object.entries(locks)
    .filter(([, l]) => l && typeof l.mode === "string")
    .map(([tier, l]) => {
      const why = !brief && tier === "concurrency" && l.reason ? ` (${l.reason})` : "";
      const waited = !brief && Number.isFinite(l.waitedMs) && l.waitedMs >= 1000 ? `, after waiting ${Math.round(l.waitedMs / 1000)} s` : "";
      const taken = l.acquiredAt ? "" : ", never taken";
      return `${tier} ${l.mode.toUpperCase()}${why}${waited}${taken}`;
    });
  return parts.length ? `Tier locks: ${parts.join(" · ")}` : null;
}

export function countsLine(c, total) {
  // "not reproduced" only when there is one: every older line reads as it did.
  const nr = c[NOT_REPRODUCED] ? `${c[NOT_REPRODUCED]} not reproduced (known defects' windows not reached), ` : "";
  return `${total} cases: ${c.pass} pass, ${c.fail} fail, ${c.inconclusive ?? 0} inconclusive, ${c.todo} todo (known defects), ${nr}${c.skip} skip.`;
}

/** summary.md's rate section, or [] when there is none. */
function ratesSection(rates, heading) {
  if (!Array.isArray(rates) || rates.length === 0) return [];
  return [heading, "", ...rates.map((r) => `- ${cell(rateLine(r))}`), ""];
}

export function summaryMarkdown({ runId, invocation, summary, cases }) {
  const c = summary.counts;
  const lines = [`# e2e run ${runId}${invocation?.id ? ` · invocation ${invocation.id}` : ""}`, ""];
  if (invocation) {
    const sel = [
      invocation.suite ? `suite ${invocation.suite}` : null,
      invocation.spec?.length ? `--spec ${invocation.spec.join(" ")}` : null,
      invocation.grep ? `--grep ${invocation.grep}` : null,
      invocation.n ? `--n ${invocation.n.join(",")}` : null,
      invocation.trials ? `--trials ${invocation.trials}` : null,
      invocation.patches?.length ? `--patches ${invocation.patches.join(" ")}` : null,
    ].filter(Boolean);
    if (sel.length) lines.push(`Selection: ${sel.join(" · ")}`, "");
    const locks = tierLocksLine(invocation.locks);
    if (locks) lines.push(locks, "");
  }
  lines.push(countsLine(c, summary.total), "");
  const fails = cases.filter((r) => r.status === "fail");
  if (fails.length) {
    lines.push("## Failures", "", "| case | class | error | evidence |", "|---|---|---|---|");
    for (const r of fails) {
      lines.push(`| ${cell(r.id)} | ${cell(r.classification ? `${r.classification.class}: ${r.classification.note}` : "unclassified")} | ${cell(r.error?.message?.split("\n")[0]?.slice(0, 160))} | ${cell(r.evidenceDir ?? "")} |`);
    }
    lines.push("");
  }
  const inc = cases.filter((r) => r.status === "inconclusive");
  if (inc.length) {
    lines.push("## Inconclusive", "", "| case | reason | evidence |", "|---|---|---|");
    for (const r of inc) lines.push(`| ${cell(r.id)} | ${cell(r.inconclusive)} | ${cell(r.evidenceDir ?? "")} |`);
    lines.push("");
  }
  const nrs = cases.filter((r) => r.status === NOT_REPRODUCED);
  if (nrs.length) {
    lines.push("## Not reproduced (a known defect's window not reached: listed, never a pass)", "", "| case | defect | reason | evidence |", "|---|---|---|---|");
    for (const r of nrs) lines.push(`| ${cell(r.id)} | ${cell(defectOf(r) ?? "")} | ${cell(r.notReproduced)} | ${cell(r.evidenceDir ?? "")} |`);
    lines.push("");
  }
  const todos = cases.filter((r) => r.status === "todo");
  if (todos.length) {
    lines.push("## Known defects (todo)", "", "| case | defect | outcome |", "|---|---|---|");
    for (const r of todos) lines.push(`| ${cell(r.id)} | ${cell(r.todo)} | ${r.outcome === "passed-unexpectedly" ? "**passed unexpectedly**" : "failed as expected"} |`);
    lines.push("");
  }
  lines.push(...ratesSection(summary.rates ?? defectRates(cases), "## Known defects per scenario (seen in s of K trials)"));
  const skips = cases.filter((r) => r.status === "skip");
  if (skips.length) {
    lines.push("## Skipped", "", "| case | reason |", "|---|---|");
    for (const r of skips) lines.push(`| ${cell(r.id)} | ${cell(r.skipReason)} |`);
    lines.push("");
  }
  return lines.join("\n") + "\n";
}

/** Load one invocation's merged results (merging first if results.json is missing or stale). */
export function loadRun(ref) {
  const dir = runDirOf(ref);
  const json = join(dir, "results.json");
  const sources = readdirSync(dir).filter((f) => RESULTS_RE.test(f));
  const stale = !existsSync(json) || sources.some((f) => statSync(join(dir, f)).mtimeMs > statSync(json).mtimeMs);
  return stale ? mergeRun(dir).results : JSON.parse(readFileSync(json, "utf8"));
}

/**
 * Whether an invocation's own recorded selection left a case out: its tier or
 * file was not planned, --grep matches no part of its name path, or --n does
 * not name its N. Without a recorded selection nothing is excused.
 */
export function excludedBy(invocation, rec) {
  if (!invocation) return null;
  if (Array.isArray(invocation.plan)) {
    const tiers = invocation.plan.map((p) => p.tier);
    if (rec.suite && !tiers.includes(rec.suite)) return `tier ${rec.suite} not in this invocation's plan (${tiers.join(", ") || "none"})`;
    const files = invocation.plan.filter((p) => !rec.suite || p.tier === rec.suite).flatMap((p) => p.files ?? []);
    if (rec.file && !files.includes(rec.file)) return `${rec.file} not among this invocation's planned files`;
  }
  if (invocation.grep) {
    let re = null;
    try {
      re = new RegExp(invocation.grep);
    } catch {}
    if (re && !(rec.path ?? [rec.name]).some((p) => re.test(p))) return `--grep ${invocation.grep} does not match`;
  }
  if (Array.isArray(invocation.n) && invocation.n.length && rec.n != null && !invocation.n.includes(rec.n)) return `--n ${invocation.n.join(",")} leaves out N=${rec.n}`;
  return null;
}

const label = (r) => (r.status === "todo" ? `todo(${r.outcome === "passed-unexpectedly" ? "passed" : "failed"})` : r.status);
const passed = (s) => s === "pass" || s === "todo(passed)";
const failedLabel = (s) => s === "fail" || s === "todo(failed)";
/** For FLAKY only: a not-reproduced trial is the same verdict family as the defect seen (a natural race's rate), never a pass. */
const flakyLabel = (s) => (s === NOT_REPRODUCED ? "todo(failed)" : s);

/**
 * Compare two invocations by stable id. A known defect that was fixed shows as
 * todo(failed) → todo(passed) or pass; a regression as pass → fail; a pass
 * that is gone, skipped, inconclusive, not reproduced or a failing known
 * defect as LOST.
 */
export function compareRuns(a, b) {
  const runA = loadRun(a);
  const runB = loadRun(b);
  const A = new Map(runA.cases.map((r) => [r.id, r]));
  const B = new Map(runB.cases.map((r) => [r.id, r]));
  const changes = [];
  for (const id of [...new Set([...A.keys(), ...B.keys()])].sort()) {
    const x = A.get(id);
    const y = B.get(id);
    if (!x) {
      changes.push({ id, kind: "added", to: label(y) });
      continue;
    }
    const from = label(x);
    const why = excludedBy(runB.invocation, x);
    if (!y) {
      if (why) changes.push({ id, kind: "filtered", from, reason: why });
      else changes.push({ id, kind: passed(from) ? "lost" : "removed", from, to: "absent" });
      continue;
    }
    const to = label(y);
    if (from === to) continue;
    let kind = "changed";
    if (passed(from) && to === "fail") kind = "regression";
    else if (passed(from) && !passed(to)) kind = why && to === "skip" ? "filtered" : "lost";
    else if (failedLabel(from) && passed(to)) kind = "fixed";
    changes.push({ id, kind, from, to, ...(kind === "filtered" ? { reason: why } : {}) });
  }
  return {
    changes,
    regressions: changes.filter((c) => c.kind === "regression"),
    lost: changes.filter((c) => c.kind === "lost"),
    fixed: changes.filter((c) => c.kind === "fixed"),
    filtered: changes.filter((c) => c.kind === "filtered"),
  };
}

export function compareMarkdown(a, b, r) {
  const lines = [
    `# compare ${a} → ${b}`,
    "",
    `${r.changes.length} change(s): ${r.fixed.length} fixed, ${r.regressions.length} PASS → FAIL, ${r.lost.length} PASS lost (gone, skipped, inconclusive, not reproduced or a failing known defect), ${r.filtered.length} left out by ${b}'s own selection.`,
    "",
  ];
  if (r.changes.length) {
    lines.push("| case | change | from | to |", "|---|---|---|---|");
    for (const c of r.changes) lines.push(`| ${cell(c.id)} | ${c.kind}${c.reason ? ` (${cell(c.reason)})` : ""} | ${c.from ?? ""} | ${c.to ?? ""} |`);
  }
  return lines.join("\n") + "\n";
}

// --- merged view across invocations ----------------------------------------

export const MERGED_JSON = "merged.json";
export const MERGED_MD = "merged.md";

/** A record's finish time in ms, or -Infinity when it has none (older than any timed record). */
function recordTime(rec) {
  const t = Date.parse(rec?.at ?? "");
  return Number.isFinite(t) ? t : -Infinity;
}

/** Chronological: the record's own time, then invocation order. */
function byOutcomeTime(a, b) {
  const ta = recordTime(a.rec);
  const tb = recordTime(b.rec);
  if (ta !== tb) return ta < tb ? -1 : 1;
  return a.order - b.order;
}

/**
 * Whether a run-level classification was made against this outcome: the same
 * invocation (and, when it recorded one, the same record time), or — for one
 * that names no invocation — the same status and record time.
 */
export function classificationFits(cls, latest) {
  if (!cls || !latest) return false;
  const at = latest.rec?.at ?? null;
  if (cls.invocation != null) return cls.invocation === latest.invocation && (cls.recordAt == null || cls.recordAt === at);
  return cls.recordAt != null && cls.recordAt === at && cls.status === latest.rec?.status;
}

/**
 * Merge every invocation of a run into one view (see the header): writes
 * <runDir>/merged.json and merged.md, returns {results, summary, dir}.
 * Each case is the latest record that RAN (else the latest skip) plus
 * {invocation, label, flaky, history:[{invocation, status, label, at}],
 * classification, staleClassification?}. summary.staleClassifications lists
 * {id, madeAgainst, latest} for each run-level classification a newer outcome
 * has overtaken.
 */
export function mergeInvocations(ref) {
  const runDir = runRootOf(ref);
  const invIds = listInvocations(runDir);
  const byId = new Map();
  const invocations = [];
  const everyRecord = []; // every invocation's trials: what the merged rates count
  invIds.forEach((invId, order) => {
    const dir = join(runDir, INVOCATIONS_DIR, invId);
    const meta = readInvocationMeta(dir);
    const { records, malformed } = readResults(dir);
    const cls = readClassifications(dir);
    invocations.push({ id: invId, suite: meta?.suite ?? null, spec: meta?.spec ?? [], grep: meta?.grep ?? null, n: meta?.n ?? null, trials: meta?.trials ?? null, locks: meta?.locks ?? null, startedAt: meta?.startedAt ?? null, endedAt: meta?.endedAt ?? null, exit: meta?.exit ?? null, cases: records.length, malformed });
    everyRecord.push(...records);
    for (const rec of records) {
      if (!byId.has(rec.id)) byId.set(rec.id, []);
      byId.get(rec.id).push({ invocation: invId, order, rec, classification: cls[rec.id] ?? null });
    }
  });
  const runCls = readClassifications(runDir);
  const effective = {};
  const cases = [];
  const stale = [];
  for (const [id, list] of byId) {
    list.sort(byOutcomeTime);
    const ran = list.filter((e) => e.rec.status !== "skip");
    const latest = (ran.length ? ran : list).at(-1);
    const labels = [...new Set(ran.map((e) => flakyLabel(label(e.rec))))];
    const run = runCls[id] ?? null;
    const fits = run ? classificationFits(run, latest) : false;
    const classification = (fits ? run : null) ?? latest.classification ?? null;
    if (classification) effective[id] = classification;
    const staleClassification = run && !fits ? { ...run, stale: true } : undefined;
    if (staleClassification) stale.push({ id, madeAgainst: run.invocation ?? null, latest: latest.invocation });
    cases.push({
      ...latest.rec,
      invocation: latest.invocation,
      label: label(latest.rec),
      flaky: labels.length > 1,
      history: list.map((e) => ({ invocation: e.invocation, status: e.rec.status, label: label(e.rec), at: e.rec.at ?? null })),
      classification,
      ...(staleClassification ? { staleClassification } : {}),
    });
  }
  cases.sort((a, b) => a.id.localeCompare(b.id));
  stale.sort((a, b) => a.id.localeCompare(b.id));
  const summary = { ...summarize(cases, effective), rates: defectRates(everyRecord), flaky: cases.filter((c) => c.flaky).map((c) => ({ id: c.id, labels: [...new Set(c.history.filter((h) => h.status !== "skip").map((h) => h.label))] })), staleClassifications: stale, invocations: invIds.length };
  const runId = basename(runDir);
  const results = { runId, merged: true, dir: runDir, mergedAt: new Date().toISOString(), invocations, summary, cases };
  writeFileSync(join(runDir, MERGED_JSON), JSON.stringify(results, null, 2) + "\n");
  writeFileSync(join(runDir, MERGED_MD), mergedMarkdown(results));
  return { results, summary, dir: runDir };
}

const shortInv = (id) => String(id ?? "").replace(/^(\d{8}T\d{6}Z)-p\d+-/, "$1-");

export function mergedMarkdown({ runId, invocations, summary, cases }) {
  const lines = [`# e2e run ${runId} · merged across ${invocations.length} invocation(s)`, ""];
  lines.push(countsLine(summary.counts, summary.total), "");
  lines.push(`${summary.flaky.length} FLAKY (outcomes differed between invocations).`, "");
  const staleCount = summary.staleClassifications?.length ?? 0;
  if (staleCount) lines.push(`${staleCount} STALE run-level classification(s): made against an outcome a newer one has replaced; classify again with --merge.`, "");
  lines.push("| case | outcome | invocation | flaky | class |", "|---|---|---|---|---|");
  for (const c of cases) {
    const ran = c.history.filter((h) => h.status !== "skip").map((h) => h.label);
    const flaky = c.flaky ? `**FLAKY**: ${cell(ran.join(" → "))}` : "";
    const outcome = c.status === "skip" ? `skip (${cell(c.skipReason ?? "")})` : c.label;
    const cls = [
      c.classification ? `${c.classification.class}: ${c.classification.note}` : null,
      c.staleClassification ? `STALE: ${c.staleClassification.class}: ${c.staleClassification.note} (made against ${shortInv(c.staleClassification.invocation) || "an earlier outcome"})` : null,
    ].filter(Boolean).join("; ");
    lines.push(`| ${cell(c.id)} | ${outcome} | ${cell(shortInv(c.invocation))} | ${flaky} | ${cell(cls)} |`);
  }
  const rates = ratesSection(summary.rates, `## Known defects per scenario (seen in s of K trials, every invocation's trials)`);
  if (rates.length) lines.push("", ...rates.slice(0, -1));
  lines.push("", "## Invocations", "", "| invocation | suite | selection | cases | exit |", "|---|---|---|---|---|");
  for (const i of invocations) {
    const sel = [i.spec?.length ? `--spec ${i.spec.join(" ")}` : null, i.grep ? `--grep ${i.grep}` : null, i.n ? `--n ${i.n.join(",")}` : null, i.trials ? `--trials ${i.trials}` : null, tierLocksLine(i.locks, { brief: true })].filter(Boolean).join(" · ");
    lines.push(`| ${cell(i.id)} | ${cell(i.suite ?? "")} | ${cell(sel)} | ${i.cases} | ${i.exit ?? ""} |`);
  }
  return lines.join("\n") + "\n";
}

/** Classify a case of the merged view (run level), then re-merge. */
export function classifyMerged(ref, idOrSubstring, cls, note) {
  if (!CLASSES[cls]) throw new Error(`class must be one of ${Object.keys(CLASSES).join(" ")} (${Object.entries(CLASSES).map(([k, v]) => `${k}=${v}`).join(", ")})`);
  if (!note || !String(note).trim()) throw new Error("a classification needs a note");
  const { results, dir } = mergeInvocations(ref);
  let hit = results.cases.find((r) => r.id === idOrSubstring);
  if (!hit) {
    const matches = results.cases.filter((r) => r.id.includes(idOrSubstring));
    if (matches.length !== 1) throw new Error(`${matches.length} cases match "${idOrSubstring}"${matches.length ? `: ${matches.slice(0, 5).map((m) => m.id).join("; ")}` : ""}`);
    hit = matches[0];
  }
  const all = readClassifications(dir);
  // What it was made against: it applies only while this is still the latest outcome.
  all[hit.id] = { class: cls, meaning: CLASSES[cls], note: String(note), at: new Date().toISOString(), status: hit.status, invocation: hit.invocation, recordAt: hit.at ?? null, flaky: hit.flaky };
  writeFileSync(join(dir, "classifications.json"), JSON.stringify(all, null, 2) + "\n");
  mergeInvocations(dir);
  return { id: hit.id, ...all[hit.id] };
}

/** Record a classification for one case of an invocation, then re-merge. */
export function classify(ref, idOrSubstring, cls, note) {
  if (!CLASSES[cls]) throw new Error(`class must be one of ${Object.keys(CLASSES).join(" ")} (${Object.entries(CLASSES).map(([k, v]) => `${k}=${v}`).join(", ")})`);
  if (!note || !String(note).trim()) throw new Error("a classification needs a note");
  const dir = runDirOf(ref);
  const { records } = readResults(dir);
  let hit = records.find((r) => r.id === idOrSubstring);
  if (!hit) {
    const matches = records.filter((r) => r.id.includes(idOrSubstring));
    if (matches.length !== 1) throw new Error(`${matches.length} cases match "${idOrSubstring}"${matches.length ? `: ${matches.slice(0, 5).map((m) => m.id).join("; ")}` : ""}`);
    hit = matches[0];
  }
  const all = readClassifications(dir);
  all[hit.id] = { class: cls, meaning: CLASSES[cls], note: String(note), at: new Date().toISOString(), status: hit.status };
  writeFileSync(join(dir, "classifications.json"), JSON.stringify(all, null, 2) + "\n");
  mergeRun(dir);
  return { id: hit.id, ...all[hit.id] };
}
