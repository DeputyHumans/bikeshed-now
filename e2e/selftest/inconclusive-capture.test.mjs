// SPDX-License-Identifier: Apache-2.0
// Self-test: an INCONCLUSIVE case keeps every page's console, requests, DOM and screenshot as a FAIL does, within a deadline that a page that never answers cannot carry past the case's timeout (SPEC §12).

/**
 * captureUsers against stand-in users first (who is called, who is waited
 * for, a deadline of Infinity). Then a generated fixture spec runs through
 * `node --test` with the real reporter, the way run.mjs runs one, with real
 * pages served by a local stand-in for the stack: INCONCLUSIVE by
 * ctx.inconclusive, INCONCLUSIVE by the stack's non-answer, INCONCLUSIVE with
 * a page whose DOM excerpt never answers (its domExcerpt replaced by a
 * promise that never settles: what page.evaluate does on a page whose main
 * thread is stuck), INCONCLUSIVE with no users, a FAIL and a PASS (both as
 * before). Needs Chrome.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createInvocation, nodeTestArgs } from "../lib/invocation.mjs";
import { E2E_DIR, E2E_TMP, OUT_DIR, REPO_ROOT, ensureDir } from "../lib/paths.mjs";
import { CAPTURE_RESERVE_MS, INCONCLUSIVE_CAPTURE_MS, captureUsers } from "../lib/test.mjs";

const lib = (f) => pathToFileURL(join(E2E_DIR, "lib", f)).href;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MARK = "e2e-inconclusive-capture-marker";
const runId = `selftest-inccap-${process.pid}`;
let server;
let target;
let tmp;
let runDir;

before(async () => {
  server = http.createServer((req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end("<!doctype html><title>app</title><body>app</body>");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  tmp = mkdtempSync(join(ensureDir(E2E_TMP, "E2E_TMP"), "selftest-inconclusive-capture-"));
  runDir = join(OUT_DIR, runId);
  mkdirSync(runDir, { recursive: true });
  target = { kind: "local", runId, runDir, origin: `http://127.0.0.1:${port}`, projectId: "demo-bikeshed", capabilities: ["local"], stack: { ports: { hosting: port } } };
});

after(async () => {
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
  rmSync(tmp, { recursive: true, force: true });
  rmSync(runDir, { recursive: true, force: true });
});

test("captureUsers: every user is called (its console and requests are written as it is called), the waits stop at the deadline, and Infinity is no limit", async () => {
  assert.equal(INCONCLUSIVE_CAPTURE_MS, 20_000);
  assert.equal(CAPTURE_RESERVE_MS, 15_000);
  const called = [];
  const never = new Promise(() => {});
  const ev = {
    captureUser(u) {
      called.push(u.name); // the synchronous part: what Evidence writes before its first await
      if (u.how === "quick") return sleep(10);
      if (u.how === "slow") return sleep(120);
      if (u.how === "hang") return never;
      if (u.how === "reject") return Promise.reject(new Error("redaction refused"));
      throw new Error("not a promise at all");
    },
  };
  const users = [
    { name: "a", how: "quick" },
    { name: "c", how: "reject" },
    { name: "d", how: "throw" },
    { name: "b", how: "hang" },
    { name: "e", how: "quick" }, // reached after the deadline: called, never waited for
  ];
  const t0 = Date.now();
  const r = await captureUsers(ev, users, { deadline: t0 + 300 });
  const ms = Date.now() - t0;
  assert.deepEqual(called, ["a", "c", "d", "b", "e"], "every user is called, those after the deadline too");
  assert.deepEqual(r, { captured: ["a"], late: ["b", "e"], failed: ["c", "d"] });
  assert.ok(ms >= 280 && ms < 1_000, `it waited for the hung one until the deadline, no longer (${ms} ms)`);

  const past = await captureUsers(ev, [{ name: "x", how: "hang" }], { deadline: Date.now() - 1 });
  assert.deepEqual(past, { captured: [], late: ["x"], failed: [] }, "a deadline already past: called, not waited for");
  assert.equal(called.at(-1), "x");

  const t1 = Date.now();
  const inf = await captureUsers(ev, [{ name: "s1", how: "slow" }, { name: "s2", how: "slow" }]);
  assert.deepEqual(inf, { captured: ["s1", "s2"], late: [], failed: [] }, "no deadline: each is waited for (a timer of Infinity would fire at once)");
  assert.ok(Date.now() - t1 >= 230);

  assert.deepEqual(await captureUsers(ev, []), { captured: [], late: [], failed: [] });
  await assert.rejects(captureUsers(null, []), TypeError);
  await assert.rejects(captureUsers({}, []), TypeError);
  await assert.rejects(captureUsers(ev, "a"), TypeError);
  await assert.rejects(captureUsers(ev, [], { deadline: "soon" }), TypeError);
  await assert.rejects(captureUsers(ev, [], { deadline: Number.NaN }), TypeError);
});

// --- Through node --test and the reporter --------------------------------------

const FIXTURE = `// fixture spec, generated by selftest/inconclusive-capture.test.mjs
import assert from "node:assert/strict";
import { scenario, stackCutoff } from ${JSON.stringify(lib("test.mjs"))};
const MARK = ${JSON.stringify(MARK)};
async function page(ctx, name) {
  const u = await ctx.users.user({ name });
  await u.goto("/app");
  await u.page.evaluate((m) => console.error(m + " from " + document.title), MARK);
  await u.poll(() => u.log.console.some((c) => c.text.includes(MARK)), { timeout: 10000, what: "the console line" });
  return u;
}
scenario("inconclusive, two pages", {}, async (ctx) => { await page(ctx, "alpha"); await page(ctx, "beta"); ctx.inconclusive("the race did not hold: a planted reason"); });
scenario("inconclusive, the stack did not answer", { inconclusiveOnStackTimeout: true }, async (ctx) => { await page(ctx, "gamma"); throw stackCutoff("POST /planted", 60010); });
scenario("inconclusive, a page whose DOM excerpt never answers", { timeoutMs: 30000 }, async (ctx) => { const u = await page(ctx, "stuck"); u.domExcerpt = () => new Promise(() => {}); ctx.step("planting the INCONCLUSIVE"); ctx.inconclusive("a planted reason, with a stuck page"); });
scenario("inconclusive, no users", {}, async (ctx) => { ctx.inconclusive("nothing was made"); });
scenario("fails, a page", {}, async (ctx) => { await page(ctx, "delta"); assert.fail("a planted failure"); });
scenario("passes, a page", {}, async (ctx) => { await page(ctx, "eps"); });
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

test("through node --test and the reporter: an INCONCLUSIVE keeps every page as a FAIL does; a page that never answers is not waited for past the deadline, and the case stays INCONCLUSIVE", async () => {
  const targetFile = join(tmp, "target.json");
  writeFileSync(targetFile, JSON.stringify(target));
  const spec = join(tmp, "fixture.spec.mjs");
  writeFileSync(spec, FIXTURE);
  const inv = createInvocation(runDir, { runId, suite: "functional", plan: [{ tier: "functional", files: [spec] }], grep: null, n: null });
  const env = { ...process.env, E2E_TARGET: targetFile, E2E_RUN_ID: runId, E2E_SUITE: "functional", E2E_INVOCATION_DIR: inv.dir };
  delete env.NODE_TEST_CONTEXT; // a nested node --test that inherits it streams to its parent and ignores reporters
  for (const k of ["E2E_N", "E2E_TRACE", "E2E_EVIDENCE", "E2E_CASE_TIMEOUT_MS", "E2E_TRIALS"]) delete env[k];
  // ASYNC: the fixture's pages reach this process's own server.
  const proc = await runAsync(process.execPath, nodeTestArgs({ files: [spec], resultsFile: join(inv.dir, "results-functional.jsonl"), reporter: join(E2E_DIR, "lib", "reporter.mjs") }), { cwd: REPO_ROOT, timeout: 180_000, env });
  assert.notEqual(proc.status, null, `node --test hung and was killed (stdout tail: ${proc.stdout.slice(-800)})`);
  const records = readFileSync(join(inv.dir, "results-functional.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((r) => r.file === spec);
  const by = Object.fromEntries(records.map((r) => [r.name, r]));
  assert.equal(records.length, 6, `one record per case: ${records.map((r) => `${r.name}=${r.status}`).join(" | ")}`);
  const status = (name) => [by[name]?.status, by[name]?.inconclusive ?? by[name]?.error?.message ?? null];
  const dirOf = (name) => (by[name]?.evidenceDir ? join(REPO_ROOT, by[name].evidenceDir) : null);
  const files = (name) => (dirOf(name) && existsSync(dirOf(name)) ? readdirSync(dirOf(name)).sort() : []);
  const read = (name, f) => readFileSync(join(dirOf(name), f), "utf8");

  // 1. ctx.inconclusive with two pages: both kept, whole.
  const two = "inconclusive, two pages";
  assert.deepEqual(status(two), ["inconclusive", "the race did not hold: a planted reason"]);
  for (const u of ["alpha", "beta"]) {
    for (const f of [`console-${u}.jsonl`, `requests-${u}.jsonl`, `dom-${u}.html`, `screenshot-${u}.png`]) assert.ok(files(two).includes(f), `${f} in ${files(two).join(", ")}`);
    assert.ok(read(two, `console-${u}.jsonl`).includes(`${MARK} from app`), `${u}'s console holds the page's own line`);
    assert.ok(read(two, `requests-${u}.jsonl`).includes("/app"), `${u}'s requests hold its page load`);
  }
  assert.match(read(two, "error.txt"), /^Error: INCONCLUSIVE: the race did not hold/);
  assert.ok(!read(two, "steps.md").includes("not waited for"), "both were waited for");

  // 2. The stack's non-answer (onAnsweringStack) is an INCONCLUSIVE too.
  const cut = "inconclusive, the stack did not answer";
  assert.equal(status(cut)[0], "inconclusive");
  assert.match(status(cut)[1], /^the stack did not answer, so nothing was measured: POST \/planted answered 504 after 60010 ms/);
  assert.ok(files(cut).includes("stack-did-not-answer.txt") && files(cut).includes("console-gamma.jsonl"), files(cut).join(", "));
  assert.ok(read(cut, "console-gamma.jsonl").includes(MARK));

  // 3. A page that never answers: its console kept, the rest waited for only until 15 s (CAPTURE_RESERVE_MS) before the case's 30 s timeout; still INCONCLUSIVE.
  //    Judged by the steps' own times (seconds since the case began), not by the wall clock of a loaded machine.
  const stuck = "inconclusive, a page whose DOM excerpt never answers";
  assert.deepEqual(status(stuck), ["inconclusive", "a planted reason, with a stuck page"], "NEGATIVE: an unbounded capture turns this into node:test's timeout FAIL");
  assert.ok(files(stuck).includes("console-stuck.jsonl") && files(stuck).includes("requests-stuck.jsonl"), files(stuck).join(", "));
  assert.ok(read(stuck, "console-stuck.jsonl").includes(MARK));
  assert.ok(!files(stuck).includes("dom-stuck.html"), "its DOM excerpt never came");
  const stepAt = (re) => Number(new RegExp(`^- \\+(\\d+\\.\\d+)s ${re.source}`, "m").exec(read(stuck, "steps.md"))?.[1] ?? Number.NaN);
  const planted = stepAt(/planting the INCONCLUSIVE/);
  const late = stepAt(/evidence: stuck: console and requests kept; the DOM excerpt and screenshot were not waited for/);
  const deadline = (30_000 - CAPTURE_RESERVE_MS) / 1000;
  assert.ok(Number.isFinite(planted) && Number.isFinite(late), `both steps are in steps.md (planted ${planted}, late ${late})`);
  assert.ok(late >= Math.max(planted, deadline) - 0.05, `it waited until the deadline, ${deadline} s into the case (the late step at ${late} s; planted at ${planted} s)`);
  assert.ok(late <= Math.max(planted, deadline) + 2, `and no longer: NEGATIVE, a deadline of INCONCLUSIVE_CAPTURE_MS alone would be ${planted + INCONCLUSIVE_CAPTURE_MS / 1000} s (the late step at ${late} s)`);

  // 4. No users: as before.
  const none = "inconclusive, no users";
  assert.deepEqual(status(none), ["inconclusive", "nothing was made"]);
  assert.deepEqual(files(none).filter((f) => /^(console|requests|dom|screenshot)-/.test(f)), []);

  // 5, 6. A FAIL and a PASS: as before.
  const failed = "fails, a page";
  assert.equal(status(failed)[0], "fail");
  assert.ok(files(failed).includes("console-delta.jsonl") && files(failed).includes("dom-delta.html"), files(failed).join(", "));
  assert.equal(by["passes, a page"]?.status, "pass");
  assert.equal(by["passes, a page"]?.evidenceDir ?? null, null, "a PASS keeps no evidence");
});

test("README states the INCONCLUSIVE capture and captureUsers", () => {
  const readme = readFileSync(join(E2E_DIR, "README.md"), "utf8");
  for (const s of ["An INCONCLUSIVE keeps every page, as a FAIL does", "`INCONCLUSIVE_CAPTURE_MS` (20 s)", "`CAPTURE_RESERVE_MS` (15 s)", "`captureUsers(ev, users,"]) {
    assert.ok(readme.includes(s), `README lacks ${s}`);
  }
  assert.ok(!readme.includes("an INCONCLUSIVE case's pages are not captured"), "the old sentence is gone");
});
