// SPDX-License-Identifier: Apache-2.0
// Renders CI's job summary from what each step and test suite reported (SPEC §12).

/**
 * `.github/workflows/ci.yml` runs this last in a job, whether or not the job
 * has failed, and it appends Markdown to the job's summary. Nothing depends on
 * it: its step is continue-on-error, so a bug here costs a report, not a deploy.
 *
 * It imports only Node built-ins, because a run where `npm ci` failed is one
 * that most needs a report.
 *
 * NEVER REPORT A PASS FROM MISSING DATA. A suite's result is its step's outcome
 * read against its report, and a step that passed with no report, or having run
 * no tests, is a warning. `node --test` over a glob matching nothing exits 0, so
 * a renamed test directory is a green step that tested nothing.
 *
 * THE TEXT IS UNTRUSTED. On a public repository a fork's pull request controls
 * test names and error messages, and this page sits under the repository's
 * name. Everything from a report goes through `inline` or `fence`, so it cannot
 * add an image, a table cell or a link dressed as other text. A bare address
 * still autolinks, and it reads as what it is.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** GitHub rejects a step summary over 1 MiB, so leave a margin. */
export const MAX_BYTES = 900 * 1024;
export const MAX_FAILURES = 30;
export const MAX_ERROR_CHARS = 1500;
const OPEN_FAILURES = 5;
const MAX_SKIPPED = 100;
const TOP = 10;
const MAX_RANGES = 12;

/**
 * Each job's reported steps, by `id` in ci.yml, under their `name` there.
 * tools/ci-summary.test.mjs holds these to the workflow, in both directions.
 */
export const JOBS = {
  build: {
    workflowJob: "build",
    title: "typecheck, build, test",
    steps: {
      install: "Install",
      generated: "Generated artifacts are up to date",
      typecheck: "Typecheck the app",
      build: "Build",
      "clean-build": "The build changed no tracked file",
      "tools-tests": "Tools tests",
      "stamped-build": "The served agent instructions carry this build's origin",
      "functions-tests": "Functions tests",
      "app-tests": "App tests and coverage",
      "cli-tests": "CLI tests",
      "dry-runs": "Operator scripts run without credentials",
    },
    suites: [
      { id: "tools", label: "Tools", step: "tools-tests", report: "ci-report-tools.jsonl" },
      { id: "functions", label: "Functions", step: "functions-tests", report: "ci-report-functions.jsonl" },
      { id: "app", label: "App", step: "app-tests", report: "ci-report-app.json", vitest: true, scopeDepth: 3 },
      { id: "cli", label: "CLI", step: "cli-tests", report: "ci-report-cli.jsonl" },
    ],
    bundle: true,
  },
  rules: {
    workflowJob: "rules",
    title: "security rules",
    steps: {
      install: "Install",
      "firebase-cli": "Install the Firebase CLI",
      "rules-tests": "Rules tests against the emulators",
    },
    suites: [{ id: "rules", label: "Rules", step: "rules-tests", report: "ci-report-rules.jsonl" }],
    bundle: false,
  },
};

// --- Escaping ---------------------------------------------------------------

/** Text safe inside a table cell or a sentence: no markup, no link, no cell break. */
export function inline(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\|/g, "&#124;")
    .replace(/`/g, "&#96;")
    .replace(/\[/g, "&#91;")
    .replace(/\]/g, "&#93;")
    .replace(/\*/g, "&#42;")
    .replace(/_/g, "&#95;")
    .replace(/~/g, "&#126;")
    .replace(/\s+/g, " ")
    .trim();
}

/** A code block no backtick inside can close. */
export function fence(text) {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
  const mark = "`".repeat(longest + 1);
  return `${mark}text\n${text}\n${mark}`;
}

/** An error as it should be read: no colour codes, no runner paths, not too long. */
export function cleanError(text, root) {
  const cleaned = String(text ?? "")
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "")
    .split(`file://${root}${sep}`).join("")
    .split(`${root}${sep}`).join("")
    .split("\n")
    // The test runner's own frames say nothing about what failed.
    .filter((line) => !/^\s+at .*(node_modules|node:internal|\(<anonymous>\))/.test(line))
    .join("\n")
    .trim();
  return cleaned.length > MAX_ERROR_CHARS ? `${cleaned.slice(0, MAX_ERROR_CHARS)}\n… trimmed, the log has the rest` : cleaned;
}

// --- Formatting -------------------------------------------------------------

const count = (value) => Number(value ?? 0).toLocaleString("en-US");
const percent = (value) => Number(value).toFixed(2);
const signed = (value, digits = 0) => `${value > 0 ? "+" : ""}${digits ? value.toFixed(digits) : count(value)}`;

export function duration(ms) {
  if (!Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const minutes = Math.floor(ms / 60_000);
  return `${minutes}m ${Math.round((ms % 60_000) / 1000)}s`;
}

export function bytes(value) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(2)} MiB`;
}

/** Sorted line numbers as ranges: 1-3, 7. */
export function ranges(lines) {
  const out = [];
  for (const line of [...lines].sort((a, b) => a - b)) {
    const last = out.at(-1);
    if (last && line <= last[1] + 1) last[1] = line;
    else out.push([line, line]);
  }
  const shown = out.slice(0, MAX_RANGES).map(([from, to]) => (from === to ? `${from}` : `${from}-${to}`));
  if (out.length > MAX_RANGES) shown.push(`and ${out.length - MAX_RANGES} more`);
  return shown.join(", ");
}

function table(headers, rows) {
  const align = headers.map((header) => (header.endsWith(":") ? "---:" : "---"));
  const names = headers.map((header) => header.replace(/:$/, ""));
  return [`| ${names.join(" | ")} |`, `| ${align.join(" | ")} |`, ...rows.map((row) => `| ${row.join(" | ")} |`)].join("\n");
}

const details = (summary, body, open = false) => `<details${open ? " open" : ""}><summary>${summary}</summary>\n\n${body}\n\n</details>`;

// --- Reading the reports ----------------------------------------------------

function repoPath(path, root) {
  if (!path) return null;
  const absolute = path.startsWith("file://") ? fileURLToPath(path) : resolve(path);
  const rel = relative(root, absolute);
  return rel.startsWith("..") ? absolute : rel.split(sep).join("/");
}

const emptyCounts = () => ({ tests: 0, passed: 0, failed: 0, cancelled: 0, skipped: 0, todo: 0 });

function tally(cases) {
  const counts = emptyCounts();
  const field = { pass: "passed", fail: "failed", cancelled: "cancelled", skip: "skipped", todo: "todo" };
  for (const entry of cases) {
    counts.tests += 1;
    counts[field[entry.status]] += 1;
  }
  return counts;
}

/** The node:test JSONL written by ci-test-reporter.mjs. A line cut off by a crash is dropped. */
export function parseNodeReport(text, root) {
  const records = String(text).split("\n").filter(Boolean).flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });

  const stderr = new Map(records.filter((r) => r.kind === "stderr").map((r) => [r.file, r.lines]));
  const cases = records.filter((r) => r.kind === "case").map((r) => ({
    ...r,
    file: repoPath(r.file, root),
    message: [r.wholeFile && stderr.has(r.file) ? stderr.get(r.file).join("\n") : r.message, ...(r.frames ?? [])].filter(Boolean).join("\n"),
  }));

  const files = new Map();
  for (const record of records.filter((r) => r.kind === "file")) {
    const file = repoPath(record.file, root);
    files.set(file, { file, durationMs: record.durationMs, ...emptyCounts(), ...record.counts });
  }
  // A file that failed as a whole never reports a summary of its own.
  for (const file of new Set(cases.map((entry) => entry.file))) {
    if (file && !files.has(file)) {
      const own = cases.filter((entry) => entry.file === file && entry.type !== "suite");
      files.set(file, { file, durationMs: own.reduce((sum, entry) => sum + (entry.durationMs ?? 0), 0), ...tally(own) });
    }
  }

  const total = records.find((r) => r.kind === "total");
  const coverage = records.find((r) => r.kind === "coverage");
  return {
    complete: Boolean(total),
    counts: total ? { ...emptyCounts(), ...total.counts } : tally(cases.filter((entry) => entry.type !== "suite")),
    durationMs: total?.durationMs ?? null,
    files: [...files.values()],
    cases,
    coverage: coverage ? nodeCoverage(coverage, root) : null,
  };
}

const measure = (covered, total, pct) => ({ covered, total, pct: Number(pct) });

function nodeMeasures(entry) {
  return {
    lines: measure(entry.coveredLineCount, entry.totalLineCount, entry.coveredLinePercent),
    branches: measure(entry.coveredBranchCount, entry.totalBranchCount, entry.coveredBranchPercent),
    functions: measure(entry.coveredFunctionCount, entry.totalFunctionCount, entry.coveredFunctionPercent),
  };
}

const asPercent = (covered, total) => (total === 0 ? 100 : (covered / total) * 100);

const bestOf = (copies, name) => copies.map((copy) => copy[name]).sort((a, b) => b.pct - a.pct)[0];

/**
 * One file's copies as one row. A test that imports `config.mjs?t=1` for a fresh
 * module gets a separate entry per address, and node:test lists and totals each
 * as though they were different files. Lines merge exactly, since a line ran if
 * any copy ran it. Which branches and functions each copy hit is not reported,
 * so those take the best copy, which can only understate the truth.
 */
function mergeCopies(path, copies) {
  if (copies.length === 1) return { path, ...copies[0] };
  const uncovered = copies.map((copy) => new Set(copy.uncovered)).reduce((kept, next) => new Set([...kept].filter((line) => next.has(line))));
  const total = Math.max(...copies.map((copy) => copy.lines.total));
  const covered = total - uncovered.size;
  return {
    path,
    lines: measure(covered, total, asPercent(covered, total)),
    branches: bestOf(copies, "branches"),
    functions: bestOf(copies, "functions"),
    uncovered: [...uncovered],
  };
}

function nodeCoverage(record, root) {
  const byPath = new Map();
  for (const file of record.files) {
    const path = repoPath(file.path, root);
    byPath.set(path, [...(byPath.get(path) ?? []), { ...nodeMeasures(file), uncovered: file.uncovered ?? [] }]);
  }
  const files = [...byPath].map(([path, copies]) => mergeCopies(path, copies));
  const total = (name) => {
    const covered = files.reduce((sum, file) => sum + file[name].covered, 0);
    const all = files.reduce((sum, file) => sum + file[name].total, 0);
    return measure(covered, all, asPercent(covered, all));
  };
  return { totals: { lines: total("lines"), branches: total("branches"), functions: total("functions") }, files };
}

/** Vitest's JSON reporter, with includeTaskLocation on so a case knows its line. */
export function parseVitestReport(data, root) {
  const status = { passed: "pass", failed: "fail", skipped: "skip", pending: "skip", disabled: "skip", todo: "todo" };
  const cases = [];
  const files = [];
  for (const result of data.testResults ?? []) {
    const file = repoPath(result.name, root);
    const own = (result.assertionResults ?? []).map((assertion) => ({
      kind: "case",
      type: "test",
      file,
      line: assertion.location?.line ?? null,
      path: [...(assertion.ancestorTitles ?? []), assertion.title],
      status: status[assertion.status] ?? "skip",
      reason: null,
      durationMs: assertion.duration ?? 0,
      failureType: null,
      message: (assertion.failureMessages ?? []).join("\n"),
    }));
    cases.push(...own);
    files.push({ file, durationMs: (result.endTime ?? 0) - (result.startTime ?? 0), ...tally(own) });
    // An import error or a failing top-level hook: no case to hang it on.
    if (result.message) {
      cases.push({ kind: "case", type: "suite", file, line: null, path: ["(the whole file)"], status: "fail", reason: null, durationMs: 0, failureType: null, wholeFile: true, message: result.message });
    }
  }
  const ends = (data.testResults ?? []).map((result) => result.endTime).filter(Number.isFinite);
  return {
    complete: true,
    counts: tally(cases.filter((entry) => entry.type !== "suite")),
    durationMs: ends.length && Number.isFinite(data.startTime) ? Math.max(...ends) - data.startTime : null,
    files,
    cases,
    coverage: null,
  };
}

/** Lines with no hit, the way the text reporter counts them: a line's hits are its busiest statement's. */
function uncoveredLines(detail) {
  if (!detail?.statementMap || !detail.s) return [];
  const hits = new Map();
  for (const [id, location] of Object.entries(detail.statementMap)) {
    const line = location.start.line;
    hits.set(line, Math.max(hits.get(line) ?? 0, detail.s[id] ?? 0));
  }
  return [...hits].filter(([, hit]) => hit === 0).map(([line]) => line);
}

/** Vitest's `json-summary` and `json` coverage output. */
export function parseVitestCoverage(summary, detail, root) {
  const measures = (entry) => ({
    lines: measure(entry.lines.covered, entry.lines.total, entry.lines.pct),
    branches: measure(entry.branches.covered, entry.branches.total, entry.branches.pct),
    functions: measure(entry.functions.covered, entry.functions.total, entry.functions.pct),
    statements: measure(entry.statements.covered, entry.statements.total, entry.statements.pct),
  });
  const { total, ...files } = summary;
  return {
    totals: measures(total),
    files: Object.entries(files).map(([path, entry]) => ({ path: repoPath(path, root), ...measures(entry), uncovered: uncoveredLines(detail?.[path]) })),
  };
}

export function readBundle(root) {
  const assets = join(root, "app", "dist", "assets");
  if (!existsSync(assets)) return null;
  const files = readdirSync(assets).filter((name) => /\.(js|css)$/.test(name)).map((name) => {
    const body = readFileSync(join(assets, name));
    return { name, kind: name.endsWith(".css") ? "css" : "js", raw: body.length, gzip: gzipSync(body).length };
  }).sort((a, b) => b.raw - a.raw);
  const sum = (kind, field) => files.filter((file) => file.kind === kind).reduce((total, file) => total + file[field], 0);
  return { files, totals: { jsRaw: sum("js", "raw"), jsGzip: sum("js", "gzip"), cssRaw: sum("css", "raw"), cssGzip: sum("css", "gzip") } };
}

// --- Deciding what a result means -------------------------------------------

const OUTCOME = { success: "✅ passed", failure: "❌ failed", cancelled: "🚫 cancelled", skipped: "⏭️ not run" };
const outcomeText = (outcome) => OUTCOME[outcome] ?? OUTCOME.skipped;

/** A suite's result: its step's outcome read against its report. Absent data is never a pass. */
export function suiteResult(outcome, report) {
  if (outcome === "cancelled") return { icon: "🚫", text: "cancelled" };
  if (outcome !== "success" && outcome !== "failure") return { icon: "⏭️", text: "not run" };
  if (outcome === "failure") {
    if (!report) return { icon: "❌", text: "failed, no report" };
    if (!report.complete) return { icon: "❌", text: "failed, report cut short" };
    return { icon: "❌", text: "failed" };
  }
  if (!report) return { icon: "⚠️", text: "no report" };
  if (!report.complete) return { icon: "⚠️", text: "report cut short" };
  if (report.counts.tests === 0) return { icon: "⚠️", text: "ran no tests" };
  if (report.counts.failed > 0) return { icon: "⚠️", text: "passed, but the report shows failures" };
  return { icon: "✅", text: "passed" };
}

/** Failures worth reading. A parent that failed because a child did, or a case its parent cancelled, repeats one. */
export const failuresOf = (report) =>
  (report?.cases ?? []).filter((entry) => entry.status === "fail" && entry.failureType !== "subtestsFailed");

/** What the next run compares with. */
export function snapshotOf(model) {
  const suites = {};
  const coverage = {};
  for (const suite of model.suites) {
    if (!suite.report?.complete) continue;
    const { tests, skipped, todo } = suite.report.counts;
    suites[suite.id] = { label: suite.label, tests, skipped, todo };
    if (suite.coverage?.files.length) {
      // Two places, as shown: node:test reports more, and a difference nobody can see is noise.
      coverage[suite.id] = Object.fromEntries(Object.entries(suite.coverage.totals).map(([name, value]) => [name, Math.round(value.pct * 100) / 100]));
    }
  }
  return { job: model.job, sha: model.meta.sha ?? null, version: model.meta.version ?? null, suites, coverage, bundle: model.bundle?.totals ?? null };
}

const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/** Every measured difference. A cached file is read as numbers only, so a bad one shows nothing rather than text. */
export function changesSince(baseline, current) {
  const rows = [];
  const add = (name, before, now, format, warn = () => false) => {
    if (!Number.isFinite(before) || !Number.isFinite(now) || before === now) return;
    rows.push({ name, before: format(before), now: format(now), change: format === percent ? signed(now - before, 2) : signed(now - before), warn: warn(before, now) });
  };
  for (const [id, suite] of Object.entries(current.suites)) {
    const was = baseline.suites?.[id];
    if (!isRecord(was)) continue;
    add(`${suite.label} tests`, was.tests, suite.tests, count, (before, now) => now < before);
    add(`${suite.label} skipped and todo`, was.skipped + was.todo, suite.skipped + suite.todo, count, (before, now) => now > before);
  }
  for (const [id, totals] of Object.entries(current.coverage)) {
    const was = baseline.coverage?.[id];
    if (!isRecord(was)) continue;
    const label = current.suites[id].label;
    for (const [name, value] of Object.entries(totals)) add(`${label} ${name} %`, was[name], value, percent);
  }
  const bundleNames = { jsRaw: "JS", jsGzip: "JS gzip", cssRaw: "CSS", cssGzip: "CSS gzip" };
  for (const [name, label] of Object.entries(bundleNames)) {
    if (isRecord(baseline.bundle) && current.bundle) add(`${label}, bytes`, baseline.bundle[name], current.bundle[name], count);
  }
  return rows;
}

// --- Rendering --------------------------------------------------------------

function sourceLink(model, file, line) {
  const label = inline(line ? `${file}:${line}` : file);
  if (!model.blobUrl || !file || file.startsWith("/")) return label;
  const path = encodeURI(file).replace(/\(/g, "%28").replace(/\)/g, "%29");
  return `[${label}](${model.blobUrl}/${path}${line ? `#L${line}` : ""})`;
}

function renderHeader(model) {
  const { sha, commitUrl, version, ref, event, node } = model.meta;
  const short = sha ? sha.slice(0, 8) : null;
  const commit = short && commitUrl ? `[${short}](${commitUrl})` : (short ?? null);
  const facts = [version && `v${inline(version)}`, commit, ref && inline(ref), event && inline(event), node && `Node ${inline(node)}`].filter(Boolean);

  const ran = model.suites.filter((suite) => suite.report);
  const total = (field) => ran.reduce((sum, suite) => sum + suite.report.counts[field], 0);
  const failedStep = model.steps.find((step) => step.outcome === "failure");
  const failed = Boolean(failedStep);
  const warned = model.suites.some((suite) => suite.result.icon === "⚠️");
  const icon = failed ? "❌" : warned ? "⚠️" : "✅";
  const outcome = failed
    ? `Failed at ${inline(failedStep.label)}.${ran.length ? ` ${count(total("tests"))} tests reported, ${count(total("failed"))} failed.` : ""}`
    : warned
      ? "The steps passed, but a suite needs a look."
      : `${count(total("tests"))} tests passed across ${count(ran.length)} ${ran.length === 1 ? "suite" : "suites"}.`;
  return `## ${icon} ${inline(model.title)}\n\n${facts.join(" · ")}\n\n**${outcome}**`;
}

function renderSteps(model) {
  const rows = model.steps.map((step) => [inline(step.label), outcomeText(step.outcome)]);
  const allPassed = model.steps.every((step) => step.outcome === "success");
  const summary = allPassed ? `All ${model.steps.length} steps passed` : "Steps";
  return details(summary, table(["Step", "Result"], rows), !allPassed);
}

function renderSuites(model) {
  const rows = model.suites.map((suite) => {
    const { report, result } = suite;
    const counts = report?.counts;
    const cell = (value) => (report ? count(value) : "—");
    return [
      suite.label,
      `${result.icon} ${result.text}`,
      cell(counts?.tests),
      cell(counts?.passed),
      cell(counts?.failed),
      cell(counts?.cancelled),
      cell(counts?.skipped),
      cell(counts?.todo),
      cell(report?.files.length),
      report ? duration(report.durationMs) : "—",
    ];
  });
  return `### Tests\n\n${table(["Suite", "Result", "Tests:", "Passed:", "Failed:", "Cancelled:", "Skipped:", "Todo:", "Files:", "Duration:"], rows)}`;
}

function renderFailures(model) {
  const failures = model.suites.flatMap((suite) => failuresOf(suite.report).map((entry) => ({ suite, entry })));
  const silent = model.suites.filter((suite) => suite.outcome === "failure" && !failuresOf(suite.report).length);
  if (!failures.length && !silent.length) return null;

  const parts = [failures.length ? `### Failures (${count(failures.length)})` : "### Failures"];
  for (const suite of silent) {
    parts.push(`**${suite.label}:** the step failed with no failing test in its report. The cause may be a coverage threshold, an error outside any test, or a crash, so check the log.`);
  }
  failures.slice(0, MAX_FAILURES).forEach(({ suite, entry }, index) => {
    const name = entry.wholeFile ? "the whole file failed" : entry.path.join(" › ");
    const body = [sourceLink(model, entry.file, entry.line), entry.message ? fence(cleanError(entry.message, model.root)) : "No message was reported."].join("\n\n");
    parts.push(details(`<b>${suite.label}</b>: ${inline(name)}`, body, index < OPEN_FAILURES));
  });
  if (failures.length > MAX_FAILURES) parts.push(`And ${count(failures.length - MAX_FAILURES)} more, in the log.`);
  return parts.join("\n\n");
}

function renderChanges(model) {
  const heading = "### Changes since main";
  if (!model.baseline) return `${heading}\n\nNo baseline to compare with. One is saved by each green run on \`main\`, and the cache may have evicted the last.`;
  const sha = /^[0-9a-f]{7,64}$/.test(model.baseline.sha ?? "") ? model.baseline.sha : null;
  const against = sha ? (model.meta.repoUrl ? `[${sha.slice(0, 8)}](${model.meta.repoUrl}/commit/${sha})` : sha.slice(0, 8)) : "an unknown commit";
  const rows = changesSince(model.baseline, model.snapshot);
  const lead = `Compared with ${against}, the latest green run on \`main\` in the cache.`;
  const missing = model.suites.filter((suite) => !suite.report?.complete).map((suite) => suite.label);
  const left = missing.length ? ` No report to compare from: ${missing.join(", ")}.` : "";
  if (!rows.length) return `${heading}\n\n${lead} Nothing measured has changed.${left}`;
  const body = rows.map((row) => [`${row.warn ? "⚠️ " : ""}${row.name}`, row.before, row.now, row.change]);
  return `${heading}\n\n${lead}${left}\n\n${table(["Measure", "Before:", "Now:", "Change:"], body)}`;
}

const coverageCell = (entry, name) => (entry[name] ? percent(entry[name].pct) : "—");

/** The areas a suite's figure is about, read from the report so it cannot go stale. */
export const scopeOf = (files, depth = 2) => [...new Set(files.map((file) => file.path.split("/").slice(0, depth).join("/")))].sort();

function rollup(files) {
  const folders = new Map();
  for (const file of files) {
    const folder = dirname(file.path);
    const entry = folders.get(folder) ?? { path: folder, files: 0 };
    entry.files += 1;
    for (const name of ["lines", "branches", "functions", "statements"]) {
      if (!file[name]) continue;
      const sum = entry[name] ?? { covered: 0, total: 0 };
      sum.covered += file[name].covered;
      sum.total += file[name].total;
      sum.pct = sum.total === 0 ? 100 : Math.floor((sum.covered / sum.total) * 10000) / 100;
      entry[name] = sum;
    }
    folders.set(folder, entry);
  }
  return [...folders.values()].sort((a, b) => a.path.localeCompare(b.path));
}

function renderCoverage(model) {
  const suites = model.suites.filter((suite) => suite.coverage);
  if (!suites.length) return null;
  const parts = ["### Coverage"];
  parts.push(table(["Suite", "Lines:", "Branches:", "Functions:", "Statements:", "Files:", "Measures"], suites.map((suite) => {
    const { totals, files } = suite.coverage;
    // node:test reports 100% of nothing when its filters match no file.
    if (!files.length) return [suite.label, "—", "—", "—", "—", "0", "⚠️ measured no files, so check the coverage flags in `ci.yml`"];
    const scope = scopeOf(files, suite.scopeDepth);
    const shown = scope.length > 6 ? `${scope.slice(0, 6).map(inline).join(", ")} and ${scope.length - 6} more` : scope.map(inline).join(", ");
    return [suite.label, coverageCell(totals, "lines"), coverageCell(totals, "branches"), coverageCell(totals, "functions"), coverageCell(totals, "statements"), count(files.length), shown];
  })));
  parts.push("App counts only the areas listed, as `app/vite.config.ts` sets out, so its figure says nothing about the rest of `app/src`. App is measured by Vitest and the others by `node:test`, which count differently, so compare a suite with its own past, not with another suite.");

  const app = suites.find((suite) => suite.id === "app");
  if (app && model.thresholds) {
    parts.push(`**App against its thresholds**\n\n${table(["Measure", "Now:", "Threshold:", "Margin:"], Object.entries(model.thresholds).map(([name, floor]) => {
      const now = app.coverage.totals[name]?.pct;
      const margin = now - floor;
      if (!Number.isFinite(margin)) return [`⚠️ ${inline(name)}`, "—", percent(floor), "—"];
      return [`${margin < 0 ? "❌ " : ""}${inline(name)}`, percent(now), percent(floor), signed(margin, 2)];
    }))}`);
  }
  if (model.coverageUrl) parts.push(`The App's line-by-line report is a [download from this run](${model.coverageUrl}).`);

  const lowest = suites
    .flatMap((suite) => suite.coverage.files.filter((file) => file.uncovered.length).map((file) => ({ suite, file })))
    .sort((a, b) => a.file.lines.pct - b.file.lines.pct)
    .slice(0, TOP);
  if (lowest.length) {
    parts.push(`**Lowest line coverage**\n\n${table(["Suite", "File", "Lines:", "Branches:", "Functions:", "Uncovered lines"], lowest.map(({ suite, file }) => [
      suite.label,
      sourceLink(model, file.path, file.uncovered[0]),
      coverageCell(file, "lines"),
      coverageCell(file, "branches"),
      coverageCell(file, "functions"),
      ranges(file.uncovered),
    ]))}`);
  }
  return parts.join("\n\n");
}

function renderCoverageTables(model) {
  const suites = model.suites.filter((suite) => suite.coverage?.files.length);
  if (!suites.length) return null;
  return suites.map((suite) => {
    const folders = table(["Folder", "Files:", "Lines:", "Branches:", "Functions:"], rollup(suite.coverage.files).map((folder) => [
      inline(folder.path), count(folder.files), coverageCell(folder, "lines"), coverageCell(folder, "branches"), coverageCell(folder, "functions"),
    ]));
    const files = table(["File", "Lines:", "Branches:", "Functions:", "Uncovered lines"], [...suite.coverage.files].sort((a, b) => a.path.localeCompare(b.path)).map((file) => [
      sourceLink(model, file.path), coverageCell(file, "lines"), coverageCell(file, "branches"), coverageCell(file, "functions"), ranges(file.uncovered),
    ]));
    return details(`${suite.label} coverage, by folder and file`, `${folders}\n\n${files}`);
  }).join("\n\n");
}

function renderSlowest(model) {
  const tests = model.suites
    .flatMap((suite) => (suite.report?.cases ?? []).filter((entry) => entry.type === "test" && (entry.status === "pass" || entry.status === "fail") && !entry.wholeFile).map((entry) => ({ suite, entry })))
    .sort((a, b) => b.entry.durationMs - a.entry.durationMs)
    .slice(0, TOP);
  const files = model.suites
    .flatMap((suite) => (suite.report?.files ?? []).map((file) => ({ suite, file })))
    .sort((a, b) => b.file.durationMs - a.file.durationMs)
    .slice(0, TOP);
  if (!tests.length && !files.length) return null;
  const parts = ["### Slowest"];
  if (tests.length) {
    parts.push(table(["Suite", "Test", "Where", "Time:"], tests.map(({ suite, entry }) => [suite.label, inline(entry.path.join(" › ")), sourceLink(model, entry.file, entry.line), duration(entry.durationMs)])));
  }
  if (files.length) {
    parts.push(table(["Suite", "File", "Tests:", "Time:"], files.map(({ suite, file }) => [suite.label, sourceLink(model, file.file), count(file.tests), duration(file.durationMs)])));
  }
  return parts.join("\n\n");
}

function renderSkipped(model) {
  const entries = model.suites.flatMap((suite) => (suite.report?.cases ?? []).filter((entry) => entry.status === "skip" || entry.status === "todo").map((entry) => ({ suite, entry })));
  if (!model.suites.some((suite) => suite.report)) return null;
  if (!entries.length) return "### Skipped and todo\n\nNo test was skipped or left as todo.";
  const rows = entries.slice(0, MAX_SKIPPED).map(({ suite, entry }) => [suite.label, entry.status, inline(entry.path.join(" › ")), sourceLink(model, entry.file, entry.line), inline(entry.reason ?? "")]);
  const more = entries.length > MAX_SKIPPED ? `\n\nAnd ${count(entries.length - MAX_SKIPPED)} more, in the log.` : "";
  return `### Skipped and todo (${count(entries.length)})\n\n${table(["Suite", "Kind", "Test", "Where", "Reason"], rows)}${more}`;
}

function renderBundle(model) {
  if (!model.bundle?.files.length) return null;
  const { files, totals } = model.bundle;
  const rows = files.slice(0, TOP).map((file) => [inline(file.name), bytes(file.raw), bytes(file.gzip)]);
  rows.push(["**All JS**", `**${bytes(totals.jsRaw)}**`, `**${bytes(totals.jsGzip)}**`], ["**All CSS**", `**${bytes(totals.cssRaw)}**`, `**${bytes(totals.cssGzip)}**`]);
  return `### Bundle\n\nSource maps are left out.\n\n${table(["Asset", "Size:", "Gzip:"], rows)}`;
}

function renderPerFile(model) {
  const suites = model.suites.filter((suite) => suite.report?.files.length);
  if (!suites.length) return null;
  return suites.map((suite) => {
    const rows = [...suite.report.files].sort((a, b) => b.durationMs - a.durationMs).map((file) => [sourceLink(model, file.file), count(file.tests), count(file.failed), count(file.skipped + file.todo), duration(file.durationMs)]);
    return details(`${suite.label}, every file (${count(rows.length)})`, table(["File", "Tests:", "Failed:", "Skipped or todo:", "Time:"], rows));
  }).join("\n\n");
}

const byteLength = (text) => Buffer.byteLength(text, "utf8");

/** The summary as Markdown. Pure, so every state a run can be in is testable without a run. */
export function renderSummary(model) {
  const sections = [
    { body: renderHeader(model) },
    { body: renderSteps(model) },
    { body: renderSuites(model) },
    { body: renderFailures(model) },
    { body: renderChanges(model) },
    { body: renderCoverage(model) },
    { body: renderSlowest(model) },
    { body: renderSkipped(model) },
    { body: renderBundle(model) },
    { body: renderCoverageTables(model), droppable: "coverage per file" },
    { body: renderPerFile(model), droppable: "tests per file" },
  ].filter((section) => section.body);

  const dropped = [];
  const render = () => {
    const note = dropped.length ? [`Left out to stay under GitHub's size limit: ${dropped.join(", ")}.`] : [];
    return `${[...sections.map((section) => section.body), ...note].join("\n\n")}\n`;
  };
  // Largest detail first, then whatever it takes. The first three sections always survive.
  for (let index = sections.length - 1; byteLength(render()) > model.maxBytes && index >= 0; index -= 1) {
    if (sections[index].droppable) {
      dropped.unshift(sections[index].droppable);
      sections.splice(index, 1);
    }
  }
  for (let index = sections.length - 1; byteLength(render()) > model.maxBytes && index >= 3; index -= 1) {
    dropped.unshift(sections[index].body.split("\n", 1)[0].replace(/^#+\s*/, ""));
    sections.splice(index, 1);
  }
  return render();
}

// --- The run ----------------------------------------------------------------

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function readSuiteReport(suite, reportDir, root) {
  const path = join(reportDir, suite.report);
  if (!existsSync(path) || statSync(path).size === 0) return null;
  try {
    return suite.vitest ? parseVitestReport(JSON.parse(readFileSync(path, "utf8")), root) : parseNodeReport(readFileSync(path, "utf8"), root);
  } catch {
    return null;
  }
}

/** Everything the renderer needs, gathered from the disk and the environment. */
export function collect({ job, root = ROOT, reportDir, steps = {}, baselinePath = null, env = {}, maxBytes = MAX_BYTES }) {
  const config = JOBS[job];
  if (!config) throw new Error(`unknown job: ${job}`);

  const ran = (id) => steps[id]?.outcome === "success" || steps[id]?.outcome === "failure";
  const suites = config.suites.map((suite) => {
    const outcome = steps[suite.step]?.outcome ?? "skipped";
    // Only a report from a step that ran: an old file is not this run's result.
    const report = ran(suite.step) ? readSuiteReport(suite, reportDir, root) : null;
    let coverage = report?.coverage ?? null;
    if (suite.vitest && ran(suite.step)) {
      const summary = readJson(join(root, "app", "coverage", "coverage-summary.json"));
      if (summary?.total) coverage = parseVitestCoverage(summary, readJson(join(root, "app", "coverage", "coverage-final.json")), root);
    }
    return { ...suite, outcome, report, coverage, result: suiteResult(outcome, report) };
  });

  const server = env.GITHUB_SERVER_URL ?? "https://github.com";
  const repoUrl = env.GITHUB_REPOSITORY ? `${server}/${env.GITHUB_REPOSITORY}` : null;
  const sha = env.BIKESHED_CI_SOURCE_SHA || env.GITHUB_SHA || null;
  const coverageUrl = /^https:\/\//.test(env.BIKESHED_CI_COVERAGE_URL ?? "") ? env.BIKESHED_CI_COVERAGE_URL : null;
  const baseline = baselinePath ? readJson(baselinePath) : null;

  const model = {
    job,
    title: config.title,
    root,
    maxBytes,
    meta: {
      sha,
      repoUrl,
      commitUrl: repoUrl && sha ? `${repoUrl}/commit/${sha}` : null,
      version: readJson(join(root, "package.json"))?.version ?? null,
      ref: env.GITHUB_REF_NAME ?? null,
      event: env.GITHUB_EVENT_NAME ?? null,
      node: process.version,
    },
    blobUrl: repoUrl && sha ? `${repoUrl}/blob/${sha}` : null,
    steps: Object.entries(config.steps).map(([id, label]) => ({ id, label, outcome: steps[id]?.outcome ?? "skipped" })),
    suites,
    thresholds: config.suites.some((suite) => suite.vitest) ? readJson(join(root, "app", "coverage-thresholds.json")) : null,
    coverageUrl,
    bundle: config.bundle && ran("build") ? readBundle(root) : null,
    baseline: isRecord(baseline) ? baseline : null,
  };
  model.snapshot = snapshotOf(model);
  return model;
}

function main() {
  const job = process.argv[process.argv.indexOf("--job") + 1];
  const output = process.env.GITHUB_STEP_SUMMARY;
  const write = (text) => (output ? appendFileSync(output, text) : process.stdout.write(text));
  try {
    const baselinePath = process.env.BIKESHED_CI_BASELINE || null;
    const model = collect({
      job,
      reportDir: process.env.BIKESHED_CI_REPORT_DIR ?? process.env.RUNNER_TEMP ?? ".",
      steps: JSON.parse(process.env.BIKESHED_CI_STEPS || "{}"),
      baselinePath,
      env: process.env,
    });
    write(renderSummary(model));
    if (baselinePath) {
      mkdirSync(dirname(baselinePath), { recursive: true });
      writeFileSync(baselinePath, `${JSON.stringify(model.snapshot)}\n`);
    }
  } catch (error) {
    // The one place an error here shows: the summary is where someone is looking.
    write(`## ⚠️ ${basename(fileURLToPath(import.meta.url))} could not write this summary\n\n${fence(String(error?.stack ?? error))}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
