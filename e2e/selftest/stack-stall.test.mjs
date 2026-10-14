// SPDX-License-Identifier: Apache-2.0
// Self-test: a wait that ran out while a page saw the stack stall ends INCONCLUSIVE — pageStall, callSite, scenario's inconclusiveOnPageStall, and signInUi's refusal carrying its answer (SPEC §12).

/**
 * pageStall is checked here against users shaped as BrowserPool's (their
 * `responses`, `log.console`, `log.sdkProbes`, `log.requests`) and errors of
 * every shape the lib throws when a wait runs out; callSite against real
 * stacks. Then a generated fixture spec runs through `node --test` with the
 * real reporter, the way run.mjs runs one, with real pages: one logs the
 * Firestore SDK's "Could not reach Cloud Firestore backend", one sends the
 * SDK's network test, one gets a 504 (its measured wait set to Hosting's
 * cut-off afterwards: a self-test cannot wait a minute for it), one stays
 * quiet. Last, signInUi against a sign-in stand-in whose POST /session
 * answers 504: each refusal carries that answer. A local server stands in for
 * the stack; every request to a Google host is aborted by the tripwire before
 * it is sent. Needs Chrome.
 */

import { after, before, test } from "node:test";
import assert, { AssertionError } from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { eventually } from "../lib/assert.mjs";
import { BrowserPool } from "../lib/browser.mjs";
import { createInvocation, nodeTestArgs } from "../lib/invocation.mjs";
import { E2E_DIR, E2E_TMP, OUT_DIR, REPO_ROOT, ensureDir } from "../lib/paths.mjs";
import { STALL_WINDOW_MS, callSite, onAnsweringStack, pageStall, precondition, scenario, stackDidNotAnswer } from "../lib/test.mjs";

const lib = (f) => pathToFileURL(join(E2E_DIR, "lib", f)).href;
const LEAD = "the stack did not answer, so nothing was measured: ";
const CUT = "Hosting's cut-off for a function that has not answered";
const LOST_LINE = "@firebase/firestore: Firestore (11.0.0): Could not reach Cloud Firestore backend. Backend didn't respond within 10 seconds.";
const PROBE = "https://www.google.com/images/cleardot.gif?zx=ggcywhd9fkik";
const NOW = 1_800_000_000_000;

const runId = `selftest-stall-${process.pid}`;
let server;
let target;
let tmp;
let runDir;

/** What `p` rejects with (it must reject). */
async function rejection(p) {
  try {
    await p;
  } catch (err) {
    return err;
  }
  assert.fail("expected a rejection");
}

const shaped = (code, message, extra = {}) => Object.assign(new Error(message), { code }, extra);
const timeoutError = (message) => Object.assign(new Error(message), { name: "TimeoutError" });

/** A user as BrowserPool makes one, with only what pageStall reads; times are ms before NOW. */
function fakeUser(name, { cut = [], lost = [], probes = [], requests = null } = {}) {
  const u = {
    name,
    responses: cut.map(([ago, ms, status = 504, path = "/access"]) => ({ seq: 0, t: NOW - ago - ms, at: NOW - ago, ms, method: "POST", url: `http://127.0.0.1:1${path}`, path, status })),
    log: { console: lost.map((ago) => ({ t: NOW - ago, type: "error", text: LOST_LINE })), sdkProbes: probes.map((ago) => ({ t: NOW - ago, user: name, method: "GET", url: PROBE })), requests: [] },
  };
  if (requests) {
    delete u.responses;
    u.log.requests = requests.map(([ago, ms, status = 504]) => ({ t: NOW - ago - ms, ms, method: "POST", url: "http://127.0.0.1:1/folder-access?k=abcdefgh12345678", status }));
  }
  return u;
}
const ctxWith = (...users) => ({ usersSoFar: users });
const judge = (err, ctx, o = {}) => pageStall(err, ctx, { now: NOW, ...o });

/** A plain sign-in stand-in: the password form; a remembered user posts /session as the page loads and lands on the verification step. */
const SIGNIN = `<!doctype html><html><head><title>sign-in stand-in</title></head><body><div id="root"></div>
<script>
const root = document.getElementById("root");
function form(error) {
  root.innerHTML = '<div class="auth-card">' + (error ? '<p role="alert">' + error + "</p>" : "") + '<form id="f"><input id="auth-email" type="email"><input id="auth-password" type="password"><button type="submit">Sign in</button></form></div>';
  document.getElementById("f").onsubmit = async (e) => {
    e.preventDefault();
    const email = document.getElementById("auth-email").value;
    localStorage.setItem("user", email);
    const r = await fetch("/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) });
    try { await r.json(); } catch {}
    form("Could not establish a secure session. Try signing in again.");
  };
}
const remembered = localStorage.getItem("user");
if (remembered) {
  fetch("/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: remembered }) }).then(() => {
    root.innerHTML = '<div class="auth-card"><span class="auth-step">1</span><span class="auth-step">2</span><span class="auth-step" aria-current="step">3</span></div>';
  });
} else form(null);
</script></body></html>`;

/** POST /session: 504 at once, as text ("text-…") or as JSON ("json-…"); POST /slow: 504 at once; anything else a plain page. */
function stand() {
  return http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/session") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const email = String(JSON.parse(body || "{}").email ?? "");
        if (email.startsWith("json-")) return res.writeHead(504, { "content-type": "application/json" }).end(JSON.stringify({ status: "session_failed" }));
        res.writeHead(504, { "content-type": "text/plain" }).end("Timed out waiting for function to respond.");
      });
      return;
    }
    if (req.method === "POST" && req.url === "/slow") return res.writeHead(504, { "content-type": "text/plain" }).end("Timed out waiting for function to respond.");
    res.setHeader("content-type", "text/html; charset=utf-8");
    if (req.url.startsWith("/signup")) return res.end(SIGNIN);
    res.end("<!doctype html><title>app</title><body>app</body>");
  });
}

before(async () => {
  server = stand();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  tmp = mkdtempSync(join(ensureDir(E2E_TMP, "E2E_TMP"), "selftest-stack-stall-"));
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

test("pageStall: a wait that ran out, with a page's evidence inside that wait's window, is the stack's; the reason names the evidence, the window and the failure", () => {
  const toast = new Error("reader: no matching toast within 30000 ms (seen: none)");
  const lostAt = (ago) => ctxWith(fakeUser("reader", { lost: [ago] }));
  const why = judge(toast, lostAt(5_000));
  assert.match(why, /^a page's Firestore client lost the emulator \(reader: "Could not reach Cloud Firestore backend"\), in the 40 s before a wait ran out — the failure, at stack-stall\.test\.mjs:\d+: reader: no matching toast within 30000 ms \(seen: none\)$/);
  assert.equal(typeof judge(toast, lostAt(39_999)), "string", "the wait (30 s) and the margin (10 s)");
  assert.equal(judge(toast, lostAt(40_001)), null, "NEGATIVE: before the wait's window is not this wait's stall");
  assert.equal(judge(toast, ctxWith(fakeUser("reader"))), null, "NEGATIVE: a wait that ran out on a stack that kept answering FAILS");
  assert.equal(judge(toast, ctxWith()), null, "no pages, no evidence");

  const probe = judge(new Error("eventually: the record not met within 2000 ms after 9 samples; last value: null"), ctxWith(fakeUser("a", { probes: [1_000, 2_000] }), fakeUser("b", { probes: [500] })));
  assert.match(probe, /^a page's Firestore client lost the emulator \(a: 2 Firestore SDK network tests; b: the Firestore SDK's network test\), in the 12 s before a wait ran out/);

  const cut = judge(timeoutError("locator.waitFor: Timeout 90000ms exceeded.\nCall log:\n  - waiting for #x within 5 ms"), ctxWith(fakeUser("owner", { cut: [[20_000, 60_010]] })));
  assert.match(cut, /^a page's request got Hosting's cut-off 504 \(owner: POST \/access 504 after 60010 ms\), in the 100 s before a wait ran out — the failure, at [^:]+:\d+: locator\.waitFor: Timeout 90000ms exceeded\.$/, "Playwright's wait, by its first line only");
  const both = judge(toast, ctxWith(fakeUser("owner", { cut: [[1_000, 60_000]], lost: [2_000] })));
  assert.match(both, /^a page's request got Hosting's cut-off 504 \(owner: POST \/access 504 after 60000 ms\), and a page's Firestore client lost the emulator \(owner: "Could not reach Cloud Firestore backend"\), in the 40 s/);

  assert.equal(judge(toast, ctxWith(fakeUser("owner", { cut: [[1_000, 58_999]] }))), null, "NEGATIVE: a quicker 504 is the product's answer, not a stall");
  assert.equal(judge(toast, ctxWith(fakeUser("owner", { cut: [[1_000, 60_000, 500]] }))), null, "NEGATIVE: another status at the cut-off is the product's");
  assert.equal(judge(toast, ctxWith(fakeUser("owner", { cut: [[45_000, 60_000]] }))), null, "NEGATIVE: a cut-off answered before the window");
  const many = judge(toast, ctxWith(fakeUser("o", { cut: [[1, 60_000, 504, "/a"], [2, 60_000, 504, "/b"], [3, 60_000, 504, "/c"], [4, 60_000, 504, "/d"], [5, 60_000, 504, "/e"]] })));
  assert.match(many, /\(o: POST \/a 504 after 60000 ms; o: POST \/b 504 after 60000 ms; o: POST \/c 504 after 60000 ms; and 2 more\)/);
  const viaLog = judge(toast, ctxWith(fakeUser("w", { requests: [[3_000, 61_000]] })));
  assert.match(viaLog, /\(w: POST \/folder-access 504 after 61000 ms\)/, "without User.responses, log.requests rows (t + ms)");
});

test("pageStall: which failures are waits — and never an assertion, an answer, a known defect's oracle, a refusal or the harness's own wait", () => {
  const ctx = ctxWith(fakeUser("p", { lost: [1_000] }));
  const waits = [
    [new Error("reader: no matching response within 500 ms (last seen: none)"), "11 s"],
    [timeoutError("page.waitForResponse: Timeout 2000ms exceeded while waiting for event \"response\""), "12 s"],
    [shaped("E2E_EVENTUALLY_TIMEOUT", "eventually: x not met within 4000 ms after 3 samples; last error: boom", { cause: new AssertionError({ message: "inside the poll" }) }), "14 s"],
    [shaped("E2E_LOG_TIMEOUT", "no line matching /x/ in /tmp/f.log after 6000 ms (since byte 0)\n--- tail ---\nwithin 1 ms"), "16 s"],
    [shaped("E2E_MAIL", "expectMail: wanted 1; saw 0 within 8000 ms ()"), "18 s"],
    [new Error("reader: signInUi({next}): signed in, but the app did not land on /d/x within 1000 ms; the page is at /", { cause: new Error("x") }), "11 s"],
    [new Error("the frame did not load", { cause: timeoutError("locator.waitFor: Timeout 3000ms exceeded.") }), "13 s"],
    [timeoutError("a Playwright wait that does not say how long"), "130 s"],
    [shaped("E2E_PRECONDITION", "precondition: the record within 1 ms"), "130 s"],
  ];
  for (const [err, span] of waits) {
    const why = judge(err, ctx);
    assert.equal(typeof why, "string", err.message);
    assert.match(why, new RegExp(`in the ${span} before a (wait ran out|precondition failed)`), err.message);
  }
  assert.match(judge(shaped("E2E_PRECONDITION", "precondition: x"), ctx), /before a precondition failed/);
  assert.equal(STALL_WINDOW_MS, 130_000);
  assert.equal(judge(shaped("E2E_PRECONDITION", "precondition: x"), ctxWith(fakeUser("p", { lost: [STALL_WINDOW_MS + 1] }))), null, "a precondition looks back STALL_WINDOW_MS");
  assert.equal(typeof judge(shaped("E2E_PRECONDITION", "precondition: x"), ctxWith(fakeUser("p", { lost: [STALL_WINDOW_MS + 1] })), { windowMs: 200_000 }), "string", "or windowMs");
  assert.equal(typeof judge(new Error("u: no dialog within 1000 ms"), ctxWith(fakeUser("p", { lost: [20_000] })), { marginMs: 20_000 }), "string", "marginMs widens a wait's window");

  const never = [
    new AssertionError({ message: "x not met within 5 ms" }),
    shaped("ERR_ASSERTION", "within 5 ms"),
    shaped("E2E_DEFECT_ORACLE", "u: no matching toast within 5 ms", { cause: new Error("u: no matching toast within 5 ms") }),
    shaped("E2E_INCONCLUSIVE", "INCONCLUSIVE: within 5 ms"),
    shaped("E2E_ISOLATION_BREACH", "isolation breach within 5 ms"),
    shaped("E2E_GUARD", "guard refused within 5 ms"),
    shaped("E2E_SYNC_TIMEOUT", "barrier: 2 of 3 arrived within 5 ms"),
    shaped("E2E_SPARE_TIMEOUT", "no spare port within 5 ms"),
    shaped("E2E_TIMEOUT", "timed out after 5 ms"),
    shaped("E2E_STATUS", "POST /x: expected 200, got 504: within 5 ms", { response: { status: 504, ms: 900 } }),
    shaped("E2E_MCP_TOOL", "MCP tool error: the backend did not answer within 5 ms"),
    Object.assign(new Error("u: POST /session answered 504 (body unread) within 5 ms"), { response: { method: "POST", path: "/session", status: 504, ms: 800 } }),
    new Error("plain failure"),
    new Error("the frame did not load", { cause: new AssertionError({ message: "within 5 ms" }) }),
    "a string within 5 ms",
    null,
    undefined,
  ];
  for (const err of never) assert.equal(judge(err, ctx), null, String(err?.code ?? err?.message ?? err));
});

test("pageStall: reads ctx.usersSoFar and never makes a pool; a ctx that throws is no evidence; the reason is redacted; bad options throw", () => {
  const err = new Error("u: no matching toast within 1000 ms");
  let touched = 0;
  const strict = { usersSoFar: [], get users() { touched += 1; throw new Error("would make a pool"); } };
  assert.equal(judge(err, strict), null);
  assert.equal(touched, 0, "ctx.users is never read when usersSoFar is there");
  assert.equal(typeof judge(err, { get users() { return { users: [fakeUser("legacy", { lost: [1] })] }; } }), "string", "a ctx without usersSoFar: ctx.users.users");
  assert.equal(judge(err, { get users() { throw new Error("this case was already reported (timed out); no new users"); } }), null);
  assert.equal(judge(err, null), null);

  const keyed = new Error("u: GET /d/doc?k=abcdefgh12345678 not reached within 1000 ms");
  const why = judge(keyed, ctxWith(fakeUser("u", { requests: [[10, 60_000]] })));
  assert.doesNotMatch(why, /abcdefgh12345678/, "a link key never reaches a reason");
  assert.match(why, /k=‹redacted›/);

  for (const bad of [{ windowMs: -1 }, { windowMs: Number.NaN }, { marginMs: "10" }, { now: null }]) {
    assert.throws(() => pageStall(err, strict, bad), TypeError, JSON.stringify(bad));
  }
});

/** A lib call from this file, so its stack has a lib frame and then this one. */
async function eventuallyFails() {
  return eventually(() => false, { timeout: 30, interval: 10, message: "nothing" });
}

test("callSite: the first frame outside e2e/lib and the outermost lib call it made, by file name; never a directory", async () => {
  const fromLib = await rejection(eventuallyFails());
  assert.match(callSite(fromLib), /^stack-stall\.test\.mjs:\d+ \(via eventually, assert\.mjs:\d+\)$/);
  const here = new Error("made here");
  assert.match(callSite(here), /^stack-stall\.test\.mjs:\d+$/);
  const line = Number(callSite(here).split(":")[1]);
  assert.ok(Math.abs(line - Number(new Error().stack.split("\n")[1].match(/:(\d+):\d+\)?$/)[1])) < 5, "the line of the `new Error` above");
  const pre = (() => {
    try {
      precondition(false, "x");
    } catch (err) {
      return err;
    }
  })();
  assert.match(callSite(pre), /^stack-stall\.test\.mjs:\d+ \(via precondition, test\.mjs:\d+\)$/);

  const libOnly = Object.assign(new Error("x"), { stack: `Error: x\n    at User.poll (${lib("browser.mjs")}:2145:13)\n    at process.processTicksAndRejections (node:internal/process/task_queues:105:5)` });
  assert.equal(callSite(libOnly), "User.poll, browser.mjs:2145", "no caller frame: the lib call alone");
  const nested = Object.assign(new Error("x"), { stack: `Error: x\n    at waitIn (${lib("mail/reader.mjs")}:10:1)\n    at async ${pathToFileURL(join(REPO_ROOT, "e2e", "specs", "functional", "a19-account.spec.mjs")).href}:244:5` });
  assert.equal(callSite(nested), "a19-account.spec.mjs:244 (via waitIn, mail/reader.mjs:10)", "an async frame with no function name; a lib module in a subdirectory");
  const pathStyle = Object.assign(new Error("x"), { stack: `Error: x\n    at Object.<anonymous> (${join(REPO_ROOT, "e2e", "specs", "x.spec.mjs")}:7:3)` });
  assert.equal(callSite(pathStyle), "x.spec.mjs:7", "a plain path, not a file URL");
  const viaCause = Object.assign(new Error("outer", { cause: here }), { stack: "Error: outer" });
  assert.match(callSite(viaCause), /^stack-stall\.test\.mjs:\d+$/, "a stack with no frames: its cause's");
  const modules = Object.assign(new Error("x"), { stack: `Error: x\n    at f (${join(REPO_ROOT, "node_modules", "playwright-core", "lib", "x.js")}:1:1)\n    at new Promise (<anonymous>)\n    at node:internal/x:1:1` });
  assert.equal(callSite(modules), null, "node_modules and node's own frames are nobody's call site");
  assert.equal(callSite(null), null);
  for (const site of [callSite(fromLib), callSite(nested), callSite(pathStyle)]) assert.ok(!site.includes(REPO_ROOT) && !site.startsWith("/"), site);
});

test("scenario: inconclusiveOnPageStall is a boolean, and does not stand beside inconclusiveOnStackTimeout: false", () => {
  assert.throws(() => scenario("bad page option", { inconclusiveOnPageStall: "yes" }, async () => {}), /inconclusiveOnPageStall is true or false, got "yes"/);
  assert.throws(() => scenario("bad page option", { inconclusiveOnPageStall: 1 }, async () => {}), TypeError);
  assert.throws(() => scenario("contradiction", { inconclusiveOnPageStall: true, inconclusiveOnStackTimeout: false }, async () => {}), /inconclusiveOnPageStall widens inconclusiveOnStackTimeout, which this case sets to false/);
});

test("onAnsweringStack(fn, {also: pageStall}): INCONCLUSIVE with the evidence; a quiet page's wait stands", async () => {
  const fakeCtx = (users) => ({ usersSoFar: users, texts: {}, ev: { text() {}, step() {} } });
  const waited = new Error("u: no matching toast within 1000 ms");
  const inc = await rejection(onAnsweringStack(async () => { throw waited; }, { also: pageStall })(fakeCtx([{ name: "u", log: { console: [{ t: Date.now(), text: LOST_LINE }] } }])));
  assert.equal(inc.code, "E2E_INCONCLUSIVE");
  assert.ok(inc.reason.startsWith(`${LEAD}a page's Firestore client lost the emulator (u: "Could not reach Cloud Firestore backend"), in the 11 s before a wait ran out`), inc.reason);
  assert.equal(inc.cause, waited);
  assert.equal(await rejection(onAnsweringStack(async () => { throw waited; }, { also: pageStall })(fakeCtx([{ name: "u", log: { console: [] } }]))), waited);
});

test("signInUi: each refusal carries POST /session's answer as `response`, plain; Hosting's cut-off there is the stack not answering, a quicker 504 is judged", async () => {
  const pool = new BrowserPool({ target: { ...target, capabilities: new Set(["local"]) } });
  try {
    const t = await pool.user({ name: "text" });
    const refusedText = await rejection(t.signInUi("text-a@example.com", "pw", { timeout: 15_000 }));
    assert.match(refusedText.message, /^text: POST \/session answered 504 \(body unread\), the page shows "session_failed" \(wanted ok\)$/);
    const j = await pool.user({ name: "json" });
    const refusedJson = await rejection(j.signInUi("json-a@example.com", "pw", { timeout: 15_000 }));
    assert.match(refusedJson.message, /^json: POST \/session answered 504 \{"status":"session_failed"\} \(wanted ok\)$/);
    const refusedAlready = await rejection(t.signInUi("text-a@example.com", "pw", { timeout: 15_000 }));
    assert.match(refusedAlready.message, /^text: already signed in at \/signup: the page shows "unverified", POST \/session answered 504 null \(wanted ok\)$/);

    for (const err of [refusedText, refusedJson, refusedAlready]) {
      const r = err.response;
      assert.deepEqual(Object.keys(r ?? {}), ["method", "path", "status", "ms"], err.message);
      assert.deepEqual([r.method, r.path, r.status], ["POST", "/session", 504], err.message);
      assert.ok(Number.isFinite(r.ms) && r.ms >= 0 && r.ms < 15_000, `${r.ms}`);
      for (const v of Object.values(r)) assert.ok(v === null || (typeof v !== "object" && typeof v !== "function"), "a plain answer: nothing live rides on the error");
      assert.equal(stackDidNotAnswer(err), null, "NEGATIVE: a quick 504 is an answer, and is judged");
      assert.equal(pageStall(err, ctxWith({ name: "x", log: { console: [{ t: Date.now(), text: LOST_LINE }] } })), null, "a refused answer is never a wait");
      const atCutoff = Object.assign(new Error(err.message), { response: { ...r, ms: 60_010 } });
      assert.equal(stackDidNotAnswer(atCutoff), `POST /session answered 504 after 60010 ms, ${CUT}`, err.message);
    }
  } finally {
    await pool.close();
  }
});

// --- Through node --test and the reporter --------------------------------------

const FIXTURE = `// fixture spec, generated by selftest/stack-stall.test.mjs
import assert from "node:assert/strict";
import { eventually } from ${JSON.stringify(lib("assert.mjs"))};
import { precondition, scenario } from ${JSON.stringify(lib("test.mjs"))};
const LOST = ${JSON.stringify(LOST_LINE)};
const PROBE = ${JSON.stringify(PROBE)};
async function page(ctx, how) {
  const u = await ctx.users.user({ name: "reader" });
  await u.goto("/app");
  if (how === "lost") {
    await u.page.evaluate((line) => console.error(line), LOST);
    await u.poll(() => u.log.console.some((c) => c.text.includes("Could not reach")), { timeout: 10000, what: "the console line" });
  }
  if (how === "probe") {
    await u.page.evaluate((src) => new Promise((done) => { const i = new Image(); i.onload = i.onerror = () => done(); i.src = src; }), PROBE);
    await u.poll(() => u.log.sdkProbes.length > 0, { timeout: 10000, what: "the probe" });
  }
  if (how === "cut") {
    const mark = u.responseMark();
    await u.page.evaluate(() => fetch("/slow", { method: "POST" }).then((r) => r.status));
    const entry = await u.waitForResponse({ method: "POST", path: "/slow" }, { since: mark, timeout: 10000 });
    entry.ms = 60010; // Hosting's cut-off, which a self-test cannot wait a minute for
  }
  return u;
}
const waitOut = (u) => u.page.locator("#never").waitFor({ timeout: 400 });
scenario("lost, a wait ran out, opted in", { inconclusiveOnPageStall: true }, async (ctx) => { const u = await page(ctx, "lost"); await waitOut(u); });
scenario("lost, a wait ran out, not opted in", {}, async (ctx) => { const u = await page(ctx, "lost"); await waitOut(u); });
scenario("lost, a wait ran out, only inconclusiveOnStackTimeout", { inconclusiveOnStackTimeout: true }, async (ctx) => { const u = await page(ctx, "lost"); await waitOut(u); });
scenario("probe, eventually ran out, opted in", { inconclusiveOnStackTimeout: true, inconclusiveOnPageStall: true }, async (ctx) => { await page(ctx, "probe"); await eventually(() => false, { timeout: 300, message: "the record" }); });
scenario("cut-off, a precondition, opted in", { inconclusiveOnPageStall: true }, async (ctx) => { await page(ctx, "cut"); precondition(false, "the toast never came"); });
scenario("quiet page, a wait ran out, opted in", { inconclusiveOnPageStall: true }, async (ctx) => { const u = await page(ctx, "quiet"); await waitOut(u); });
scenario("lost, an assertion, opted in", { inconclusiveOnPageStall: true }, async (ctx) => { await page(ctx, "lost"); assert.fail("the page ignored what it was delivered"); });
scenario("lost, a known defect's oracle waited out, opted in", { inconclusiveOnPageStall: true, defect: "S9" }, async (ctx) => { const u = await page(ctx, "lost"); await ctx.oracle(() => waitOut(u)); });
scenario("no users, a wait ran out, opted in", { inconclusiveOnPageStall: true }, async () => { await eventually(() => false, { timeout: 200, message: "the record" }); });
scenario("passes, opted in", { inconclusiveOnPageStall: true }, async (ctx) => { const u = await page(ctx, "lost"); assert.equal(await u.page.title(), "app"); });
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

test("through node --test and the reporter: opted in, a wait that ran out beside a page's stall is INCONCLUSIVE, naming its call site; everything else keeps its outcome", async () => {
  const targetFile = join(tmp, "target.json");
  writeFileSync(targetFile, JSON.stringify(target));
  const spec = join(tmp, "fixture.spec.mjs");
  writeFileSync(spec, FIXTURE);
  const inv = createInvocation(runDir, { runId, suite: "functional", plan: [{ tier: "functional", files: [spec] }], grep: null, n: null });
  const env = { ...process.env, E2E_TARGET: targetFile, E2E_RUN_ID: runId, E2E_SUITE: "functional", E2E_INVOCATION_DIR: inv.dir };
  delete env.NODE_TEST_CONTEXT; // a nested node --test that inherits it streams to its parent and ignores reporters
  delete env.E2E_N;
  delete env.E2E_TRACE;
  // ASYNC: the fixture's pages reach this process's own server.
  const proc = await runAsync(process.execPath, nodeTestArgs({ files: [spec], resultsFile: join(inv.dir, "results-functional.jsonl"), reporter: join(E2E_DIR, "lib", "reporter.mjs") }), { cwd: REPO_ROOT, timeout: 180_000, env });
  assert.notEqual(proc.status, null, `node --test hung and was killed (stdout tail: ${proc.stdout.slice(-800)})`);
  const records = readFileSync(join(inv.dir, "results-functional.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((r) => r.file === spec);
  const by = Object.fromEntries(records.map((r) => [r.name, r]));
  const failure = (e) => (e?.code && e.code !== "ERR_TEST_FAILURE" ? e.code : (e?.message ?? null));
  const outcome = (name) => [by[name]?.status, by[name]?.status === "inconclusive" ? by[name].inconclusive : by[name]?.status === "todo" ? by[name].outcome : failure(by[name]?.error)];
  const line = (needle) => FIXTURE.split("\n").findIndex((l) => l.includes(needle)) + 1;
  const scenarioLine = (name) => line(`scenario(${JSON.stringify(name)}`);

  const [s1, r1] = outcome("lost, a wait ran out, opted in");
  assert.equal(s1, "inconclusive", String(r1));
  assert.equal(r1, `${LEAD}a page's Firestore client lost the emulator (reader: "Could not reach Cloud Firestore backend"), in the 10 s before a wait ran out — the failure, at fixture.spec.mjs:${line("const waitOut =")}: locator.waitFor: Timeout 400ms exceeded.`);
  for (const name of ["lost, a wait ran out, not opted in", "lost, a wait ran out, only inconclusiveOnStackTimeout"]) {
    const [s, r] = outcome(name);
    assert.equal(s, "fail", name);
    assert.match(String(r), /Timeout 400ms exceeded/, name);
  }
  const [s4, r4] = outcome("probe, eventually ran out, opted in");
  assert.equal(s4, "inconclusive", String(r4));
  assert.equal(r4, `${LEAD}a page's Firestore client lost the emulator (reader: the Firestore SDK's network test), in the 10 s before a wait ran out — the failure, at fixture.spec.mjs:${scenarioLine("probe, eventually ran out, opted in")} (via eventually, assert.mjs:${readFileSync(join(E2E_DIR, "lib", "assert.mjs"), "utf8").split("\n").findIndex((l) => l.includes("const err = new Error(`eventually:")) + 1}): eventually: the record not met within 300 ms after ${r4.match(/after (\d+) samples/)?.[1]} samples; last value: false`);
  const [s5, r5] = outcome("cut-off, a precondition, opted in");
  assert.equal(s5, "inconclusive", String(r5));
  assert.match(r5, new RegExp(`^${LEAD}a page's request got Hosting's cut-off 504 \\(reader: POST /slow 504 after 60010 ms\\), in the 130 s before a precondition failed — the failure, at fixture\\.spec\\.mjs:${scenarioLine("cut-off, a precondition, opted in")} \\(via precondition, test\\.mjs:\\d+\\): precondition: the toast never came$`));
  const [s6, r6] = outcome("quiet page, a wait ran out, opted in");
  assert.deepEqual([s6, /Timeout 400ms exceeded/.test(String(r6))], ["fail", true], "NEGATIVE: a wait on a stack that kept answering FAILS");
  assert.deepEqual(outcome("lost, an assertion, opted in"), ["fail", "ERR_ASSERTION"], "an assertion FAILS, whatever a page saw");
  assert.deepEqual(outcome("lost, a known defect's oracle waited out, opted in"), ["todo", "failed-as-expected"], "a known defect's oracle is never a page stall");
  assert.deepEqual(outcome("no users, a wait ran out, opted in"), ["fail", "E2E_EVENTUALLY_TIMEOUT"], "no pages, no evidence");
  assert.deepEqual(outcome("passes, opted in"), ["pass", null]);
  assert.equal(records.length, 10, `one record per case: ${records.map((r) => r.name).join(" | ")}`);

  const ev = join(REPO_ROOT, by["lost, a wait ran out, opted in"].evidenceDir);
  assert.match(readFileSync(join(ev, "stack-did-not-answer.txt"), "utf8"), /Timeout 400ms exceeded/, "the failure itself is kept");
  const error = readFileSync(join(ev, "error.txt"), "utf8");
  assert.match(error, /^Error: INCONCLUSIVE: the stack did not answer/);
  assert.match(error, /\ncause: (TimeoutError: )?locator\.waitFor: Timeout 400ms exceeded/, "error.txt carries the failure as the cause");
});
