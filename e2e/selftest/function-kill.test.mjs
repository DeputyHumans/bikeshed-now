// SPDX-License-Identifier: Apache-2.0
// Self-test: a wait that ran out while the emulator killed functions under load ends INCONCLUSIVE — functionKill, ctx.logSince and scenario's inconclusiveOnFunctionKill (SPEC §12, §14).

/**
 * The judge reads a stack's emulators.log, so each test writes one: the
 * emulator's own lines, as measured on loaded shared stacks (a lock timeout's
 * error then its kill line, the 60 s limit's line, Hosting's 504 access
 * line). The failures judged are real ones where they are cheap: the mail
 * reader's waitFor and expectMailboxes against a fake Mailpit, eventually's.
 * Then generated fixture specs run through `node --test` with the real
 * reporter, the way run.mjs runs one, and every case's record is read back.
 * No browser, no stack.
 */

import { after, before, test } from "node:test";
import assert, { AssertionError } from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { eventually } from "../lib/assert.mjs";
import { createHttp } from "../lib/http.mjs";
import { createInvocation, nodeTestArgs } from "../lib/invocation.mjs";
import { logFile, logMark } from "../lib/logs.mjs";
import { mailbox } from "../lib/mail/reader.mjs";
import { E2E_DIR, E2E_TMP, OUT_DIR, REPO_ROOT, ensureDir } from "../lib/paths.mjs";
import { functionKill, scenario } from "../lib/test.mjs";

const lib = (f) => pathToFileURL(join(E2E_DIR, "lib", f)).href;
const LEAD = "the stack did not answer, so nothing was measured: ";
const LOCK_REASON = 'the emulator killed 1 function(s) for a transaction lock timeout ("ABORTED: Transaction lock timeout")';
const runId = `selftest-fkill-${process.pid}`;
const bareRunId = `selftest-fkill-bare-${process.pid}`;

/** A lock timeout as the emulator logs it: the error, its stack, then the kill line. */
const LOCK = [
  "⚠  functions: Error: 10 ABORTED: Transaction lock timeout.",
  ...Array.from({ length: 14 }, (_, i) => `    at frame${i} (/stand-in/node_modules/@grpc/grpc-js/build/src/call.js:${i + 1}:19)`),
  "⚠  Your function was killed because it raised an unhandled error.",
];
/** A function killed for the product's own error: no lock timeout before it. */
const PRODUCT_KILL = ["⚠  functions: TypeError: Cannot read properties of undefined (reading 'toMillis')", "    at /stand-in/functions/lib/index.js:772:37", "⚠  Your function was killed because it raised an unhandled error."];
const T60 = ["i  Your function timed out after ~60s. To configure this timeout, see", "      the emulator's documentation.", "i  Request to function failed: Error: socket hang up"];
const H504 = 'i  hosting: 127.0.0.1 - - [11/Oct/2026:08:20:29 +0000] "POST /folder-access HTTP/1.1" 504 - "-" "bikeshed-e2e/selftest"';
const H504_KEYED = 'i  hosting: 127.0.0.1 - - [11/Oct/2026:08:20:30 +0000] "GET /content/~abcdefgh12345678/d1/v1/index.html?k=abcdefgh12345678 HTTP/1.1" 504 - "-" "bikeshed-e2e/selftest"';
const H200 = 'i  hosting: 127.0.0.1 - - [11/Oct/2026:08:20:31 +0000] "POST /access HTTP/1.1" 200 15 "-" "bikeshed-e2e/selftest"';
const QUIET = ["i  functions: Beginning execution of \"us-central1-onCommentCreated\"", "i  functions: Finished \"us-central1-onCommentCreated\" in 812.5ms"];

let tmp;
let runDir;
let bareRunDir;
let mailServer;
let target;
let box;

const write = (lines) => appendFileSync(logFile(runId), `${lines.join("\n")}\n`);
const evStub = () => {
  const json = {};
  return { json, ev: { json(name, value) { json[name] = value; } } };
};
/** A ctx as runCase makes it: the target, the case's mark, an evidence stub. */
const ctxAt = (since, t = target) => ({ target: t, logSince: since, ...evStub() });

/** What `p` rejects with (it must reject). */
async function rejection(p) {
  try {
    await p;
  } catch (err) {
    return err;
  }
  assert.fail("expected a rejection");
}

before(async () => {
  tmp = mkdtempSync(join(ensureDir(E2E_TMP, "E2E_TMP"), "selftest-function-kill-"));
  runDir = join(OUT_DIR, runId);
  bareRunDir = join(OUT_DIR, bareRunId);
  mkdirSync(join(runDir, "logs"), { recursive: true });
  mkdirSync(bareRunDir, { recursive: true });
  writeFileSync(logFile(runId), "");
  // A fake Mailpit with one message, so the reader's real errors are judged.
  mailServer = createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    if (u.pathname === "/api/v1/search") {
      const messages = [{ ID: "m1", Subject: "dup", To: [{ Address: "e@x.com" }], Cc: [], Bcc: [], Created: "2026-10-12T10:00:00.000Z" }, { ID: "m2", Subject: "dup", To: [{ Address: "e@x.com" }], Cc: [], Bcc: [], Created: "2026-10-12T10:00:01.000Z" }];
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ total: 2, messages_count: 2, start: 0, messages }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((r) => mailServer.listen(0, "127.0.0.1", r));
  const port = mailServer.address().port;
  target = Object.freeze({ kind: "local", runId, runDir, origin: `http://127.0.0.1:${port}`, projectId: "demo-bikeshed", capabilities: new Set(["local", "logs", "mailpit"]), mail: { mailpitUrl: `http://127.0.0.1:${port}` }, stack: { ports: { hosting: port, mailpit: port } } });
  box = mailbox(target, { http: createHttp(target, { actor: "mailpit", evidence: false, guard: { check: () => ({ allow: true }) } }) });
});

after(async () => {
  await new Promise((r) => mailServer.close(r));
  rmSync(tmp, { recursive: true, force: true });
  rmSync(runDir, { recursive: true, force: true });
  rmSync(bareRunDir, { recursive: true, force: true });
});

/** The waits a judge may excuse, as the lib throws them. */
async function waits() {
  return {
    arrival: await rejection(box.waitFor({ to: "o@x.com", subject: "notice", timeout: 60, interval: 20 })),
    short: await rejection(box.expectMailboxes({ "o@x.com": ["notice"] }, { timeout: 60, interval: 20, settleMs: 50, allowShort: true })),
    eventual: await rejection(eventually(() => false, { timeout: 40, interval: 10, message: "the change log holds the comment" })),
    playwright: Object.assign(new Error("locator.click: Timeout 5000ms exceeded.\nCall log: …"), { name: "TimeoutError" }),
    rewordedPlaywright: new Error("owner: the toast never showed", { cause: Object.assign(new Error("Timeout 9000ms exceeded."), { name: "TimeoutError" }) }),
    logWait: Object.assign(new Error("no line matching /\\[email\\] sent/ in emulators.log after 45000 ms (since byte 0)"), { code: "E2E_LOG_TIMEOUT" }),
  };
}

test("a lock-timeout kill since the case began excuses a wait that ran out, any wait, with the evidence and the call site", async () => {
  write(LOCK); // before the case: never counted
  const since = logMark({ target });
  write([...QUIET, ...LOCK, ...QUIET]);
  const w = await waits();
  assert.equal(w.arrival.code, "E2E_MAIL");
  for (const [name, err] of Object.entries(w)) {
    const why = functionKill(err, ctxAt(since));
    assert.ok(typeof why === "string" && why.startsWith(`${LOCK_REASON} since the case began, so what it waited for may be what a killed function never did — the failure, at `), `${name}: ${why}`);
  }
  const ctx = ctxAt(since);
  const why = functionKill(w.arrival, ctx);
  assert.match(why, /— the failure, at function-kill\.test\.mjs:\d+ \(via [^)]*mail\/reader\.mjs:\d+\): waitFor: no message to o@x\.com with subject "notice" within 60 ms/);
  assert.deepEqual(ctx.json["function-kills"], { since, lockKills: 1, otherKills: 0, timedOut: 0, hosting504: 0, hosting504Lines: [] }, "the evidence: only the kills since the mark");
  assert.match(functionKill(w.short, ctxAt(since)), /: expectMailboxes: within 60 ms, a mailbox is still short: the mail to o@x\.com lacks \["notice"\]/);
  assert.equal(w.short.missingOnly, true);
});

test("NEGATIVE: no excuse without a lock timeout paired to its kill: a product's kill, a caught lock timeout, a kill too far after one, or nothing at all", async () => {
  const w = await waits();
  const judged = (lines) => {
    const since = logMark({ target });
    write(lines);
    return functionKill(w.arrival, ctxAt(since));
  };
  assert.equal(judged(QUIET), null, "a quiet log");
  assert.equal(judged(PRODUCT_KILL), null, "a kill for the product's own error is no evidence of load");
  assert.equal(judged(LOCK.slice(0, -1)), null, "a lock timeout nothing died of");
  assert.equal(judged([LOCK[0], ...Array.from({ length: 61 }, () => QUIET[0]), LOCK.at(-1)]), null, "a kill 62 lines after the lock timeout is not its");
  const two = logMark({ target });
  write([LOCK[0], LOCK[0], LOCK.at(-1)]);
  const ctx = ctxAt(two);
  assert.match(functionKill(w.arrival, ctx), /^the emulator killed 1 function\(s\) for a transaction lock timeout/, "two lock timeouts, one kill: one counted");
  assert.deepEqual([ctx.json["function-kills"].lockKills, ctx.json["function-kills"].otherKills], [1, 0]);
  write(PRODUCT_KILL);
  const later = ctxAt(two);
  assert.match(functionKill(w.arrival, later), /^the emulator killed 2 function\(s\)/, "a kill within the span of a lock timeout not yet paired is taken as its: the log cannot say otherwise");
  assert.deepEqual([later.json["function-kills"].lockKills, later.json["function-kills"].otherKills], [2, 0]);
});

test("a 60 s stop excuses a wait only beside Hosting's 504 in the same span; the 504 lines reach the evidence redacted", async () => {
  const w = await waits();
  let since = logMark({ target });
  write([...T60, H200]);
  assert.equal(functionKill(w.eventual, ctxAt(since)), null, "a function stopped at 60 s alone may be the product hanging");
  since = logMark({ target });
  write([H504]);
  assert.equal(functionKill(w.eventual, ctxAt(since)), null, "a 504 alone is a request's, and answered() judges that");
  since = logMark({ target });
  write([H504_KEYED, ...T60, H504, ...T60]);
  const ctx = ctxAt(since);
  assert.match(functionKill(w.eventual, ctx), /^the emulator stopped 2 function\(s\) at its 60 s limit while Hosting answered 2 request\(s\) 504 since the case began, so what it waited for/);
  const ev = ctx.json["function-kills"];
  assert.deepEqual([ev.lockKills, ev.timedOut, ev.hosting504], [0, 2, 2]);
  assert.doesNotMatch(JSON.stringify(ev), /abcdefgh12345678/, "a link key never reaches the evidence");
  since = logMark({ target });
  write([...LOCK, ...T60, H504]);
  assert.match(functionKill(w.eventual, ctxAt(since)), /^the emulator killed 1 function\(s\) for a transaction lock timeout \("ABORTED: Transaction lock timeout"\), and the emulator stopped 1 function\(s\) at its 60 s limit while Hosting answered 1 request\(s\) 504 since the case began/);
});

test("NEGATIVE: never an assertion, a precondition, an answer, something extra, or a failure that is not a wait, whatever the log says", async () => {
  const since = logMark({ target });
  write([...LOCK, ...T60, H504]);
  const extraNow = await rejection(box.expectMailboxes({ "e@x.com": ["dup"] }, { timeout: 60, interval: 20, settleMs: 50, allowShort: true }));
  assert.equal(extraNow.missingOnly, false, "the fake Mailpit holds one notice too many");
  const shortButExtra = Object.assign(new Error("expectMailboxes: within 60 ms, a mailbox is still short: …"), { code: "E2E_MAIL", missingOnly: false });
  const refused = [
    ["an assertion", new AssertionError({ message: "notice not within 60 ms" })],
    ["a precondition", Object.assign(new Error("precondition: POST /publish d: 500 within 60 ms"), { code: "E2E_PRECONDITION" })],
    ["an answer it refused", Object.assign(new Error("POST /access: expected 200, got 500"), { code: "E2E_STATUS", response: { status: 500, ms: 900 } })],
    ["mail extra at once", extraNow],
    ["a wait that says something extra arrived", shortButExtra],
    ["its cause says so", new Error("the notices were not within 60 ms", { cause: shortButExtra })],
    ["a known defect's oracle", Object.assign(new Error("not within 60 ms"), { code: "E2E_DEFECT_ORACLE" })],
    ["a sync barrier", Object.assign(new Error("barrier not within 60 ms"), { code: "E2E_SYNC_TIMEOUT" })],
    ["a plain error", new Error("boom")],
    ["nothing", null],
  ];
  for (const [what, err] of refused) assert.equal(functionKill(err, ctxAt(since)), null, what);
});

test("functionKill reads from the case's mark, or `since`; without a mark or a log it says nothing; a bad `since` throws", async () => {
  const w = await waits();
  const since = logMark({ target });
  write(LOCK);
  const mark = logMark({ target });
  assert.equal(functionKill(w.arrival, ctxAt(mark)), null, "the case began after the kill");
  assert.match(functionKill(w.arrival, ctxAt(mark), { since }), new RegExp(`^${LOCK_REASON.replace(/[()]/g, "\\$&")} since byte ${since} of the emulators log, so`), "an earlier mark, named as such");
  assert.equal(functionKill(w.arrival, { target }), null, "a ctx with no mark");
  assert.equal(functionKill(w.arrival, ctxAt(null)), null);
  assert.equal(functionKill(w.arrival, ctxAt(since, { ...target, capabilities: new Set(["local", "mailpit"]) })), null, "a target without the logs capability");
  assert.equal(functionKill(w.arrival, ctxAt(0, { ...target, runId: bareRunId })), null, "a run with no emulators.log");
  for (const bad of [-1, 1.5, "0", Number.NaN]) assert.throws(() => functionKill(w.arrival, ctxAt(0), { since: bad }), /functionKill: since is a byte offset into the emulators log/, String(bad));
  assert.throws(() => scenario("bad option", { inconclusiveOnFunctionKill: "yes" }, async () => {}), /inconclusiveOnFunctionKill is true or false, got "yes"/);
  assert.throws(() => scenario("bad option", { inconclusiveOnFunctionKill: true, inconclusiveOnStackTimeout: false }, async () => {}), /inconclusiveOnFunctionKill widens inconclusiveOnStackTimeout, which this case sets to false/);
});

// --- Through node --test and the reporter --------------------------------------

const FIXTURE = (withLogs) => `// fixture spec, generated by selftest/function-kill.test.mjs
import assert from "node:assert/strict";
import { appendFileSync, statSync } from "node:fs";
import { eventually } from ${JSON.stringify(lib("assert.mjs"))};
import { logFile } from ${JSON.stringify(lib("logs.mjs"))};
import { currentTarget, onAnsweringStack, functionKill, precondition, scenario } from ${JSON.stringify(lib("test.mjs"))};
const file = logFile(currentTarget().runId);
const write = (lines) => appendFileSync(file, lines.join("\\n") + "\\n");
const LOCK = ${JSON.stringify(LOCK)};
const PRODUCT_KILL = ${JSON.stringify(PRODUCT_KILL)};
const T60 = ${JSON.stringify(T60)};
const H504 = ${JSON.stringify(H504)};
const wait = () => eventually(() => false, { timeout: 30, interval: 10, message: "the notice to the owner" });
${withLogs ? "write(LOCK); // before every case: never any case's evidence" : ""}
scenario("logSince is the log's size as the case began", {}, async (ctx) => {
  ${withLogs ? "assert.equal(ctx.logSince, statSync(file).size);" : "assert.equal(ctx.logSince, null);"}
});
scenario("lock kill during the case, opted in", { inconclusiveOnFunctionKill: true }, async (ctx) => { ctx.step("the trigger's notice"); write(LOCK); await wait(); });
scenario("lock kill during the case, not opted in", {}, async () => { write(LOCK); await wait(); });
scenario("lock kill during the case, opted in, an assertion", { inconclusiveOnFunctionKill: true }, async () => { write(LOCK); assert.fail("the notice was not within 30 ms"); });
scenario("lock kill during the case, opted in, a precondition", { inconclusiveOnFunctionKill: true }, async () => { write(LOCK); precondition(false, "POST /publish answered 500"); });
scenario("product kill during the case, opted in", { inconclusiveOnFunctionKill: true }, async () => { write(PRODUCT_KILL); await wait(); });
scenario("no kill during the case, opted in", { inconclusiveOnFunctionKill: true }, async () => { await wait(); });
scenario("60 s stop and a 504 during the case, opted in", { inconclusiveOnFunctionKill: true }, async () => { write([...T60, H504]); await wait(); });
scenario("lock kill, page stall too", { inconclusiveOnPageStall: true, inconclusiveOnFunctionKill: true }, async () => { write(LOCK); await wait(); });
scenario("lock kill, wrapped", {}, onAnsweringStack(async () => { write(LOCK); await wait(); }, { also: functionKill }));
scenario("lock kill, opted in, something extra", { inconclusiveOnFunctionKill: true }, async () => { write(LOCK); throw Object.assign(new Error("expectMailboxes: within 30 ms, a mailbox is still short: …"), { code: "E2E_MAIL", missingOnly: false }); });
scenario("deadline, opted in to kills only", { inconclusiveOnFunctionKill: true }, async () => { throw new Error("timeout after 300 ms"); });
scenario("passes, opted in", { inconclusiveOnFunctionKill: true }, async () => { write(LOCK); });
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

/** Run FIXTURE(withLogs) as run.mjs runs a spec, against a target with or without the "logs" capability; → {by: {name: record}, records}. */
async function runFixture(withLogs) {
  const id = withLogs ? runId : bareRunId;
  const dir = withLogs ? runDir : bareRunDir;
  const t = { kind: "local", runId: id, runDir: dir, origin: "http://127.0.0.1:1", projectId: "demo-bikeshed", capabilities: withLogs ? ["local", "logs"] : ["local"], stack: { ports: { hosting: 1 } } };
  const targetFile = join(tmp, `target-${withLogs ? "logs" : "bare"}.json`);
  writeFileSync(targetFile, JSON.stringify(t));
  const spec = join(tmp, `fixture-${withLogs ? "logs" : "bare"}.spec.mjs`);
  writeFileSync(spec, FIXTURE(withLogs));
  const inv = createInvocation(dir, { runId: id, suite: "functional", plan: [{ tier: "functional", files: [spec] }], grep: null, n: null });
  const env = { ...process.env, E2E_TARGET: targetFile, E2E_RUN_ID: id, E2E_SUITE: "functional", E2E_INVOCATION_DIR: inv.dir };
  delete env.NODE_TEST_CONTEXT; // a nested node --test that inherits it streams to its parent and ignores reporters
  delete env.E2E_N;
  const proc = await runAsync(process.execPath, nodeTestArgs({ files: [spec], resultsFile: join(inv.dir, "results-functional.jsonl"), reporter: join(E2E_DIR, "lib", "reporter.mjs") }), { cwd: REPO_ROOT, timeout: 90_000, env });
  assert.notEqual(proc.status, null, `node --test hung and was killed (stdout tail: ${proc.stdout.slice(-800)})`);
  const records = readFileSync(join(inv.dir, "results-functional.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((r) => r.file === spec);
  return { by: Object.fromEntries(records.map((r) => [r.name, r])), records };
}

/** A failure's own code, else its message (the reporter gives a code-less error node:test's ERR_TEST_FAILURE). */
const failure = (e) => (e?.code && e.code !== "ERR_TEST_FAILURE" ? e.code : (e?.message ?? null));
const outcomeIn = (by) => (name) => [by[name]?.status, by[name]?.status === "inconclusive" ? by[name].inconclusive : failure(by[name]?.error)];

test("through node --test and the reporter: opted in, a wait that ran out while the emulator killed a function is INCONCLUSIVE with its evidence; everything else keeps its outcome", async () => {
  const { by, records } = await runFixture(true);
  const outcome = outcomeIn(by);
  const killed = (what) => new RegExp(`^${LEAD.replace(/[()]/g, "\\$&")}${what} since the case began, so what it waited for may be what a killed function never did — the failure, at fixture-logs\\.spec\\.mjs:\\d+ \\(via eventually, assert\\.mjs:\\d+\\): eventually: the notice to the owner not met within 30 ms`);
  const lock = LOCK_REASON.replace(/[()]/g, "\\$&");

  assert.deepEqual(outcome("logSince is the log's size as the case began"), ["pass", null]);
  assert.equal(outcome("lock kill during the case, opted in")[0], "inconclusive");
  assert.match(outcome("lock kill during the case, opted in")[1], killed(lock));
  assert.deepEqual(outcome("lock kill during the case, not opted in"), ["fail", "E2E_EVENTUALLY_TIMEOUT"], "without the option the same failure FAILS");
  assert.deepEqual(outcome("lock kill during the case, opted in, an assertion"), ["fail", "ERR_ASSERTION"]);
  assert.deepEqual(outcome("lock kill during the case, opted in, a precondition"), ["fail", "E2E_PRECONDITION"]);
  assert.deepEqual(outcome("product kill during the case, opted in"), ["fail", "E2E_EVENTUALLY_TIMEOUT"], "a kill for the product's own error excuses nothing");
  assert.deepEqual(outcome("no kill during the case, opted in"), ["fail", "E2E_EVENTUALLY_TIMEOUT"], "earlier cases' kills are not this case's evidence");
  assert.match(outcome("60 s stop and a 504 during the case, opted in")[1], killed("the emulator stopped 1 function\\(s\\) at its 60 s limit while Hosting answered 1 request\\(s\\) 504"));
  assert.match(outcome("lock kill, page stall too")[1], killed(lock), "no page, so the emulator's log decides");
  assert.match(outcome("lock kill, wrapped")[1], killed(lock));
  assert.deepEqual(outcome("lock kill, opted in, something extra"), ["fail", "E2E_MAIL"], "one too many is never excused");
  assert.deepEqual(outcome("deadline, opted in to kills only"), ["inconclusive", `${LEAD}a request to the stack got no answer: timeout after 300 ms`], "it implies inconclusiveOnStackTimeout");
  assert.deepEqual(outcome("passes, opted in"), ["pass", null]);
  assert.equal(records.length, 13, `one record per case: ${records.map((r) => r.name).join(" | ")}`);

  const ev = join(REPO_ROOT, by["lock kill during the case, opted in"].evidenceDir);
  const kills = JSON.parse(readFileSync(join(ev, "function-kills.json"), "utf8"));
  assert.deepEqual([kills.lockKills, kills.otherKills, kills.timedOut, kills.hosting504], [1, 0, 0, 0], "only this case's kill");
  assert.ok(Number.isInteger(kills.since) && kills.since > 0 && kills.since <= statSync(logFile(runId)).size);
  assert.match(readFileSync(join(ev, "stack-did-not-answer.txt"), "utf8"), /eventually: the notice to the owner not met within 30 ms/, "the failure itself is kept");
  assert.match(readFileSync(join(ev, "error.txt"), "utf8"), /^Error: INCONCLUSIVE: the stack did not answer, so nothing was measured: the emulator killed 1 function/);
  assert.match(readFileSync(join(ev, "steps.md"), "utf8"), /the trigger's notice/);
});

test("through node --test: a target without the logs capability has no mark, and a kill excuses nothing there", async () => {
  mkdirSync(join(bareRunDir, "logs"), { recursive: true });
  writeFileSync(logFile(bareRunId), ""); // a log the target does not claim to have
  const { by } = await runFixture(false);
  const outcome = outcomeIn(by);
  assert.deepEqual(outcome("logSince is the log's size as the case began"), ["pass", null], "ctx.logSince is null");
  assert.deepEqual(outcome("lock kill during the case, opted in"), ["fail", "E2E_EVENTUALLY_TIMEOUT"]);
  assert.deepEqual(outcome("deadline, opted in to kills only")[0], "inconclusive");
  assert.ok(existsSync(logFile(bareRunId)));
});
