// SPDX-License-Identifier: Apache-2.0
// Self-test: a spec file's time budget is its declared E2E_FILE_TIMEOUT_MS or the sum of its cases' own timeouts, read from the source without running it (SPEC §12).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { SPECS_DIR } from "../lib/paths.mjs";
import { CEILING_FACTOR, blankSource, caseTimeoutDefault, declaredFileTimeout, evalInteger, fileBudget, scanScenarios, tierTimeouts, topLevelIntegers } from "../lib/budget.mjs";

const DEFAULT = 600_000;

/** a13-sharing's shape: ten top-level cases, 1,530 s of declared timeouts. */
const A13_LIKE = [180, 120, 180, 150, 150, 150, 180, 150, 120, 150]
  .map((s, i) => `scenario("A13.${i} the ${i}th case, with a comma, and {braces}", {\n  tiers: ["local", "prod"],\n  effects: ["email:POST /access"],\n  timeoutMs: ${s}_000,\n}, async (ctx) => {\n  await ctx.step("x");\n});\n`)
  .join("\n");

test("blankSource keeps length and lines, blanks comments, strings, templates and regexes, and keeps template expressions as code", () => {
  const src = [
    "// scenario(\"in a line comment\", { timeoutMs: 1 })",
    "/* scenario('in a block', {timeoutMs: 2}) */",
    "const s = \"scenario('in a string', {timeoutMs: 3})\";",
    "const r = /[\"{]scenario\\(/g; const q = '}';",
    "const t = `scenario(${f({ a: 1 })}, {timeoutMs: 4})`;",
    "const d = a / b / c;",
    "const q2 = x.split(/'/); const kept = 1;",
  ].join("\n");
  const b = blankSource(src);
  assert.equal(b.length, src.length);
  assert.equal(b.split("\n").length, src.split("\n").length);
  assert.ok(!/scenario/.test(b), `no scenario( survives outside code: ${JSON.stringify(b)}`);
  assert.match(b, /f\(\{ a: 1 \}\)/, "a template's ${…} expression stays code");
  assert.match(b, /const d = a \/ b \/ c;/, "division is not a regular expression");
  assert.match(b, /\/ \/\); const kept = 1;$/, "a quote inside a regular expression opens no string");
  const opens = [...b].filter((c) => c === "{").length;
  const closes = [...b].filter((c) => c === "}").length;
  assert.equal(opens, closes, "braces in strings, regexes and template text are gone; code braces balance");
});

test("evalInteger and topLevelIntegers: literals with underscores, constants, products; anything else is null", () => {
  const consts = topLevelIntegers("const CASE_MS = 240_000;\nexport const LONG_MS = 2 * CASE_MS;\n  const INDENTED = 5;\nconst S = \"9\";\n");
  assert.deepEqual([...consts], [["CASE_MS", 240_000], ["LONG_MS", 480_000]]);
  assert.equal(evalInteger("120_000"), 120_000);
  assert.equal(evalInteger("3 * 60_000"), 180_000);
  assert.equal(evalInteger("LONG_MS", consts), 480_000);
  for (const bad of ["", "1e3", "0x10", "1_", "1__0", "CASE_MS + 1", "f()", "UNKNOWN", "1.5"]) assert.equal(evalInteger(bad, consts), null, bad);
});

test("scanScenarios: a13's shape sums to 1,530 s, one case per top-level call", () => {
  const s = scanScenarios(A13_LIKE, { caseDefaultMs: DEFAULT });
  assert.deepEqual([s.cases, s.sumMs, s.unresolved], [10, 1_530_000, []]);
  assert.deepEqual(s.calls.map((c) => c.timeoutMs), [180, 120, 180, 150, 150, 150, 180, 150, 120, 150].map((x) => x * 1000));
});

test("scanScenarios reads constants, n, trials and the no-options form, and says what it cannot read", () => {
  const src = `import { scenario } from "../../lib/test.mjs";
const CASE_MS = 240_000;
const LONG_MS = 2 * CASE_MS;
// scenario("a comment", { timeoutMs: 999_999 }, async () => {});
const note = "scenario(\\"a string\\", { timeoutMs: 999_999 })";
function scenario(n, o, f) {}
x.scenario("a member call", { timeoutMs: 999_999 });
scenario("constant", { timeoutMs: CASE_MS }, async () => {});
scenario(\`template \${name({ a: 1 })}\`, { tiers: ["local"], timeoutMs: LONG_MS /* two cases' worth */ }, async () => {});
scenario("n and trials", { n: [2, 5, 10], trials: 2, timeoutMs: 1_000 }, async () => {});
scenario("trials per N", {
  n: [2, 5], // a comment between properties
  trials: { 2: 3, default: 1 },
  timeoutMs: 1_000,
}, async () => {});
scenario("no options", async (ctx) => {});
scenario("no timeout", { tiers: ["local"] }, async () => {});
scenario("regex inside", { tiers: ["local"], timeoutMs: 7_000 }, async () => { const r = /["{]/; });
for (const name of names) {
  scenario(name, { timeoutMs: 5_000 }, async () => {});
}
scenario("options from elsewhere", OPTIONS, async () => {});
scenario("spread", { ...(d ? { defect: d } : {}) }, async () => {});
scenario("expression", { timeoutMs: CASE_MS + 1 }, async () => {});
`;
  const s = scanScenarios(src, { caseDefaultMs: DEFAULT });
  const by = s.calls.map((c) => [c.line, c.cases, c.timeoutMs, c.resolved]);
  assert.deepEqual(by, [
    [8, 1, 240_000, true],
    [9, 1, 480_000, true],
    [10, 6, 1_000, true],
    [11, 4, 1_000, true],
    [16, 1, null, true],
    [17, 1, null, true],
    [18, 1, 7_000, true],
    [20, 1, 5_000, false],
    [22, 1, null, false],
    [23, 1, null, false],
    [24, 1, null, false],
  ]);
  assert.equal(s.cases, 19);
  assert.equal(s.sumMs, 240_000 + 480_000 + 6_000 + 4_000 + DEFAULT + DEFAULT + 7_000 + 5_000 + 3 * DEFAULT);
  assert.deepEqual(s.unresolved.map((u) => u.line), [20, 22, 23, 24]);
  assert.match(s.unresolved[0].why, /not at the top level/);
  assert.match(s.unresolved[1].why, /not an object literal/);
  assert.match(s.unresolved[2].why, /spread/);
  assert.match(s.unresolved[3].why, /CASE_MS \+ 1/);
});

test("declaredFileTimeout: a top-level integer declaration; twice, unreadable, zero or unterminated throws E2E_FILE_TIMEOUT; a comment or an indented one is none", () => {
  assert.equal(declaredFileTimeout("scenario('x', {}, () => {});\n"), null);
  assert.equal(declaredFileTimeout("export const E2E_FILE_TIMEOUT_MS = 1_800_000;\n"), 1_800_000);
  assert.equal(declaredFileTimeout("const MIN = 60_000;\nconst E2E_FILE_TIMEOUT_MS = 25 * MIN; // half an hour, nearly\n"), 1_500_000);
  assert.equal(declaredFileTimeout("// export const E2E_FILE_TIMEOUT_MS = 5;\nfunction f() {\n  const E2E_FILE_TIMEOUT_MS = 5;\n}\n"), null);
  for (const [src, why] of [
    ["const E2E_FILE_TIMEOUT_MS = 1;\nconst E2E_FILE_TIMEOUT_MS = 2;\n", /declared 2 times \(lines 1, 2\)/],
    ["const E2E_FILE_TIMEOUT_MS = process.env.X;\n", /"process\.env\.X" is not a positive integer/],
    ["const E2E_FILE_TIMEOUT_MS = 0;\n", /not a positive integer/],
    ["const E2E_FILE_TIMEOUT_MS = 1_000\n", /not a positive integer/],
  ]) {
    assert.throws(() => declaredFileTimeout(src), (e) => e.code === "E2E_FILE_TIMEOUT" && why.test(e.message), src);
  }
});

test("fileBudget: a declared budget wins, even above the ceiling; a computed one is capped at the ceiling", () => {
  const ceiling = DEFAULT * CEILING_FACTOR;
  const declared = fileBudget("declared.spec.mjs", { caseDefaultMs: DEFAULT, source: `export const E2E_FILE_TIMEOUT_MS = ${ceiling + 1};\n${A13_LIKE}` });
  assert.deepEqual([declared.declaredMs, declared.sumMs, declared.budgetMs], [ceiling + 1, 1_530_000, ceiling + 1]);
  const many = Array.from({ length: 8 }, (_, i) => `scenario("c${i}", { timeoutMs: ${DEFAULT} }, async () => {});`).join("\n");
  const capped = fileBudget("many.spec.mjs", { caseDefaultMs: DEFAULT, source: many });
  assert.deepEqual([capped.declaredMs, capped.sumMs, capped.computedMs, capped.budgetMs], [null, 8 * DEFAULT, ceiling, ceiling]);
  assert.throws(() => fileBudget("bad.spec.mjs", { caseDefaultMs: DEFAULT, source: "const E2E_FILE_TIMEOUT_MS = x;\n" }), (e) => e.code === "E2E_FILE_TIMEOUT" && /^bad\.spec\.mjs: /.test(e.message), "the error names the file");
});

test("tierTimeouts: the largest file budget, never below the default; cases without their own keep the default; --timeout is both", () => {
  const sources = {
    "a13.spec.mjs": A13_LIKE,
    "short.spec.mjs": `scenario("one", { timeoutMs: 60_000 }, async () => {});\n`,
    "none.spec.mjs": "// no scenarios here\n",
  };
  const read = (f) => sources[f];
  const both = tierTimeouts(["short.spec.mjs", "a13.spec.mjs", "none.spec.mjs"], { defaultMs: DEFAULT, read });
  assert.deepEqual([both.fileTimeoutMs, both.caseTimeoutMs, both.explicit, both.driver], [1_530_000, DEFAULT, false, "a13.spec.mjs"]);
  assert.deepEqual(both.files.map((f) => [f.file, f.budgetMs]), [["short.spec.mjs", 60_000], ["a13.spec.mjs", 1_530_000], ["none.spec.mjs", 0]]);
  const small = tierTimeouts(["short.spec.mjs", "none.spec.mjs"], { defaultMs: DEFAULT, read });
  assert.deepEqual([small.fileTimeoutMs, small.driver], [DEFAULT, null], "a budget below the default never lowers it");
  const explicit = tierTimeouts(["a13.spec.mjs"], { defaultMs: DEFAULT, explicitMs: 90_000, read: () => assert.fail("--timeout reads no file") });
  assert.deepEqual(explicit, { fileTimeoutMs: 90_000, caseTimeoutMs: 90_000, explicit: true, driver: null, files: [] });
  assert.throws(() => tierTimeouts([], { defaultMs: DEFAULT, explicitMs: 0 }), /positive integer/);
  assert.throws(() => tierTimeouts([], { defaultMs: 0 }), /defaultMs/);
});

test("caseTimeoutDefault: a positive integer from E2E_CASE_TIMEOUT_MS, else null", () => {
  assert.equal(caseTimeoutDefault({}), null);
  assert.equal(caseTimeoutDefault({ E2E_CASE_TIMEOUT_MS: "600000" }), 600_000);
  for (const bad of ["", "0", "-5", "1.5", "ten", "1e999"]) assert.equal(caseTimeoutDefault({ E2E_CASE_TIMEOUT_MS: bad }), null, bad);
});

test("every committed spec scans without throwing, and every functional spec that declares a scenario is seen to", () => {
  for (const tier of readdirSync(SPECS_DIR)) {
    for (const name of readdirSync(join(SPECS_DIR, tier)).filter((n) => n.endsWith(".spec.mjs"))) {
      const file = join(SPECS_DIR, tier, name);
      const b = fileBudget(file, { caseDefaultMs: DEFAULT });
      assert.ok(b.budgetMs >= 0, file);
      if (tier === "functional") assert.ok(b.cases > 0, `${tier}/${name}: no scenario() call found`);
    }
  }
});
