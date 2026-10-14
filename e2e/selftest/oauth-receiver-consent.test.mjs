// SPDX-License-Identifier: Apache-2.0
// Self-test: when no redirect reaches a receiver, its timeout names what the consent page's own POST /oauth/consent answered, and Hosting's cut-off 504 there is the stack not answering (SPEC §23).

/**
 * Two halves. With a real browser, hermetic as oauth-receiver.test.mjs: a
 * 24-port block is claimed through the machine-wide lock directory and a fake
 * local target is built on it, with a stand-in consent page on its Hosting
 * port. Like app/src/pages/Connect.tsx, the stand-in POSTs /oauth/consent
 * `{action: "describe", params}` as it loads, shows Approve, and on the press
 * POSTs `{action: "approve", params}`; it leaves with `location.assign` only
 * on a 2xx `{redirect}`, and otherwise shows "failed". The stand-in's server
 * answers the approve as `params.mode` says: 200 with the redirect, 500, held
 * open until the test releases it, or the socket destroyed (no answer at all).
 * A "raw" button POSTs a body that is not JSON, answered 400.
 *
 * Hosting's cut-off takes a minute, so the cut-off half runs without a
 * browser: a fake page whose context is an EventEmitter emitting Playwright-
 * shaped request and response events, under node:test's mock timers (Date
 * and setTimeout), and the error goes through lib/test.mjs's judges as a case
 * failure would. Needs Chrome.
 */

import { after, before, mock, test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { E2E_TMP, ensureDir } from "../lib/paths.mjs";
import { allocateBlock } from "../lib/ports.mjs";
import { BrowserPool } from "../lib/browser.mjs";
import { startReceiver } from "../lib/oauth.mjs";
import { onAnsweringStack, pageStall, stackDidNotAnswer } from "../lib/test.mjs";

const LEAD = "no redirect reached the receiver within";
const CUT = "Hosting's cut-off for a function that has not answered";

/** The stand-in consent page: describe on load, Approve posts approve with `mode`, Raw posts a body that is not JSON. */
const PAGE = (q) => `<!doctype html><title>consent stand-in</title><link rel="icon" href="data:,"><p id="out">loading</p>
<script>
const params = { redirect_uri: ${JSON.stringify(q.get("redirect_uri"))}, mode: ${JSON.stringify(q.get("mode") ?? "200")} };
const out = document.getElementById("out");
const post = (action) => fetch("/oauth/consent", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, params }) });
(async () => {
  await post("describe");
  out.textContent = "ready";
  const approve = document.createElement("button");
  approve.textContent = "Approve";
  approve.onclick = async () => {
    try {
      const res = await post("approve");
      if (!res.ok) { out.textContent = "failed " + res.status; return; }
      location.assign((await res.json()).redirect);
    } catch (e) { out.textContent = "failed network"; }
  };
  const raw = document.createElement("button");
  raw.textContent = "Raw";
  raw.onclick = async () => {
    const res = await fetch("/oauth/consent", { method: "POST", headers: { "content-type": "text/plain" }, body: "not json" });
    out.textContent = "failed " + res.status;
  };
  document.body.append(approve, raw);
})();
</script>`;

let dir;
let block;
let server;
let target;
const held = []; // approve POSTs held open: {res, redirectUri}

before(async () => {
  dir = mkdtempSync(join(ensureDir(E2E_TMP, "E2E_TMP"), "selftest-consent-"));
  block = await allocateBlock({ runId: `selftest-consent-${process.pid}` });
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/stand-in") {
      res.setHeader("content-type", "text/html; charset=utf-8");
      return res.end(PAGE(url.searchParams));
    }
    if (url.pathname !== "/oauth/consent" || req.method !== "POST") return res.writeHead(404).end();
    let text = "";
    for await (const chunk of req) text += chunk;
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      return res.writeHead(400, { "content-type": "application/json" }).end('{"error":"invalid_request"}');
    }
    const json = (status, value) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
    if (body.action === "describe") return json(200, { valid: true });
    const { mode, redirect_uri: redirectUri } = body.params;
    if (mode === "hold") return void held.push({ res, redirectUri });
    if (mode === "abort") return void req.socket.destroy();
    if (mode === "200") return json(200, { redirect: `${redirectUri}?code=c-secret&state=s1` });
    return json(Number(mode), { error: "server_error" });
  });
  await new Promise((r) => server.listen(block.named.hosting, "127.0.0.1", r));
  target = { kind: "local", runId: `selftest-consent-${process.pid}`, runDir: dir, origin: `http://127.0.0.1:${block.named.hosting}`, stack: { ports: block.named }, capabilities: new Set(["local"]) };
});

const pools = [];
const user = async (name) => {
  const p = new BrowserPool({ target });
  pools.push(p);
  return p.user({ name });
};
after(async () => {
  for (const h of held.splice(0)) h.res.destroy();
  await Promise.all(pools.map((p) => p.close()));
  if (server) await new Promise((r) => server.close(r));
  block?.release();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** What `p` rejects with (it must reject). */
async function rejection(p) {
  try {
    await p;
  } catch (err) {
    return err;
  }
  assert.fail("expected a rejection");
}

/** Open the stand-in for `redirectUri`, wait for its describe to be answered, press `button`, and wait until the page says `until` (when given). */
async function press(u, redirectUri, mode, { button = "Approve", until = null } = {}) {
  await u.goto(`/stand-in?${new URLSearchParams({ redirect_uri: redirectUri, mode })}`);
  await u.page.locator("#out", { hasText: "ready" }).waitFor({ timeout: 10_000 });
  await u.page.getByRole("button", { name: button, exact: true }).click();
  if (until) await u.page.locator("#out", { hasText: until }).waitFor({ timeout: 10_000 });
}

/** A row as a list, with the parts a test can know exactly. */
const shape = (r) => [r.method, r.path, r.action, r.state, r.status];

/** A peer page that got Hosting's cut-off 504 just now: evidence pageStall would take for a plain wait. */
const stalledCtx = () => ({ usersSoFar: [{ name: "peer", responses: [{ seq: 0, t: Date.now() - 60_005, at: Date.now(), ms: 60_005, method: "POST", url: "http://127.0.0.1:1/x", path: "/x", status: 504 }], log: { console: [], sdkProbes: [], requests: [] } }] });

// --- Hosting's cut-off, on mock timers ---------------------------------------
// First, before any browser exists: mock timers replace setTimeout and Date for the whole process.

/** A Playwright-shaped request and response, as the context's events carry them. */
function fakeRequest(url, body) {
  return { method: () => "POST", url: () => url, postData: () => (typeof body === "string" ? body : JSON.stringify(body)), failure: () => ({ errorText: "net::ERR_ABORTED" }) };
}
const fakeResponse = (req, status) => ({ request: () => req, status: () => status });

/** A page whose context emits what the test says, routes nothing, and never navigates. */
function fakePage() {
  const ctx = new EventEmitter();
  ctx.route = async () => {};
  ctx.unroute = async () => {};
  return { ctx, page: { context: () => ctx, url: () => "http://127.0.0.1:39999/connect", waitForURL: async () => {} } };
}

test("Hosting's 504 at its cut-off to the approve: `response` carries it, stackDidNotAnswer names it and onAnsweringStack ends the case INCONCLUSIVE; a quicker 504 is judged; other origins and other redirects are not this receiver's", async () => {
  const origin = "http://127.0.0.1:39999";
  for (const [answerMs, cut] of [[60_008, true], [2_000, false]]) {
    mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_800_000_000_000 });
    const { ctx, page } = fakePage();
    const r = await startReceiver({ target: { kind: "local", origin: `${origin}/` }, page, via: "route" });
    try {
      const params = { redirect_uri: r.redirectUri };
      const describe = fakeRequest(`${origin}/oauth/consent`, { action: "describe", params });
      ctx.emit("request", describe);
      ctx.emit("request", fakeRequest("http://elsewhere.test/oauth/consent", { action: "approve", params }));
      ctx.emit("request", fakeRequest(`${origin}/oauth/consent`, { action: "approve", params: { redirect_uri: "http://127.0.0.1:40001/callback" } }));
      ctx.emit("request", fakeRequest(`${origin}/oauth/token`, { action: "approve", params }));
      mock.timers.tick(300);
      ctx.emit("response", fakeResponse(describe, 200));
      const approve = fakeRequest(`${origin}/oauth/consent`, { action: "approve", params });
      ctx.emit("request", approve);
      const p = rejection(r.received(90_000));
      mock.timers.tick(answerMs);
      ctx.emit("response", fakeResponse(approve, 504));
      ctx.emit("requestfailed", approve); // a failure after the headers keeps the answer
      mock.timers.tick(90_000);
      const err = await p;
      assert.deepEqual(err.consent.map(shape), [["POST", "/oauth/consent", "describe", "answered", 200], ["POST", "/oauth/consent", "approve", "answered", 504]], "the other origin, the other redirect and /oauth/token are left out");
      assert.deepEqual([err.consent[0].ms, err.response.ms, err.response.t, err.response.at], [300, answerMs, 1_800_000_000_300, 1_800_000_000_300 + answerMs]);
      assert.equal(err.message, `${LEAD} 90000 ms; the page's POST /oauth/consent for this redirect: describe 200 after 300 ms, approve 504 after ${answerMs} ms; the last answered 504, so the consent page had nowhere to go`);
      const ctxCase = { ev: { step() {}, text() {} } };
      if (cut) {
        assert.equal(stackDidNotAnswer(err), `POST /oauth/consent answered 504 after 60008 ms, ${CUT}`);
        const out = await rejection(onAnsweringStack(async () => { throw err; })(ctxCase));
        assert.equal(out.code, "E2E_INCONCLUSIVE");
        assert.equal(out.reason, `the stack did not answer, so nothing was measured: POST /oauth/consent answered 504 after 60008 ms, ${CUT}`);
        assert.equal(out.cause, err);
      } else {
        assert.equal(stackDidNotAnswer(err), null, "a 504 before the cut-off is an answer");
        assert.equal(await rejection(onAnsweringStack(async () => { throw err; })(ctxCase)), err, "and the failure stands");
      }
    } finally {
      mock.timers.reset();
      await r.close();
    }
    assert.equal(ctx.listenerCount("request"), 0, "closed: nothing left on the context");
  }
});

test("past six POSTs the message names the latest six and counts the rest; `consent` keeps them all", async () => {
  const origin = "http://127.0.0.1:39999";
  const { ctx, page } = fakePage();
  const r = await startReceiver({ target: { kind: "local", origin }, page, via: "route" });
  try {
    const params = { redirect_uri: r.redirectUri };
    for (let i = 0; i < 8; i++) {
      const req = fakeRequest(`${origin}/oauth/consent`, { action: i === 7 ? "approve" : "describe", params });
      ctx.emit("request", req);
      ctx.emit("response", fakeResponse(req, i === 7 ? 401 : 200));
    }
    const err = await rejection(r.wait(20));
    assert.match(err.message, /; the page's POST \/oauth\/consent for this redirect: 2 earlier, then (describe 200 after \d+ ms, ){5}approve 401 after \d+ ms; the last answered 401, so the consent page had nowhere to go$/);
    assert.deepEqual([err.consent.length, err.response.status], [8, 401]);
  } finally {
    await r.close();
  }
});

// --- With a real browser -------------------------------------------------------

test("a 500 to the approve: the timeout names describe and approve, carries both rows as `consent` and the 500 as `response`, so it is judged and never excused as a wait", async () => {
  const u = await user("refused");
  const r = await startReceiver({ target, page: u });
  try {
    await press(u, r.redirectUri, "500", { until: "failed 500" });
    const err = await rejection(r.received(1_500));
    assert.equal(err.code, "E2E_OAUTH_TIMEOUT");
    assert.match(err.message, /^no redirect reached the receiver within 1500 ms; the page's POST \/oauth\/consent for this redirect: describe 200 after \d+ ms, approve 500 after \d+ ms; the last answered 500, so the consent page had nowhere to go$/);
    assert.ok(!err.message.includes("127.0.0.1") && !err.message.includes("c-secret"), "never an origin or a query");
    assert.deepEqual(err.consent.map(shape), [["POST", "/oauth/consent", "describe", "answered", 200], ["POST", "/oauth/consent", "approve", "answered", 500]]);
    for (const row of err.consent) {
      assert.ok(Number.isFinite(row.ms) && row.ms >= 0 && row.ms < 10_000, `ms measured: ${row.ms}`);
      assert.ok(row.t <= row.at && row.at - row.t === row.ms, "t, at and ms agree");
      assert.equal(row.failure, null);
    }
    assert.ok(err.consent[0].t <= err.consent[1].t, "oldest first");
    assert.equal(err.response, err.consent[1], "the refusing answer is `response`");
    assert.equal(stackDidNotAnswer(err), null, "a quick 500 is the product's answer");
    const plain = Object.assign(new Error(`${LEAD} 1500 ms`), { code: "E2E_OAUTH_TIMEOUT" });
    assert.match(pageStall(plain, stalledCtx()) ?? "", /cut-off 504/, "control: the same evidence excuses a plain wait");
    assert.equal(pageStall(err, stalledCtx()), null, "but never an error carrying the answer it refused");
  } finally {
    await r.close();
  }
});

test("an approve held unanswered: named 'unanswered after N ms', no `response`, still a wait the page-stall judge reads; the late answer still delivers", async () => {
  const u = await user("held");
  const r = await startReceiver({ target, page: u, via: "route" });
  try {
    const before = held.length;
    await press(u, r.redirectUri, "hold");
    for (let i = 0; i < 200 && held.length === before; i++) await new Promise((res) => setTimeout(res, 25));
    assert.equal(held.length, before + 1, "the server holds the approve");
    const err = await rejection(r.received(1_500));
    assert.match(err.message, /^no redirect reached the receiver within 1500 ms; the page's POST \/oauth\/consent for this redirect: describe 200 after \d+ ms, approve unanswered after (\d+) ms$/);
    assert.deepEqual(err.consent.map(shape), [["POST", "/oauth/consent", "describe", "answered", 200], ["POST", "/oauth/consent", "approve", "sent", null]]);
    const pending = err.consent[1];
    assert.ok(pending.ms >= 1_000 && pending.ms < 15_000, `an unanswered row's ms is its wait so far: ${pending.ms}`);
    assert.equal(Number(/unanswered after (\d+) ms/.exec(err.message)[1]), Math.round(pending.ms));
    assert.equal(pending.at, null);
    assert.equal("response" in err, false, "no answer, nothing refused");
    assert.match(pageStall(err, stalledCtx()) ?? "", /a wait ran out .*no redirect reached the receiver within 1500 ms/, "still a wait, read by its length");
    assert.equal(pageStall(err, { usersSoFar: [] }), null, "and only with a page's evidence");

    const h = held.splice(before, 1)[0];
    h.res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ redirect: `${h.redirectUri}?code=late&state=s2` }));
    assert.equal((await r.received(10_000)).code, "late", "a timeout does not spend the receiver");
  } finally {
    await r.close();
  }
});

test("an approve whose connection is cut: 'failed (net::…)', no status, no `response`", async () => {
  const u = await user("cut");
  const r = await startReceiver({ target, page: u });
  try {
    await press(u, r.redirectUri, "abort", { until: "failed network" });
    const err = await rejection(r.wait(800));
    assert.match(err.message, /; the page's POST \/oauth\/consent for this redirect: describe 200 after \d+ ms, approve failed \(net::[A-Z_]+\) after \d+ ms$/);
    assert.deepEqual(err.consent.map(shape), [["POST", "/oauth/consent", "describe", "answered", 200], ["POST", "/oauth/consent", "approve", "failed", null]]);
    assert.match(err.consent[1].failure, /^net::[A-Z_]+$/);
    assert.equal("response" in err, false);
  } finally {
    await r.close();
  }
});

test("a body that is not JSON is kept with action null, and its 400 is a refusal; a 2xx approve redirects as it always did", async () => {
  const u = await user("raw");
  const r = await startReceiver({ target, page: u });
  try {
    await press(u, r.redirectUri, "200", { button: "Raw", until: "failed 400" });
    const err = await rejection(r.wait(500));
    assert.match(err.message, /: describe 200 after \d+ ms, \(no action\) 400 after \d+ ms; the last answered 400, so the consent page had nowhere to go$/);
    assert.deepEqual(err.consent.map(shape), [["POST", "/oauth/consent", "describe", "answered", 200], ["POST", "/oauth/consent", null, "answered", 400]]);
    assert.equal(err.response.status, 400, "a 4xx leaves the page nowhere to go too");
    await press(u, r.redirectUri, "200");
    const got = await r.received(10_000);
    assert.deepEqual([got.code, got.state], ["c-secret", "s1"]);
  } finally {
    await r.close();
  }
});

test("two receivers on one page each name only their own POSTs; they share one set of listeners, gone with the last close; a raw Page works too", async () => {
  const u = await user("two");
  const count = () => ["request", "response", "requestfailed"].map((e) => u.context.listenerCount(e));
  const base = count();
  const a = await startReceiver({ target, page: u, via: "route" });
  const b = await startReceiver({ target, page: u.page, via: "route" });
  try {
    assert.deepEqual(count(), base.map((n) => n + 1), "one listener per event for both receivers");
    await press(u, a.redirectUri, "500", { until: "failed 500" });
    const errB = await rejection(b.wait(300));
    assert.equal(errB.message, `${LEAD} 300 ms; the page sent no POST /oauth/consent for this redirect after the receiver started`);
    assert.deepEqual([errB.consent, "response" in errB], [[], false]);
    const errA = await rejection(a.wait(300));
    assert.deepEqual(errA.consent.map((x) => x.action), ["describe", "approve"]);
    await a.close();
    assert.deepEqual(count(), base.map((n) => n + 1), "still watching for b");
  } finally {
    await a.close();
    await b.close();
  }
  assert.deepEqual(count(), base, "the last close detached them");
  await press(u, a.redirectUri, "500", { until: "failed 500" });
  assert.equal((await rejection(a.wait(200))).consent.length, 2, "a closed receiver records nothing more");
});

test("without a page nothing is watched: `consent` is null and the message is the one it always was", async () => {
  const r = await startReceiver({ port: 0 });
  try {
    const err = await rejection(r.wait(50));
    assert.equal(err.message, `${LEAD} 50 ms`);
    assert.deepEqual([err.code, err.consent, "response" in err], ["E2E_OAUTH_TIMEOUT", null, false]);
  } finally {
    await r.close();
  }
});
