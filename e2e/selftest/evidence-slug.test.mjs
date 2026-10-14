// SPDX-License-Identifier: Apache-2.0
// Self-test: a case named with an ordinary word like null or undefined keeps its evidence: slugify, Evidence and node --test (SPEC §12).

/**
 * lib/paths.mjs assertPath refuses a path with an `undefined` or `null`
 * segment, or either word beside a dash: the trace of a template literal
 * built from a missing value. A case name is prose, though, and a18-stats'
 * "… uid and email null …" slugged to "…-email-null-…", which assertPath
 * refused AFTER Evidence had made the directory. The timed-out case kept two
 * empty directories and no evidence (invocation 20261011T120131Z). So:
 *   - slugify breaks either word before its last letter ("nul-l",
 *     "undefine-d"), wherever it stands, before the cut to 80 characters;
 *   - every other name slugs exactly as before (pinned against the old
 *     function, over every case name in e2e/specs and a seeded fuzz);
 *   - Evidence checks a directory before it makes one, so a refusal leaves
 *     nothing behind;
 *   - through node --test and the reporter, a failing, an INCONCLUSIVE and a
 *     known-defect case so named each report an evidence directory that holds
 *     their steps and error.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { Evidence, slugify } from "../lib/evidence.mjs";
import { createInvocation, nodeTestArgs } from "../lib/invocation.mjs";
import { E2E_DIR, OUT_DIR, REPO_ROOT, SPECS_DIR, assertPath, ensureDir } from "../lib/paths.mjs";

const runId = `selftest-evslug-${process.pid}`;
let runDir;

before(() => {
  runDir = ensureDir(join(OUT_DIR, runId), "selftest run dir");
});

after(() => {
  rmSync(runDir, { recursive: true, force: true });
});

/** slugify as it was before it broke the two words: the reference every other name must still match byte for byte. */
function slugifyBefore(name) {
  return String(name)
    .normalize("NFKD")
    .replace(/[^\w\s=.-]/g, " ")
    .replace(/[=.]/g, "-")
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80) || "test";
}

/** Every case name declared with a string literal in e2e/specs. */
function specCaseNames() {
  const names = [];
  const walk = (dir) => {
    for (const f of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, f.name);
      if (f.isDirectory()) walk(p);
      else if (f.name.endsWith(".spec.mjs")) {
        for (const m of readFileSync(p, "utf8").matchAll(/scenario\(\s*("(?:[^"\\\n]|\\.)*")/g)) {
          try {
            names.push(JSON.parse(m[1]));
          } catch {
            /* an escape JSON does not share with JavaScript (\' or \x41): that name is left out */
          }
        }
      }
    }
  };
  walk(SPECS_DIR);
  return names;
}

/** A small seeded generator (mulberry32), so a failing fuzz case is the same on every run. */
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The words, in the spellings and positions a case name can hold them. */
const WORDS = ["null", "NULL", "Null", "undefined", "Undefined", "nullable", "non-null", "isNull", "null_value", "null.value", "null=1", "nullnull", "annulled", "undefinedness", "ｎｕｌｌ" /* fullwidth n-u-l-l, which NFKD makes ASCII */];
const OTHER = ["A18.2", "anonymous", "readers", "uid", "and", "email", "views", "(x)", "{uid}", "—", "banana", "maintenance", "NaN", "[object Object]", "café", "x".repeat(70), "-", "_", "  ", "v1", "#2", "[N=5]"];

function fuzzNames(count, vocabulary, seed) {
  const rnd = seeded(seed);
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const n = 1 + Math.floor(rnd() * 9);
    out.push(Array.from({ length: n }, () => vocabulary[Math.floor(rnd() * vocabulary.length)]).join(rnd() < 0.8 ? " " : ""));
  }
  return out;
}

/** The names that hold a word: alone, first, inside, last, and straddling the cut at 80 characters. */
function wordNames() {
  const names = [];
  for (const w of WORDS) {
    names.push(w, `${w} at the start`, `uid and email ${w}, views counted`, `ends with ${w}`, `${w}-${w}`, `${w}${w}`);
    for (let pad = 60; pad <= 86; pad += 1) names.push(`${"x".repeat(pad)} ${w} tail`, `${"y ".repeat(pad >> 1)}${w}`);
  }
  return [...names, ...fuzzNames(3000, [...WORDS, ...OTHER], 0x5eed18)];
}

const BASE = join(OUT_DIR, "selftest-slug-base", "evidence");

test("slugify: a name holding null or undefined anywhere slugs to a directory assertPath accepts, the first and the -k one", () => {
  const names = wordNames();
  assert.ok(names.length > 3000);
  for (const name of names) {
    const s = slugify(name);
    assert.match(s, /^[a-z0-9-]{1,80}$/, `charset and length: ${JSON.stringify(name)} → ${s}`);
    assert.doesNotMatch(s, /null|undefined/, `${JSON.stringify(name)} → ${s}`);
    assert.doesNotThrow(() => assertPath(join(BASE, s), "evidence dir"), `${JSON.stringify(name)} → ${s}`);
    assert.doesNotThrow(() => assertPath(join(BASE, `${s}-2`), "evidence dir"), `${JSON.stringify(name)} → ${s}-2`);
  }
  assert.equal(slugify("A18.2 anonymous readers: uid and email null, views counted"), "a18-2-anonymous-readers-uid-and-email-nul-l-views-counted");
  assert.equal(slugify("undefined"), "undefine-d");
  assert.equal(slugify("a non-null, nullable field"), "a-non-nul-l-nul-lable-field");
  assert.equal(slugify("NULL"), "nul-l");
  assert.equal(slugify(`${"x".repeat(76)} null`), `${"x".repeat(76)}-nul`, "broken before the cut: the cut cannot leave the word whole at the end");
});

test("slugify: every other name slugs exactly as before: every case name in e2e/specs and a seeded fuzz", () => {
  const corpus = [...specCaseNames(), ...fuzzNames(5000, OTHER, 0xc0ffee)];
  let compared = 0;
  for (const name of corpus) {
    const was = slugifyBefore(name);
    if (/null|undefined/.test(was)) continue; // those differ by design (the test above)
    compared += 1;
    assert.equal(slugify(name), was, JSON.stringify(name));
  }
  assert.ok(compared > 5000, `compared ${compared} names`);
  assert.ok(specCaseNames().length > 100, "the spec corpus was read");
});

test("Evidence: a18's case name gets its directory with steps, error and a user named null; the same name again gets -2", async () => {
  const name = "A18.2 anonymous readers are counted, never identified: uid and email null, views and totalMs counted on an unlisted link (browser) and a public page (HTTP), no viewers/{uid}";
  const ev = new Evidence({ runDir, slug: name, name, always: true });
  ev.step("read the view record");
  const user = { name: "null", closed: true, log: { console: [{ t: 1, type: "log", text: "hello" }], errors: [], toasts: [], breaches: [], external: [], websockets: [], requests: [] } };
  await ev.captureUser(user);
  const dir = ev.flush({ error: new Error("uid was set") });
  assert.equal(dir, join(runDir, "evidence", slugify(name)));
  assert.match(basename(dir), /-email-nul-l-views-/);
  assert.equal(assertPath(dir), dir);
  assert.match(readFileSync(join(dir, "steps.md"), "utf8"), /^# A18\.2 .*uid and email null, views/m, "the title keeps the name as written");
  assert.match(readFileSync(join(dir, "steps.md"), "utf8"), /read the view record/);
  assert.match(readFileSync(join(dir, "error.txt"), "utf8"), /uid was set/);
  assert.ok(existsSync(join(dir, "console-nul-l.jsonl")), readdirSync(dir).join(", "));

  const again = new Evidence({ runDir, slug: name, name, always: true });
  assert.equal(again.flush(), `${dir}-2`);
});

test("NEGATIVE: Evidence checks a directory before it makes it: a refused one throws and leaves nothing behind", () => {
  const ev = new Evidence({ runDir, slug: "placeholder", always: true });
  ev.slug = "case-null"; // a slug that did not come from slugify
  assert.throws(() => ev.ensureDir(), /evidence dir: contains a "null" segment/);
  assert.equal(existsSync(join(runDir, "evidence", "case-null")), false, "no empty directory is left behind");
  assert.equal(ev.dir, null);
});

// --- Through node --test and the reporter --------------------------------------

const FIXTURE = `// fixture spec, generated by selftest/evidence-slug.test.mjs
import assert from "node:assert/strict";
import { scenario } from ${JSON.stringify(pathToFileURL(join(E2E_DIR, "lib", "test.mjs")).href)};
scenario("A18.2 anonymous readers: uid and email null, views counted", {}, async (ctx) => { ctx.step("step of the null case"); assert.fail("uid was set"); });
scenario("A20.2 list_documents pages by nextCursor to a null cursor", {}, async (ctx) => { ctx.step("step of the cursor case"); throw new Error("the cursor never ran out"); });
scenario("undefined behaviour stays undefined", {}, async (ctx) => { ctx.step("step of the undefined case"); ctx.inconclusive("no overlap"); });
scenario("a non-null, nullable field", { defect: "S9" }, async (ctx) => { ctx.step("step of the defect case"); assert.fail("still broken"); });
scenario("plain words pass", {}, async () => {});
`;

function runAsync(cmd, args, { env, cwd, timeout }) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
    }, timeout);
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

test("through node --test and the reporter: failing, INCONCLUSIVE and known-defect cases named with the words each report their evidence", async () => {
  const fixtureDir = ensureDir(join(runDir, "fixture"), "fixture dir");
  const targetFile = join(fixtureDir, "target.json");
  // Nothing in the fixture sends a request: the port is never reached.
  writeFileSync(targetFile, JSON.stringify({ kind: "local", runId, runDir, origin: "http://127.0.0.1:1", projectId: "demo-bikeshed", capabilities: ["local"], stack: { ports: { hosting: 1 } } }));
  const spec = join(fixtureDir, "fixture.spec.mjs");
  writeFileSync(spec, FIXTURE);
  const inv = createInvocation(runDir, { runId, suite: "functional", plan: [{ tier: "functional", files: [spec] }], grep: null, n: null });
  const env = { ...process.env, E2E_TARGET: targetFile, E2E_RUN_ID: runId, E2E_SUITE: "functional", E2E_INVOCATION_DIR: inv.dir };
  delete env.NODE_TEST_CONTEXT; // a nested node --test that inherits it streams to its parent and ignores reporters
  delete env.E2E_N;
  delete env.E2E_EVIDENCE;
  const proc = await runAsync(process.execPath, nodeTestArgs({ files: [spec], resultsFile: join(inv.dir, "results-functional.jsonl"), reporter: join(E2E_DIR, "lib", "reporter.mjs") }), { cwd: REPO_ROOT, timeout: 90_000, env });
  assert.notEqual(proc.status, null, `node --test hung and was killed (stdout tail: ${proc.stdout.slice(-800)})`);
  assert.doesNotMatch(proc.stdout, /evidence capture failed/, "no case lost its evidence");
  const records = readFileSync(join(inv.dir, "results-functional.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((r) => r.file === relative(REPO_ROOT, spec)); // a file inside the checkout is recorded relative to it (reporter.mjs relFile)
  const by = Object.fromEntries(records.map((r) => [r.name, r]));
  assert.equal(records.length, 5, records.map((r) => r.name).join(" | "));

  const cases = [
    ["A18.2 anonymous readers: uid and email null, views counted", "fail", "step of the null case", /uid was set/],
    ["A20.2 list_documents pages by nextCursor to a null cursor", "fail", "step of the cursor case", /the cursor never ran out/],
    ["undefined behaviour stays undefined", "inconclusive", "step of the undefined case", /INCONCLUSIVE: no overlap/],
    ["a non-null, nullable field", "todo", "step of the defect case", /still broken/],
  ];
  for (const [name, status, step, error] of cases) {
    const r = by[name];
    assert.equal(r?.status, status, name);
    assert.ok(r.evidenceDir, `${name}: the record names its evidence directory`);
    const dir = join(REPO_ROOT, r.evidenceDir);
    assert.equal(basename(dir), slugify(name), name);
    assert.equal(assertPath(dir), dir);
    assert.match(readFileSync(join(dir, "steps.md"), "utf8"), new RegExp(step), `${name}: steps.md`);
    assert.match(readFileSync(join(dir, "error.txt"), "utf8"), error, `${name}: error.txt`);
  }
  assert.equal(by["plain words pass"]?.status, "pass");
  assert.equal(by["plain words pass"].evidenceDir, null, "a passing case still writes nothing");
  const left = readdirSync(join(inv.dir, "evidence"));
  assert.deepEqual(left.sort(), cases.map(([n]) => slugify(n)).sort(), "one directory per case that needed one, and no empty strays");
});
