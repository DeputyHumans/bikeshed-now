// SPDX-License-Identifier: Apache-2.0
// Tests the job summary's node:test reporter against real runs of node --test (SPEC §12).

import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { failuresOf, parseNodeReport } from "./ci-summary.mjs";

const REPORTER = join(dirname(fileURLToPath(import.meta.url)), "ci-test-reporter.mjs");

const MIXED = `
import { after, before, describe, it, test } from "node:test";
import assert from "node:assert";
describe("outer", () => {
  describe("inner", () => {
    it("passes", () => {});
    it("fails here", () => assert.equal(1, 2));
    it("skips", { skip: "not on this platform" }, () => {});
    it.todo("later");
    it("is a todo that throws", { todo: true }, () => { throw new Error("known"); });
  });
});
test("parent", async (t) => {
  await t.test("child fails", () => assert.equal("a", "b"));
});
describe("hooked", () => {
  before(() => { throw new Error("hook boom"); });
  it("never runs", () => {});
});
`;

const COVERED = `
export const used = () => 1;
export function unused() {
  return 2;
}
`;

const WORKFLOW = readFileSync(join(dirname(REPORTER), "..", ".github", "workflows", "ci.yml"), "utf8");

/** The coverage flags a step in ci.yml passes, so the test holds the real ones. */
function coverageFlags(report) {
  const step = WORKFLOW.slice(WORKFLOW.indexOf(report));
  return step.slice(0, step.indexOf("\n        run:")).split(/\s+/).filter((flag) => /^--(experimental-test-coverage|enable-source-maps|test-coverage-)/.test(flag));
}

function run(dir, files, flags = []) {
  const output = join(dir, "report.jsonl");
  const result = spawnSync(
    process.execPath,
    ["--test", ...flags, `--test-reporter=${REPORTER}`, `--test-reporter-destination=${output}`, ...files],
    { cwd: dir, encoding: "utf8", env: { ...process.env, NODE_TEST_CONTEXT: undefined } },
  );
  return { status: result.status, report: parseNodeReport(readFileSync(output, "utf8"), dir) };
}

describe("the CI test reporter", () => {
  let dir;

  before(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "ci-reporter-")));
    writeFileSync(join(dir, "mixed.test.mjs"), MIXED);
    writeFileSync(join(dir, "passing.test.mjs"), `import { test } from "node:test";\ntest("fine", () => {});\n`);
    writeFileSync(join(dir, "broken-import.test.mjs"), `import "./does-not-exist.mjs";\n`);
    writeFileSync(join(dir, "covered.mjs"), COVERED);
    writeFileSync(join(dir, "covering.test.mjs"), `import { test } from "node:test";\nimport { used } from "./covered.mjs";\ntest("uses", () => used());\n`);
  });

  after(() => rmSync(dir, { recursive: true, force: true }));

  test("leaves the run's exit code alone, and records the failure", () => {
    const { status, report } = run(dir, ["mixed.test.mjs"]);
    assert.equal(status, 1);
    assert.equal(report.complete, true);
    assert.ok(report.cases.some((entry) => entry.status === "fail" && entry.message.includes("1 == 2")));
  });

  test("a passing run exits 0 and counts its tests", () => {
    const { status, report } = run(dir, ["passing.test.mjs"]);
    assert.equal(status, 0);
    assert.equal(report.counts.tests, 1);
    assert.equal(report.counts.passed, 1);
    assert.deepEqual(report.files.map((file) => file.file), ["passing.test.mjs"]);
  });

  test("a case knows every name above it, and its own line", () => {
    const { report } = run(dir, ["mixed.test.mjs"]);
    const failing = report.cases.find((entry) => entry.path.at(-1) === "fails here");
    assert.deepEqual(failing.path, ["outer", "inner", "fails here"]);
    assert.equal(failing.file, "mixed.test.mjs");
    assert.equal(failing.line, 7);
  });

  test("lists what failed, without the parent that failed because of it", () => {
    const { report } = run(dir, ["mixed.test.mjs"]);
    const listed = failuresOf(report).map((entry) => entry.path.at(-1)).sort();
    assert.deepEqual(listed, ["child fails", "fails here", "hooked"]);
    assert.equal(report.cases.find((entry) => entry.path.at(-1) === "never runs").status, "cancelled");
  });

  test("a hook's own failure appears, with its message", () => {
    const { report } = run(dir, ["mixed.test.mjs"]);
    const hook = failuresOf(report).find((entry) => entry.path.at(-1) === "hooked");
    assert.equal(hook.failureType, "hookFailed");
    assert.match(hook.message, /hook boom/);
  });

  test("skipped and todo tests keep their kind and reason", () => {
    const { report } = run(dir, ["mixed.test.mjs"]);
    const byName = (name) => report.cases.find((entry) => entry.path.at(-1) === name);
    assert.equal(byName("skips").status, "skip");
    assert.equal(byName("skips").reason, "not on this platform");
    assert.equal(byName("later").status, "todo");
  });

  test("a todo that throws is a todo, not a failure", () => {
    const { report } = run(dir, ["mixed.test.mjs"]);
    assert.equal(report.cases.find((entry) => entry.path.at(-1) === "is a todo that throws").status, "todo");
  });

  test("a file that cannot load is one failure, explained by its stderr", () => {
    const { status, report } = run(dir, ["broken-import.test.mjs"]);
    assert.equal(status, 1);
    const [failure] = failuresOf(report);
    assert.equal(failure.wholeFile, true);
    assert.match(failure.message, /ERR_MODULE_NOT_FOUND/);
    assert.deepEqual(report.files.map((file) => file.file), ["broken-import.test.mjs"]);
  });

  test("the Functions step's flags measure compiled code as its source", () => {
    const project = join(dir, "compiled");
    mkdirSync(join(project, "lib"), { recursive: true });
    mkdirSync(join(project, "src"));
    mkdirSync(join(project, "test"));
    const source = "export const used = () => 1;\nexport function unused() {\n  return 2;\n}\n";
    writeFileSync(join(project, "src", "covered.ts"), source);
    writeFileSync(join(project, "lib", "covered.mjs"), `${source}//# sourceMappingURL=covered.mjs.map\n`);
    writeFileSync(join(project, "lib", "covered.mjs.map"), JSON.stringify({ version: 3, file: "covered.mjs", sources: ["../src/covered.ts"], sourcesContent: [source], names: [], mappings: "AAAA;AACA;AACA;AACA" }));
    writeFileSync(join(project, "test", "covering.test.mjs"), `import { test } from "node:test";\nimport { used } from "../lib/covered.mjs";\ntest("uses", () => used());\n`);

    const flags = coverageFlags("ci-report-functions.jsonl");
    assert.ok(flags.includes("--enable-source-maps"), `read from ci.yml: ${flags}`);
    const { report } = run(project, ["test/covering.test.mjs"], flags);
    assert.deepEqual(report.coverage.files.map((file) => file.path), ["src/covered.ts"]);
    assert.ok(report.coverage.files[0].uncovered.includes(3));
  });

  test("the CLI step's flags measure its source", () => {
    const flags = coverageFlags("ci-report-cli.jsonl");
    assert.ok(flags.includes("--test-coverage-include=src/**"), `read from ci.yml: ${flags}`);
  });

  test("a module imported under query strings is one row, covered by what any copy ran", () => {
    const project = join(dir, "copies");
    mkdirSync(join(project, "src"), { recursive: true });
    writeFileSync(join(project, "src", "two.mjs"), "export function a() {\n  return 1;\n}\nexport function b() {\n  return 2;\n}\n");
    writeFileSync(join(project, "copies.test.mjs"), `import { test } from "node:test";\ntest("a", async () => (await import("./src/two.mjs?x=1")).a());\ntest("b", async () => (await import("./src/two.mjs?x=2")).b());\n`);
    const { report } = run(project, ["copies.test.mjs"], ["--experimental-test-coverage", "--test-coverage-include=src/**"]);
    assert.deepEqual(report.coverage.files.map((file) => file.path), ["src/two.mjs"]);
    assert.deepEqual(report.coverage.files[0].uncovered, []);
    assert.equal(report.coverage.totals.lines.pct, 100);
  });

  test("coverage arrives per file, with the lines nothing ran", () => {
    const { report } = run(dir, ["covering.test.mjs"], ["--experimental-test-coverage", "--test-coverage-include=covered.mjs"]);
    assert.deepEqual(report.coverage.files.map((file) => file.path), ["covered.mjs"]);
    const [file] = report.coverage.files;
    assert.ok(file.uncovered.includes(4), `line 4 is the body of unused(), got ${file.uncovered}`);
    assert.ok(file.lines.pct < 100);
    assert.equal(report.coverage.totals.lines.total, file.lines.total);
  });
});
