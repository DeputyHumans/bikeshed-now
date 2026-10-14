// SPDX-License-Identifier: Apache-2.0
// Self-test: a case the stack did not answer ends INCONCLUSIVE — stackDidNotAnswer, answered, stackCutoff, onAnsweringStack and scenario's inconclusiveOnStackTimeout (SPEC §12).

/**
 * The classification is checked in this process against errors the real
 * http client raised (its own deadline, before the headers and mid-body; an
 * `expect` refusal) and against the shapes other lib helpers throw. Then a
 * generated fixture spec runs through `node --test` with the real reporter,
 * the way run.mjs runs one, and every case's record is read back: opted in,
 * not opted in, wrapped, a quicker 504, an assertion, a precondition and a
 * known defect's oracle. No browser, no stack: a local server that never
 * answers stands in for the stack that did not.
 */

import { after, before, test } from "node:test";
import assert, { AssertionError } from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHttp } from "../lib/http.mjs";
import { createInvocation, nodeTestArgs } from "../lib/invocation.mjs";
import { E2E_DIR, E2E_TMP, OUT_DIR, REPO_ROOT, ensureDir } from "../lib/paths.mjs";
import { HOSTING_CUTOFF_MS, answered, isHostingCutoff, onAnsweringStack, scenario, stackCutoff, stackDidNotAnswer } from "../lib/test.mjs";

const lib = (f) => pathToFileURL(join(E2E_DIR, "lib", f)).href;
const CUT = "Hosting's cut-off for a function that has not answered";
const DEADLINE = "a request to the stack got no answer: timeout after 200 ms";
const LEAD = "the stack did not answer, so nothing was measured: ";

let server;
let target;
let tmp;
let runDir;
const runId = `selftest-sto-${process.pid}`;

/** Never answers /hang; sends the headers and part of the body of /half, then nothing; 200 on /ok; 504 at once on anything else. */
function stand() {
  return http.createServer((req, res) => {
    if (req.url === "/hang") return;
    if (req.url === "/half") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.write("partial");
      return;
    }
    if (req.url === "/ok") return res.end("ok");
    res.writeHead(504, { "content-type": "text/plain" });
    res.end("Timed out waiting for function to respond.");
  });
}

const client = (o = {}) => createHttp(target, { actor: "selftest", evidence: false, guard: { check: () => ({ allow: true }) }, ...o });

/** What `p` rejects with (it must reject). */
async function rejection(p) {
  try {
    await p;
  } catch (err) {
    return err;
  }
  assert.fail("expected a rejection");
}

/** What `fn` throws (it must throw). */
function thrown(fn) {
  try {
    fn();
  } catch (err) {
    return err;
  }
  assert.fail("expected a throw");
}

function shaped(code, message, extra = {}) {
  return Object.assign(new Error(message), { code }, extra);
}

before(async () => {
  server = stand();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  tmp = mkdtempSync(join(ensureDir(E2E_TMP, "E2E_TMP"), "selftest-stack-timeout-"));
  runDir = join(OUT_DIR, runId);
  mkdirSync(runDir, { recursive: true });
  target = { kind: "local", runId, runDir, origin: `http://127.0.0.1:${port}`, projectId: "demo-bikeshed", capabilities: ["local"], stack: { ports: { hosting: port } } };
});

after(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  rmSync(tmp, { recursive: true, force: true });
  rmSync(runDir, { recursive: true, force: true });
});

test("the http client's own deadline is the stack not answering: before the headers and mid-body", async () => {
  for (const path of ["/hang", "/half"]) {
    const err = await rejection(client({ timeoutMs: 200 }).get(path));
    assert.equal(err.message, "timeout after 200 ms", `${path}: the client's deadline as fetch rejects with it`);
    assert.equal(stackDidNotAnswer(err), DEADLINE, path);
  }
  const ok = await client({ timeoutMs: 2000 }).get("/ok");
  assert.equal(ok.status, 200, "the stand-in answers what it should");
});

test("Hosting's cut-off 504 a lib error carries is the stack's, and names the request, redacted; a quicker 504 or another status is an answer", async () => {
  const quick = await rejection(client().get("/content/~abcdefgh12345678/d1/v1/index.html?k=abcdefgh12345678", { expect: 200 }));
  assert.equal(quick.code, "E2E_STATUS");
  assert.equal(quick.response.status, 504);
  assert.ok(quick.response.ms < HOSTING_CUTOFF_MS, `the stand-in's 504 is quick (${quick.response.ms} ms)`);
  assert.equal(stackDidNotAnswer(quick), null, "a quick 504 is the product's answer, and is judged");

  quick.response.ms = 60_005; // what the Hosting emulator's own 504 takes
  const why = stackDidNotAnswer(quick);
  assert.equal(why, `GET /content/~‹redacted›/d1/v1/index.html answered 504 after 60005 ms, ${CUT}`);
  assert.doesNotMatch(why, /abcdefgh12345678/, "the link key never reaches a reason");

  const at = (ms, status = 504) => shaped("E2E_STATUS", "POST http://127.0.0.1:1/access: expected 200, got 504: Timed out waiting for function to respond.", { response: { status, ms, url: "http://127.0.0.1:1/access" } });
  assert.equal(stackDidNotAnswer(at(HOSTING_CUTOFF_MS - 1)), null, "one ms short of the cut-off is an answer");
  assert.equal(stackDidNotAnswer(at(HOSTING_CUTOFF_MS)), `POST /access answered 504 after ${HOSTING_CUTOFF_MS} ms, ${CUT}`);
  assert.equal(stackDidNotAnswer(at(60_005, 500)), null, "another status at the cut-off is the product's");
  assert.equal(stackDidNotAnswer(at(60_005, 200)), null);

  const session = shaped("E2E_SESSION", "POST /session for owner: 504 Timed out waiting for function to respond. (wanted ok)", { response: { status: 504, ms: 60_010, url: "http://127.0.0.1:1/session" } });
  assert.equal(stackDidNotAnswer(session), `POST /session answered 504 after 60010 ms, ${CUT}`);
  const mcp = shaped("E2E_MCP_HTTP", "MCP tools/call: HTTP 504 Timed out waiting for function to respond.", { status: 504, res: { status: 504, response: { status: 504, ms: 60_002, url: "http://127.0.0.1:1/mcp" } } });
  assert.equal(stackDidNotAnswer(mcp), `MCP tools/call answered 504 after 60002 ms, ${CUT}`);
  const helper = shaped("E2E_TOKEN", "the token could not be minted", { response: { status: 504, ms: 61_000, url: "http://127.0.0.1:1/tokens?k=abcdefgh12345678" } });
  assert.equal(stackDidNotAnswer(helper), `a request to /tokens answered 504 after 61000 ms, ${CUT}`, "any helper's error that carries the response");
  const keyed = shaped("E2E_DOWNLOAD", "the page could not be read", { response: { status: 504, ms: 60_000, url: "http://127.0.0.1:1/content/~abcdefgh12345678/d1/v1/index.html" } });
  assert.equal(stackDidNotAnswer(keyed), `a request to /content/~‹redacted›/d1/v1/index.html answered 504 after 60000 ms, ${CUT}`, "a link key in the response's own URL is redacted too");
  const statusOnly = shaped("E2E_STATUS", "expected status 200, got 504", { status: 504 });
  assert.equal(stackDidNotAnswer(statusOnly), null, "a 504 with no measured wait is not known to be the cut-off");
});

test("never an assertion, a precondition, a wait, a guard refusal or an INCONCLUSIVE; a known defect's oracle only for what it wrapped", async () => {
  const deadline = await rejection(client({ timeoutMs: 200 }).get("/hang"));
  const cutResponse = { status: 504, ms: 60_005, url: "http://127.0.0.1:1/access" };
  const assertion = new AssertionError({ message: "timeout after 200 ms" });
  assert.equal(stackDidNotAnswer(assertion), null, "an assertion's message is the spec's, whatever it says");
  assert.equal(stackDidNotAnswer(Object.assign(new AssertionError({ message: "x" }), { response: cutResponse })), null);
  assert.equal(stackDidNotAnswer(shaped("ERR_ASSERTION", "timeout after 200 ms")), null);
  assert.equal(stackDidNotAnswer(shaped("E2E_PRECONDITION", "precondition: timeout after 200 ms")), null);
  assert.equal(stackDidNotAnswer(shaped("E2E_EVENTUALLY_TIMEOUT", "eventually: x not met within 200 ms after 3 samples; last error: timeout after 200 ms", { cause: deadline })), null, "a wait that ran out, even on a request that timed out");
  assert.equal(stackDidNotAnswer(shaped("E2E_GUARD", "guard refused POST /x: no")), null);
  assert.equal(stackDidNotAnswer(shaped("E2E_INCONCLUSIVE", "INCONCLUSIVE: timeout after 200 ms")), null);
  assert.equal(stackDidNotAnswer(new Error("timeout after 200 ms, then more")), null, "only exactly the client's message");
  assert.equal(stackDidNotAnswer(null), null);
  assert.equal(stackDidNotAnswer(undefined), null);

  const oracle = (cause) => Object.assign(new Error(cause?.message ?? "x", { cause }), { code: "E2E_DEFECT_ORACLE" });
  assert.equal(stackDidNotAnswer(oracle(deadline)), DEADLINE, "the oracle got no answer: nothing was measured");
  assert.equal(stackDidNotAnswer(oracle(shaped("E2E_STATUS", "POST /access: expected 200", { response: cutResponse }))), `POST /access answered 504 after 60005 ms, ${CUT}`);
  assert.equal(stackDidNotAnswer(oracle(assertion)), null, "the oracle's own assertion is the defect");
  assert.equal(stackDidNotAnswer(oracle(new Error("eventually: converged not met"))), null);
  assert.equal(stackDidNotAnswer(oracle(undefined)), null);
});

test("answered() and stackCutoff(): a page's response entry, a capture row, an http.mjs response, the ms alone", () => {
  const fine = { status: 200, ms: 70_000 };
  assert.equal(answered(fine), fine, "a slow 200 is an answer");
  const quick = { status: 504, ms: 1_200 };
  assert.equal(answered(quick), quick, "a quick 504 is an answer");

  const entry = { method: "POST", path: "/access", url: "http://127.0.0.1:1/access", status: 504, ms: 60_005 };
  assert.ok(isHostingCutoff(entry));
  const e1 = thrown(() => answered(entry));
  assert.equal(e1.code, "E2E_STACK_CUTOFF");
  assert.equal(e1.message, `POST /access answered 504 after 60005 ms, ${CUT}`);
  assert.equal(e1.stackCut, e1.message);
  assert.equal(e1.response, entry);
  assert.equal(stackDidNotAnswer(e1), e1.message);
  const named = thrown(() => answered(entry, "the page's POST /access"));
  assert.equal(named.message, `the page's POST /access answered 504 after 60005 ms, ${CUT}`);

  const row = { method: "POST", path: "/visibility", status: 504, sentAt: 1_000.4, respondedAt: 61_000.6 };
  assert.ok(isHostingCutoff(row), "a capture row's wait is respondedAt − sentAt");
  assert.ok(!isHostingCutoff({ ...row, respondedAt: 59_000 }));
  const e2 = thrown(() => answered(row));
  assert.equal(e2.message, `POST /visibility answered 504 after 60000 ms, ${CUT}`);

  const leaky = { method: "GET", url: "http://127.0.0.1:1/content/~abcdefgh12345678/d1/v1/index.html?k=abcdefgh12345678", status: 504, ms: 60_000 };
  const e3 = thrown(() => answered(leaky));
  assert.equal(e3.message, `GET /content/~‹redacted›/d1/v1/index.html answered 504 after 60000 ms, ${CUT}`);

  const res = { status: 504, ms: 60_100, url: "http://127.0.0.1:1/folder-access" };
  const e4 = thrown(() => answered(res));
  assert.equal(e4.message, `a request to /folder-access answered 504 after 60100 ms, ${CUT}`);

  const e5 = stackCutoff("the owner's POST /session", 60_010.4);
  assert.equal(e5.message, `the owner's POST /session answered 504 after 60010 ms, ${CUT}`);
  assert.deepEqual(e5.response, { status: 504, ms: 60_010.4 });
  assert.equal(stackCutoff(undefined, entry).message, `POST /access answered 504 after 60005 ms, ${CUT}`);
  const spec = Object.assign(new Error("whatever the spec said"), { stackCut: "the page's POST /view answered 504 after 60001 ms" });
  assert.equal(stackDidNotAnswer(spec), "the page's POST /view answered 504 after 60001 ms", "a spec's own stackCut, as a13 and a18 set it");

  assert.equal(isHostingCutoff({ status: () => 504 }), false, "a Playwright response has no measured wait");
  assert.equal(isHostingCutoff({ status: () => 504, ms: 60_000 }), true);
  assert.equal(isHostingCutoff(null), false);
  assert.equal(isHostingCutoff({ status: 504 }), false);
});

test("onAnsweringStack: the body's value, INCONCLUSIVE with the failure kept, everything else rethrown as it was, and a spec's `also`", async () => {
  const fakeCtx = () => ({ texts: {}, steps: [], ev: { text(n, v) { this.owner.texts[n] = v; }, step(s) { this.owner.steps.push(s); } } });
  const ctxOf = () => { const c = fakeCtx(); c.ev.owner = c; return c; };

  assert.equal(await onAnsweringStack(async () => 42)(ctxOf()), 42);

  const deadline = await rejection(client({ timeoutMs: 200 }).get("/hang"));
  const c1 = ctxOf();
  const inc = await rejection(onAnsweringStack(async () => { throw deadline; })(c1));
  assert.equal(inc.code, "E2E_INCONCLUSIVE");
  assert.equal(inc.reason, `${LEAD}${DEADLINE}`);
  assert.equal(inc.cause, deadline, "the failure rides along as the cause (error.txt)");
  assert.match(c1.texts["stack-did-not-answer.txt"], /timeout after 200 ms/);

  const assertion = new AssertionError({ message: "timeout after 200 ms" });
  assert.equal(await rejection(onAnsweringStack(async () => { throw assertion; })(ctxOf())), assertion, "an assertion is rethrown as it was");
  const boom = new Error("boom");
  assert.equal(await rejection(onAnsweringStack(async () => { throw boom; })(ctxOf())), boom);
  const already = shaped("E2E_INCONCLUSIVE", "INCONCLUSIVE: spread", { reason: "spread" });
  assert.equal(await rejection(onAnsweringStack(async () => { throw already; })(ctxOf())), already);

  const calls = [];
  const also = (err, ctx) => { calls.push([err, ctx]); return /within \d+ ms/.test(err.message) ? "the page's listener lost the emulator" : null; };
  const waited = new Error("u1: no matching response within 100 ms");
  const c2 = ctxOf();
  const viaAlso = await rejection(onAnsweringStack(async () => { throw waited; }, { also })(c2));
  assert.equal(viaAlso.reason, `${LEAD}the page's listener lost the emulator`);
  assert.equal(viaAlso.cause, waited);
  assert.deepEqual(calls, [[waited, c2]], "also gets the failure and the ctx");
  calls.length = 0;
  assert.equal((await rejection(onAnsweringStack(async () => { throw deadline; }, { also })(ctxOf()))).reason, `${LEAD}${DEADLINE}`);
  assert.equal(calls.length, 0, "also is not asked when the shapes already said");
  const keyedAlso = await rejection(onAnsweringStack(async () => { throw waited; }, { also: () => "the page's GET /d/doc?k=abcdefgh12345678 never loaded" })(ctxOf()));
  assert.equal(keyedAlso.reason, `${LEAD}the page's GET /d/doc?k=‹redacted› never loaded`, "a spec's own reason is redacted");
  const notWaited = new Error("plain");
  assert.equal(await rejection(onAnsweringStack(async () => { throw notWaited; }, { also })(ctxOf())), notWaited, "also's null: the failure stands");
  for (const refused of [new AssertionError({ message: "within 5 ms" }), shaped("E2E_DEFECT_ORACLE", "within 5 ms", { cause: new Error("within 5 ms") }), shaped("E2E_ISOLATION", "isolation breach within 5 ms"), shaped("E2E_GUARD", "guard refused within 5 ms")]) {
    calls.length = 0;
    assert.equal(await rejection(onAnsweringStack(async () => { throw refused; }, { also })(ctxOf())), refused, refused.code ?? "assertion");
    assert.equal(calls.length, 0, `also is never asked about ${refused.code ?? "an assertion"}`);
  }
  const c3 = ctxOf();
  const thrower = () => { throw new Error("also broke"); };
  assert.equal(await rejection(onAnsweringStack(async () => { throw waited; }, { also: thrower })(c3)), waited, "also throwing: the failure stands");
  assert.match(c3.steps.join("\n"), /also threw \(also broke\)/);

  assert.throws(() => onAnsweringStack("not a body"), TypeError);
  assert.throws(() => onAnsweringStack(async () => {}, { also: 3 }), TypeError);
  assert.throws(() => scenario("bad option", { inconclusiveOnStackTimeout: "yes" }, async () => {}), /inconclusiveOnStackTimeout is true or false, got "yes"/);
  assert.throws(() => scenario("bad option", { inconclusiveOnStackTimeout: 1 }, async () => {}), TypeError);
});

// --- Through node --test and the reporter --------------------------------------

const FIXTURE = `// fixture spec, generated by selftest/stack-timeout.test.mjs
import assert from "node:assert/strict";
import { onAnsweringStack, precondition, scenario, stackCutoff } from ${JSON.stringify(lib("test.mjs"))};
const cut = () => Object.assign(new Error("POST http://127.0.0.1:1/access: expected 200, got 504: Timed out waiting for function to respond."), { code: "E2E_STATUS", response: { status: 504, ms: 60005, url: "http://127.0.0.1:1/access" } });
scenario("deadline, opted in", { inconclusiveOnStackTimeout: true }, async (ctx) => { ctx.step("asking /hang"); await ctx.http({ timeoutMs: 300 }).get("/hang"); });
scenario("deadline, not opted in", {}, async (ctx) => { await ctx.http({ timeoutMs: 300 }).get("/hang"); });
scenario("deadline, opted out", { inconclusiveOnStackTimeout: false }, async (ctx) => { await ctx.http({ timeoutMs: 300 }).get("/hang"); });
scenario("cut-off 504, opted in", { inconclusiveOnStackTimeout: true }, async () => { throw cut(); });
scenario("cut-off 504, not opted in", {}, async () => { throw cut(); });
scenario("quick 504, opted in", { inconclusiveOnStackTimeout: true }, async (ctx) => { await ctx.http().get("/quick504", { expect: 200 }); });
scenario("page cut-off, wrapped", {}, onAnsweringStack(async () => { throw stackCutoff("the page's POST /access", { status: 504, ms: 60010 }); }));
scenario("assertion, opted in", { inconclusiveOnStackTimeout: true }, async () => { assert.fail("timeout after 300 ms"); });
scenario("precondition, opted in", { inconclusiveOnStackTimeout: true }, async () => { precondition(false, "timeout after 300 ms"); });
scenario("known defect, deadline, opted in", { inconclusiveOnStackTimeout: true, defect: "S3" }, async (ctx) => { await ctx.http({ timeoutMs: 300 }).get("/hang"); });
scenario("known defect, its oracle got no answer, opted in", { inconclusiveOnStackTimeout: true, defect: "S3" }, async (ctx) => { await ctx.oracle(() => ctx.http({ timeoutMs: 300 }).get("/hang")); });
scenario("known defect, its oracle failed, opted in", { inconclusiveOnStackTimeout: true, defect: "S3" }, async () => { assert.fail("still broken"); });
scenario("passes, opted in", { inconclusiveOnStackTimeout: true }, async (ctx) => { const r = await ctx.http().get("/ok"); assert.equal(r.status, 200); return "unused"; });
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

test("through node --test and the reporter: opted in, a non-answer is INCONCLUSIVE with its evidence; everything else keeps its outcome", async () => {
  const targetFile = join(tmp, "target.json");
  writeFileSync(targetFile, JSON.stringify(target));
  const spec = join(tmp, "fixture.spec.mjs");
  writeFileSync(spec, FIXTURE);
  const inv = createInvocation(runDir, { runId, suite: "functional", plan: [{ tier: "functional", files: [spec] }], grep: null, n: null });
  const env = { ...process.env, E2E_TARGET: targetFile, E2E_RUN_ID: runId, E2E_SUITE: "functional", E2E_INVOCATION_DIR: inv.dir };
  delete env.NODE_TEST_CONTEXT; // a nested node --test that inherits it streams to its parent and ignores reporters
  delete env.E2E_N;
  // ASYNC: the fixture's requests reach this process's own server.
  const proc = await runAsync(process.execPath, nodeTestArgs({ files: [spec], resultsFile: join(inv.dir, "results-functional.jsonl"), reporter: join(E2E_DIR, "lib", "reporter.mjs") }), { cwd: REPO_ROOT, timeout: 90_000, env });
  assert.notEqual(proc.status, null, `node --test hung and was killed (stdout tail: ${proc.stdout.slice(-800)})`);
  const records = readFileSync(join(inv.dir, "results-functional.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((r) => r.file === spec);
  const by = Object.fromEntries(records.map((r) => [r.name, r]));
  /** A failure's own code, else its message (the reporter gives a code-less error node:test's ERR_TEST_FAILURE). */
  const failure = (e) => (e?.code && e.code !== "ERR_TEST_FAILURE" ? e.code : (e?.message ?? null));
  const outcome = (name) => [by[name]?.status, by[name]?.status === "inconclusive" ? by[name].inconclusive : by[name]?.status === "todo" ? by[name].outcome : failure(by[name]?.error)];

  assert.deepEqual(outcome("deadline, opted in"), ["inconclusive", "the stack did not answer, so nothing was measured: a request to the stack got no answer: timeout after 300 ms"]);
  assert.deepEqual(outcome("deadline, not opted in"), ["fail", "timeout after 300 ms"], "without the option the same failure FAILS");
  assert.deepEqual(outcome("deadline, opted out"), ["fail", "timeout after 300 ms"]);
  assert.deepEqual(outcome("cut-off 504, opted in"), ["inconclusive", `${LEAD}POST /access answered 504 after 60005 ms, ${CUT}`]);
  assert.deepEqual(outcome("cut-off 504, not opted in"), ["fail", "E2E_STATUS"]);
  assert.deepEqual(outcome("quick 504, opted in"), ["fail", "E2E_STATUS"], "a quick 504 is judged");
  assert.deepEqual(outcome("page cut-off, wrapped"), ["inconclusive", `${LEAD}the page's POST /access answered 504 after 60010 ms, ${CUT}`]);
  assert.deepEqual(outcome("assertion, opted in"), ["fail", "ERR_ASSERTION"], "an assertion FAILS, whatever its message");
  assert.deepEqual(outcome("precondition, opted in"), ["fail", "E2E_PRECONDITION"]);
  assert.deepEqual(outcome("known defect, deadline, opted in"), ["inconclusive", `${LEAD}a request to the stack got no answer: timeout after 300 ms`], "not a FAIL, and not the defect's TODO");
  assert.deepEqual(outcome("known defect, its oracle got no answer, opted in"), ["inconclusive", `${LEAD}a request to the stack got no answer: timeout after 300 ms`], "an oracle that got no answer did not fail as expected");
  assert.deepEqual(outcome("known defect, its oracle failed, opted in"), ["todo", "failed-as-expected"]);
  assert.deepEqual(outcome("passes, opted in"), ["pass", null]);
  assert.equal(records.length, 13, `one record per case: ${records.map((r) => r.name).join(" | ")}`);

  const ev = join(REPO_ROOT, by["deadline, opted in"].evidenceDir);
  assert.ok(existsSync(join(ev, "stack-did-not-answer.txt")), "the failure itself is kept");
  assert.match(readFileSync(join(ev, "stack-did-not-answer.txt"), "utf8"), /timeout after 300 ms/);
  const error = readFileSync(join(ev, "error.txt"), "utf8");
  assert.match(error, /^Error: INCONCLUSIVE: the stack did not answer/);
  assert.match(error, /\ncause: Error: timeout after 300 ms/, "error.txt carries the failure as the cause");
  assert.match(readFileSync(join(ev, "steps.md"), "utf8"), /asking \/hang/);
  assert.match(readFileSync(join(ev, "http.jsonl"), "utf8"), /"url":"http:\/\/127\.0\.0\.1:\d+\/hang"/, "the request that got no answer is in the case's HTTP log");
});
