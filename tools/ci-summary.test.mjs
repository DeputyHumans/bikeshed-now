// SPDX-License-Identifier: Apache-2.0
// Tests what CI's job summary says for each state a run can be in (SPEC §12).

import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  JOBS,
  MAX_BYTES,
  MAX_ERROR_CHARS,
  MAX_FAILURES,
  changesSince,
  cleanError,
  collect,
  duration,
  fence,
  inline,
  parseNodeReport,
  parseVitestCoverage,
  parseVitestReport,
  ranges,
  renderSummary,
  scopeOf,
  suiteResult,
} from "./ci-summary.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

const jsonl = (...records) => records.map((record) => JSON.stringify(record)).join("\n");

const COUNTS = { tests: 2, passed: 2, failed: 0, cancelled: 0, skipped: 0, todo: 0, suites: 0, topLevel: 2 };

/** A complete node:test report for one file, in a repository rooted at `root`. */
function nodeReport(root, { file = "test/a.test.mjs", cases = [], counts = COUNTS, coverage = null } = {}) {
  return jsonl(
    ...cases.map((entry) => ({ kind: "case", type: "test", file: join(root, file), line: 3, reason: null, durationMs: 5, status: "pass", path: ["works"], ...entry })),
    { kind: "file", file: join(root, file), counts, durationMs: 40 },
    { kind: "total", file: null, counts, durationMs: 50 },
    ...(coverage ? [coverage] : []),
  );
}

const failing = (overrides = {}) => ({ status: "fail", path: ["group", "breaks"], failureType: "testCodeFailure", message: "expected 1 to be 2", frames: [], wholeFile: false, ...overrides });

const STEPS_ALL_PASSED = (job) => Object.fromEntries(Object.keys(JOBS[job].steps).map((id) => [id, { outcome: "success", conclusion: "success", outputs: {} }]));

const ENV = { GITHUB_REPOSITORY: "acme/repo", GITHUB_SHA: "a".repeat(40), GITHUB_REF_NAME: "main", GITHUB_EVENT_NAME: "push" };

describe("the job summary", () => {
  let root;

  before(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "ci-summary-")));
    writeFileSync(join(root, "package.json"), JSON.stringify({ version: "1.2.3" }));
  });

  after(() => rmSync(root, { recursive: true, force: true }));

  /** Writes reports under a fresh directory and renders the rules job, which has a single suite. */
  function renderRules(report, steps = STEPS_ALL_PASSED("rules"), extra = {}) {
    const reportDir = mkdtempSync(join(root, "reports-"));
    if (report !== null) writeFileSync(join(reportDir, "ci-report-rules.jsonl"), report);
    const model = collect({ job: "rules", root, reportDir, steps, env: ENV, ...extra });
    return { model, markdown: renderSummary(model) };
  }

  describe("a suite's result", () => {
    const complete = (counts = COUNTS) => ({ complete: true, counts });

    test("a passing step with a full report passes", () => {
      assert.deepEqual(suiteResult("success", complete()), { icon: "✅", text: "passed" });
    });

    test("a passing step with no report is not a pass", () => {
      assert.equal(suiteResult("success", null).icon, "⚠️");
      assert.equal(suiteResult("success", null).text, "no report");
    });

    test("a passing step that ran no tests is not a pass", () => {
      assert.equal(suiteResult("success", complete({ ...COUNTS, tests: 0, passed: 0 })).text, "ran no tests");
    });

    test("a passing step whose report was cut short is not a pass", () => {
      assert.equal(suiteResult("success", { complete: false, counts: COUNTS }).icon, "⚠️");
    });

    test("a passing step whose report lists failures is not a pass", () => {
      assert.equal(suiteResult("success", complete({ ...COUNTS, failed: 1 })).icon, "⚠️");
    });

    test("a skipped step, or one missing from the steps, is not run", () => {
      assert.equal(suiteResult("skipped", null).text, "not run");
      assert.equal(suiteResult(undefined, null).text, "not run");
    });

    test("a failed step fails, with or without a report", () => {
      assert.equal(suiteResult("failure", complete()).icon, "❌");
      assert.equal(suiteResult("failure", null).text, "failed, no report");
    });
  });

  describe("the page", () => {
    test("a green run says so, with the tests counted", () => {
      const { markdown } = renderRules(nodeReport(root));
      assert.match(markdown, /## ✅ security rules/);
      assert.match(markdown, /2 tests passed across 1 suite/);
      assert.match(markdown, /All 3 steps passed/);
    });

    test("a step that passed with no report does not read as green", () => {
      const { markdown } = renderRules(null);
      assert.match(markdown, /## ⚠️ security rules/);
      assert.match(markdown, /⚠️ no report/);
      assert.doesNotMatch(markdown, /tests passed/);
    });

    test("a glob that matched nothing does not read as green", () => {
      const none = { tests: 0, passed: 0, failed: 0, cancelled: 0, skipped: 0, todo: 0 };
      const { markdown } = renderRules(jsonl({ kind: "total", file: null, counts: none, durationMs: 1 }));
      assert.match(markdown, /⚠️ ran no tests/);
      assert.match(markdown, /## ⚠️/);
    });

    test("a step that never started shows as not run, and an old report on disk is ignored", () => {
      const steps = { ...STEPS_ALL_PASSED("rules"), "firebase-cli": { outcome: "failure" }, "rules-tests": { outcome: "skipped" } };
      const { model, markdown } = renderRules(nodeReport(root), steps);
      assert.equal(model.suites[0].report, null);
      assert.match(markdown, /## ❌ security rules/);
      assert.match(markdown, /Failed at Install the Firebase CLI\./);
      assert.match(markdown, /⏭️ not run/);
    });

    test("failures link to their source at this commit, and are readable", () => {
      const report = nodeReport(root, { cases: [failing()], counts: { ...COUNTS, failed: 1, passed: 1 } });
      const { markdown } = renderRules(report, { ...STEPS_ALL_PASSED("rules"), "rules-tests": { outcome: "failure" } });
      assert.match(markdown, /### Failures \(1\)/);
      assert.match(markdown, /group › breaks/);
      assert.ok(markdown.includes(`[test/a.test.mjs:3](https://github.com/acme/repo/blob/${"a".repeat(40)}/test/a.test.mjs#L3)`));
      assert.match(markdown, /expected 1 to be 2/);
    });

    test("a parent failing because of its child is not listed twice", () => {
      const report = nodeReport(root, { cases: [failing(), failing({ path: ["group"], failureType: "subtestsFailed", message: "1 subtest failed" })] });
      const { markdown } = renderRules(report, { ...STEPS_ALL_PASSED("rules"), "rules-tests": { outcome: "failure" } });
      assert.match(markdown, /### Failures \(1\)/);
      assert.doesNotMatch(markdown, /1 subtest failed/);
    });

    test("a step that failed with no failing test says to look elsewhere", () => {
      const { markdown } = renderRules(nodeReport(root), { ...STEPS_ALL_PASSED("rules"), "rules-tests": { outcome: "failure" } });
      assert.match(markdown, /the step failed with no failing test in its report/);
      assert.match(markdown, /### Failures\n/);
      assert.doesNotMatch(markdown, /Failures \(0\)/);
    });

    test("failures past the cap are counted rather than dropped silently", () => {
      const cases = Array.from({ length: MAX_FAILURES + 7 }, (_, index) => failing({ path: [`case ${index}`] }));
      const { markdown } = renderRules(nodeReport(root, { cases }), { ...STEPS_ALL_PASSED("rules"), "rules-tests": { outcome: "failure" } });
      assert.match(markdown, new RegExp(`### Failures \\(${MAX_FAILURES + 7}\\)`));
      assert.match(markdown, /And 7 more, in the log/);
      assert.ok(markdown.includes(`case ${MAX_FAILURES - 1}`));
      assert.ok(!markdown.includes(`case ${MAX_FAILURES}<`));
    });

    test("skipped and todo tests are listed with their reason", () => {
      const cases = [{ status: "skip", path: ["off"], reason: "needs a canvas" }, { status: "todo", path: ["later"] }];
      const { markdown } = renderRules(nodeReport(root, { cases, counts: { ...COUNTS, skipped: 1, todo: 1 } }));
      assert.match(markdown, /### Skipped and todo \(2\)/);
      assert.match(markdown, /needs a canvas/);
    });

    test("no skipped tests is said out loud", () => {
      assert.match(renderRules(nodeReport(root)).markdown, /No test was skipped or left as todo/);
    });

    test("the slowest tests come first", () => {
      const cases = [{ path: ["quick"], durationMs: 2 }, { path: ["slow"], durationMs: 90_000 }];
      const { markdown } = renderRules(nodeReport(root, { cases }));
      assert.ok(markdown.indexOf("slow") < markdown.indexOf("quick"));
      assert.match(markdown, /1m 30s/);
    });
  });

  describe("text from the tree being tested", () => {
    test("inline text cannot break a table or add markup", () => {
      const hostile = "a|b `c` <img src=x> [link](http://x) ![i](http://y) *d* _e_ ~f~\nnext";
      const safe = inline(hostile);
      for (const mark of ["|", "`", "<", ">", "[", "]", "*", "_", "~", "\n"]) assert.ok(!safe.includes(mark), `${mark} survived in ${safe}`);
    });

    test("a hostile test name stays in its table cell and its summary", () => {
      const name = "x | y `z` <script>alert(1)</script> [click](http://evil.example)";
      const cases = [failing({ path: [name] }), { status: "skip", path: [name] }];
      const { markdown } = renderRules(nodeReport(root, { cases }), { ...STEPS_ALL_PASSED("rules"), "rules-tests": { outcome: "failure" } });
      assert.doesNotMatch(markdown, /<script>/);
      assert.doesNotMatch(markdown, /\[click\]\(http/);
      const skippedRow = markdown.split("\n").find((line) => line.startsWith("| Rules | skip"));
      assert.equal(skippedRow.match(/ \| /g).length, 4, skippedRow);
    });

    test("a code block cannot be closed by what it holds", () => {
      const block = fence("before\n```\nafter ````` end");
      const mark = block.split("\n")[0].replace("text", "");
      assert.equal(mark.length, 6);
      assert.equal(block.endsWith(`\n${mark}`), true);
    });

    test("errors keep the frames in this repository and lose the test runner's", () => {
      const cleaned = cleanError(["boom", "    at /r/app/src/x.test.ts:2:7", "    at /r/app/node_modules/@vitest/runner/dist/a.js:1:1", "    at new Promise (<anonymous>)", "    at node:internal/process/task_queues:1:1"].join("\n"), "/r");
      assert.equal(cleaned, "boom\n    at app/src/x.test.ts:2:7");
    });

    test("errors lose colour codes and runner paths, and are trimmed", () => {
      const cleaned = cleanError(`\x1b[31mboom\x1b[39m at file:///runner/repo/app/x.ts:1\n/runner/repo/app/y.ts`, "/runner/repo");
      assert.equal(cleaned, "boom at app/x.ts:1\napp/y.ts");
      assert.ok(cleanError("x".repeat(MAX_ERROR_CHARS * 2), "/r").length < MAX_ERROR_CHARS + 60);
    });
  });

  describe("the size limit", () => {
    test("an oversized report stays under the cap, and says what it left out", () => {
      const cases = Array.from({ length: 4000 }, (_, index) => ({ path: [`case ${index} ${"long name ".repeat(40)}`], file: join(root, `test/file-${index}.test.mjs`) }));
      const files = cases.map((entry, index) => ({ kind: "file", file: join(root, `test/file-${index}.test.mjs`), counts: COUNTS, durationMs: index }));
      const report = jsonl(...files, { kind: "total", file: null, counts: COUNTS, durationMs: 1 });
      const reportDir = mkdtempSync(join(root, "reports-"));
      writeFileSync(join(reportDir, "ci-report-rules.jsonl"), report);
      const small = 20 * 1024;
      const model = collect({ job: "rules", root, reportDir, steps: STEPS_ALL_PASSED("rules"), env: ENV, maxBytes: small });
      const markdown = renderSummary(model);
      assert.ok(Buffer.byteLength(markdown) <= small, `${Buffer.byteLength(markdown)} bytes`);
      assert.match(markdown, /Left out to stay under GitHub's size limit: .*tests per file/);
      assert.match(markdown, /### Tests/);
    });

    test("the cap is under GitHub's limit of 1 MiB per step", () => {
      assert.ok(MAX_BYTES < 1024 * 1024);
    });
  });

  describe("changes since main", () => {
    const current = {
      suites: { rules: { label: "Rules", tests: 90, skipped: 1, todo: 0 } },
      coverage: { rules: { lines: 90.5 } },
      bundle: { jsRaw: 2000 },
    };

    test("a fall in test count warns, and a rise does not", () => {
      const fell = changesSince({ suites: { rules: { tests: 100, skipped: 1, todo: 0 } } }, current);
      assert.deepEqual(fell.map((row) => [row.name, row.warn, row.change]), [["Rules tests", true, "-10"]]);
      const rose = changesSince({ suites: { rules: { tests: 80, skipped: 1, todo: 0 } } }, current);
      assert.equal(rose[0].warn, false);
      assert.equal(rose[0].change, "+10");
    });

    test("more skipped tests warn", () => {
      const rows = changesSince({ suites: { rules: { tests: 90, skipped: 0, todo: 0 } } }, current);
      assert.deepEqual(rows.map((row) => [row.name, row.warn]), [["Rules skipped and todo", true]]);
    });

    test("coverage and bundle differences appear, and equal ones do not", () => {
      const rows = changesSince({ suites: {}, coverage: { rules: { lines: 90 } }, bundle: { jsRaw: 1000 } }, current);
      assert.deepEqual(rows.map((row) => [row.name, row.change]), [["Rules lines %", "+0.50"], ["JS, bytes", "+1,000"]]);
      assert.deepEqual(changesSince({ suites: {}, coverage: { rules: { lines: 90.5 } }, bundle: { jsRaw: 2000 } }, current), []);
    });

    test("a missing baseline says so", () => {
      const { markdown } = renderRules(nodeReport(root));
      assert.match(markdown, /No baseline to compare with/);
    });

    test("a baseline names its commit and shows the difference", () => {
      const baselinePath = join(root, "baseline.json");
      writeFileSync(baselinePath, JSON.stringify({ sha: "b".repeat(40), suites: { rules: { tests: 5, skipped: 0, todo: 0 } } }));
      const { markdown } = renderRules(nodeReport(root), STEPS_ALL_PASSED("rules"), { baselinePath });
      assert.ok(markdown.includes(`[bbbbbbbb](https://github.com/acme/repo/commit/${"b".repeat(40)})`));
      assert.match(markdown, /⚠️ Rules tests \| 5 \| 2 \| -3/);
    });

    test("a corrupt baseline reads as none, and text in a good one is never shown", () => {
      const baselinePath = join(root, "bad-baseline.json");
      writeFileSync(baselinePath, "not json");
      assert.match(renderRules(nodeReport(root), STEPS_ALL_PASSED("rules"), { baselinePath }).markdown, /No baseline to compare with/);
      writeFileSync(baselinePath, JSON.stringify({ sha: "<img>", suites: { rules: { tests: "<b>many</b>", skipped: 0, todo: 0 } } }));
      const { markdown } = renderRules(nodeReport(root), STEPS_ALL_PASSED("rules"), { baselinePath });
      assert.doesNotMatch(markdown, /<img>|<b>many|NaN/);
      assert.match(markdown, /an unknown commit/);
    });
  });

  describe("coverage", () => {
    const entry = (pct, total = 100) => ({ total, covered: Math.round((pct / 100) * total), skipped: 0, pct });
    const file = (pct) => ({ lines: entry(pct), statements: entry(pct), functions: entry(pct), branches: entry(pct) });

    function buildModel(thresholds) {
      const buildRoot = realpathSync(mkdtempSync(join(root, "build-")));
      const coverageDir = join(buildRoot, "app", "coverage");
      mkdirSync(coverageDir, { recursive: true });
      writeFileSync(join(buildRoot, "app", "coverage-thresholds.json"), JSON.stringify(thresholds));
      const stats = join(buildRoot, "app/src/stats.ts");
      const summary = { total: file(95), [stats]: file(95), [join(buildRoot, "app/src/export/a.ts")]: file(50) };
      writeFileSync(join(coverageDir, "coverage-summary.json"), JSON.stringify(summary));
      writeFileSync(join(coverageDir, "coverage-final.json"), JSON.stringify({
        [stats]: { statementMap: { 0: { start: { line: 4 } }, 1: { start: { line: 9 } }, 2: { start: { line: 9 } } }, s: { 0: 0, 1: 3, 2: 0 } },
      }));
      const assets = join(buildRoot, "app", "dist", "assets");
      mkdirSync(assets, { recursive: true });
      writeFileSync(join(assets, "index-abc.js"), "x".repeat(5000));
      writeFileSync(join(assets, "index-abc.js.map"), "y".repeat(90000));
      writeFileSync(join(assets, "index-abc.css"), "z".repeat(1000));
      const reportDir = mkdtempSync(join(root, "reports-"));
      writeFileSync(join(reportDir, "ci-report-app.json"), JSON.stringify({ startTime: 0, testResults: [{ name: join(buildRoot, "app/src/x.test.ts"), startTime: 0, endTime: 10, message: "", assertionResults: [{ ancestorTitles: [], title: "ok", status: "passed", duration: 1, failureMessages: [] }] }] }));
      return collect({ job: "build", root: buildRoot, reportDir, steps: STEPS_ALL_PASSED("build"), env: { ...ENV, BIKESHED_CI_COVERAGE_URL: "https://example.com/artifact" } });
    }

    test("the App's margin is read from the thresholds it is held to", () => {
      const markdown = renderSummary(buildModel({ lines: 90, branches: 99 }));
      assert.match(markdown, /lines \| 95\.00 \| 90\.00 \| \+5\.00/);
      assert.match(markdown, /❌ branches \| 95\.00 \| 99\.00 \| -4\.00/);
    });

    test("it says what the App's figure covers, from the report", () => {
      const markdown = renderSummary(buildModel({ lines: 90 }));
      assert.match(markdown, /app\/src\/export, app\/src\/stats\.ts/);
    });

    test("a line counts as covered if any statement on it ran", () => {
      const model = buildModel({ lines: 90 });
      const stats = model.suites.find((suite) => suite.id === "app").coverage.files.find((f) => f.path === "app/src/stats.ts");
      assert.deepEqual(stats.uncovered, [4]);
    });

    test("the coverage download is linked, and only over https", () => {
      assert.match(renderSummary(buildModel({ lines: 90 })), /\[download from this run\]\(https:\/\/example\.com\/artifact\)/);
    });

    test("a coverage address that is not https is not linked", () => {
      const reportDir = mkdtempSync(join(root, "reports-"));
      const model = collect({ job: "rules", root, reportDir, steps: {}, env: { ...ENV, BIKESHED_CI_COVERAGE_URL: "javascript:alert(1)" } });
      assert.equal(model.coverageUrl, null);
    });

    test("the bundle leaves out source maps and totals what it lists", () => {
      const model = buildModel({ lines: 90 });
      assert.deepEqual(model.bundle.files.map((asset) => asset.name), ["index-abc.js", "index-abc.css"]);
      assert.equal(model.bundle.totals.jsRaw, 5000);
      assert.match(renderSummary(model), /### Bundle/);
      assert.deepEqual(model.snapshot.coverage.app.lines, 95);
    });

    test("a suite that measured no files shows no figure, least of all 100%", () => {
      const coverage = { kind: "coverage", totals: { totalLineCount: 0, coveredLineCount: 0, coveredLinePercent: 100, totalBranchCount: 0, coveredBranchCount: 0, coveredBranchPercent: 100, totalFunctionCount: 0, coveredFunctionCount: 0, coveredFunctionPercent: 100 }, files: [] };
      const { model, markdown } = renderRules(nodeReport(root, { coverage }));
      assert.match(markdown, /⚠️ measured no files/);
      assert.doesNotMatch(markdown, /100\.00/);
      assert.deepEqual(model.snapshot.coverage, {});
    });

    test("the copies of a module imported under query strings become one row", () => {
      const copy = (coveredLines, uncovered, branches) => ({
        path: join(root, "cli/src/config.mjs"), totalLineCount: 10, coveredLineCount: coveredLines, coveredLinePercent: coveredLines * 10,
        totalBranchCount: 4, coveredBranchCount: branches, coveredBranchPercent: branches * 25,
        totalFunctionCount: 2, coveredFunctionCount: 1, coveredFunctionPercent: 50, uncovered,
      });
      const other = { ...copy(10, [], 4), path: join(root, "cli/src/other.mjs") };
      const totals = { totalLineCount: 30, coveredLineCount: 26, coveredLinePercent: 86.67, totalBranchCount: 12, coveredBranchCount: 9, coveredBranchPercent: 75, totalFunctionCount: 6, coveredFunctionCount: 4, coveredFunctionPercent: 66.67 };
      const report = parseNodeReport(jsonl({ kind: "coverage", totals, files: [copy(8, [1, 2], 1), copy(8, [2, 3], 3), other] }, { kind: "total", file: null, counts: COUNTS, durationMs: 1 }), root);
      assert.deepEqual(report.coverage.files.map((file) => file.path), ["cli/src/config.mjs", "cli/src/other.mjs"]);
      const [merged] = report.coverage.files;
      assert.deepEqual(merged.uncovered, [2], "a line counts as run if either copy ran it");
      assert.deepEqual([merged.lines.covered, merged.lines.total, merged.lines.pct], [9, 10, 90]);
      assert.equal(merged.branches.covered, 3, "the best copy");
      assert.deepEqual([report.coverage.totals.lines.covered, report.coverage.totals.lines.total, report.coverage.totals.lines.pct], [19, 20, 95]);
    });

    test("the percentages match Vitest's own, not a recalculation", () => {
      const parsed = parseVitestCoverage({ total: file(93.3) }, null, root);
      assert.equal(parsed.totals.statements.pct, 93.3);
    });
  });

  describe("parsing Vitest's report", () => {
    test("counts each status, and a file-level failure becomes a failure of its own", () => {
      const report = parseVitestReport({
        startTime: 100,
        testResults: [
          { name: join(root, "a.test.ts"), startTime: 100, endTime: 150, message: "", assertionResults: [
            { ancestorTitles: ["group"], title: "ok", status: "passed", duration: 3, failureMessages: [], location: { line: 7 } },
            { ancestorTitles: [], title: "bad", status: "failed", duration: 1, failureMessages: ["AssertionError: nope"] },
            { ancestorTitles: [], title: "off", status: "skipped", duration: null, failureMessages: [] },
            { ancestorTitles: [], title: "soon", status: "todo", duration: null, failureMessages: [] },
          ] },
          { name: join(root, "b.test.ts"), startTime: 110, endTime: 300, message: "Failed to load url ./gone", assertionResults: [] },
        ],
      }, root);
      assert.deepEqual(report.counts, { tests: 4, passed: 1, failed: 1, cancelled: 0, skipped: 1, todo: 1 });
      assert.equal(report.durationMs, 200);
      assert.deepEqual(report.files.map((file) => [file.file, file.tests]), [["a.test.ts", 4], ["b.test.ts", 0]]);
      assert.deepEqual(report.cases.find((entry) => entry.status === "pass").path, ["group", "ok"]);
      assert.equal(report.cases.find((entry) => entry.status === "pass").line, 7);
      assert.ok(report.cases.some((entry) => entry.wholeFile && entry.message.includes("Failed to load")));
    });
  });

  describe("parsing a node:test report", () => {
    test("with no closing total, it is marked as cut short and counted from its cases", () => {
      const report = parseNodeReport(jsonl({ kind: "case", type: "test", file: join(root, "a.test.mjs"), path: ["ok"], status: "pass" }), root);
      assert.equal(report.complete, false);
      assert.equal(report.counts.tests, 1);
    });

    test("a line cut off by a crash is dropped, not fatal", () => {
      const report = parseNodeReport(`${nodeReport(root)}\n{"kind":"ca`, root);
      assert.equal(report.complete, true);
    });
  });

  describe("formatting", () => {
    test("durations read at any size", () => {
      assert.deepEqual([duration(12.4), duration(1500), duration(260_000), duration(null)], ["12 ms", "1.5 s", "4m 20s", "—"]);
    });

    test("uncovered lines become ranges, capped", () => {
      assert.equal(ranges([7, 1, 2, 3]), "1-3, 7");
      assert.match(ranges(Array.from({ length: 40 }, (_, index) => index * 2)), /and 28 more$/);
    });

    test("a suite's scope is read to the depth it asks for", () => {
      const files = [{ path: "functions/src/a.ts" }, { path: "functions/src/email/b.ts" }];
      assert.deepEqual(scopeOf(files), ["functions/src"]);
      assert.deepEqual(scopeOf(files, 3), ["functions/src/a.ts", "functions/src/email"]);
    });
  });

  describe("held to the workflow", () => {
    const workflow = readFileSync(join(REPO, ".github", "workflows", "ci.yml"), "utf8");

    /** The steps of one job in ci.yml. Enough YAML for a file this repository writes. */
    function stepsOf(job) {
      const lines = workflow.split("\n");
      const start = lines.indexOf(`  ${job}:`);
      assert.notEqual(start, -1, `no job ${job}`);
      const rest = lines.slice(start + 1);
      const end = rest.findIndex((line) => /^ {2}\S/.test(line));
      const body = (end === -1 ? rest : rest.slice(0, end)).join("\n");
      return body.split(/\n {6}- /).slice(1).map((step) => ({
        text: step,
        id: step.match(/^\s*id: (\S+)$/m)?.[1] ?? null,
        name: step.match(/^(?:\s*)name: (.+)$/m)?.[1] ?? null,
        runs: /^\s*run: /m.test(step),
      }));
    }

    for (const [job, config] of Object.entries(JOBS)) {
      test(`every command in the ${job} job is reported under its own name`, () => {
        const steps = stepsOf(config.workflowJob);
        const reporting = steps.filter((step) => step.runs && !step.text.includes("tools/ci-summary.mjs"));
        assert.ok(reporting.length > 0);
        for (const step of reporting) {
          assert.ok(step.id, `"${step.name}" runs a command but has no id, so the summary cannot report it`);
          assert.equal(config.steps[step.id], step.name, `step ${step.id}`);
        }
        const ids = new Set(steps.map((step) => step.id));
        for (const id of Object.keys(config.steps)) assert.ok(ids.has(id), `${id} is not a step in ci.yml`);
      });

      test(`the ${job} job's suites write the reports the summary reads`, () => {
        const steps = stepsOf(config.workflowJob);
        for (const suite of config.suites) {
          const step = steps.find((candidate) => candidate.id === suite.step);
          assert.ok(step, suite.step);
          if (suite.vitest) {
            assert.match(step.text, /BIKESHED_CI_REPORT_DIR: \$\{\{ runner\.temp \}\}/);
          } else {
            assert.ok(step.text.includes(`--test-reporter-destination=\${{ runner.temp }}/${suite.report}`), suite.id);
            assert.ok(step.text.includes("tools/ci-test-reporter.mjs"), suite.id);
            // The spec reporter stays, or the log goes silent.
            assert.ok(step.text.includes("--test-reporter=spec --test-reporter-destination=stdout"), suite.id);
          }
        }
      });

      test(`the ${job} job's report cannot fail the job, and a red run cannot become the baseline`, () => {
        const steps = stepsOf(config.workflowJob);
        const summary = steps.find((step) => step.text.includes("tools/ci-summary.mjs"));
        assert.match(summary.text, /continue-on-error: true/);
        assert.match(summary.text, /!cancelled\(\)/);
        const save = steps.find((step) => step.text.includes("actions/cache/save"));
        assert.match(save.text, /continue-on-error: true/);
        assert.match(save.text, /success\(\) && github\.ref == 'refs\/heads\/main'/);
        const restore = steps.find((step) => step.text.includes("actions/cache/restore"));
        assert.match(restore.text, /continue-on-error: true/);
      });
    }

    test("the App's thresholds are the file the summary reads, not a second copy", () => {
      const config = readFileSync(join(REPO, "app", "vite.config.ts"), "utf8");
      assert.match(config, /coverage-thresholds\.json/);
      assert.doesNotMatch(config, /thresholds:\s*\{/);
      const thresholds = JSON.parse(readFileSync(join(REPO, "app", "coverage-thresholds.json"), "utf8"));
      assert.deepEqual(Object.keys(thresholds).sort(), ["branches", "functions", "lines", "statements"]);
    });

    test("the workflow's token stays read-only", () => {
      assert.match(workflow, /^permissions:\n {2}contents: read\n/m);
      assert.doesNotMatch(workflow, /^\s+\w[\w-]*: write$/m);
    });
  });
});
