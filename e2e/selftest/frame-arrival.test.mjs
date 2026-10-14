// SPDX-License-Identifier: Apache-2.0
// Self-test: armArrival/arrival/waitForArrival time a text's arrival in the document frame on the page's clock, in a frame that runs no script (SPEC §6b, §12).

/**
 * Hermetic: a local server stands in for the viewer in edit mode. The
 * document frame is `iframe.doc-frame` with `sandbox="allow-same-origin"` and
 * no allow-scripts, as the edit frame is: nothing runs inside it, so the
 * top page changes its DOM, as the app's editor binding does. The top page
 * has `put(id, text, ms)`, which appends `text` to the frame's `#id` after
 * `ms` and records when (`window.putAt[text]`, the page's Date.now()),
 * `remount()`, which replaces the iframe element, and `swapBody()`, which
 * replaces the frame's whole body. Needs Chrome.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { BrowserPool } from "../lib/browser.mjs";
import { ARRIVAL_KEY, armArrival, arrival, docFrame, waitForArrival } from "../lib/frame.mjs";

const DOC = `<!doctype html><html><head><script>document.documentElement.setAttribute("data-ran", "1")</script></head><body contenteditable="true"><p id="p1">First.</p><p id="p2">Second.</p><p id="p3">Third PRESENT.</p></body></html>`;

const APP = `<!doctype html><html><body>
<div class="viewer-body"><iframe class="doc-frame" sandbox="allow-same-origin" src="/doc" style="width:600px;height:300px"></iframe></div>
<script>
  const doc = () => document.querySelector("iframe.doc-frame").contentDocument;
  window.putAt = {};
  window.put = (id, text, ms = 0) => new Promise((resolve) => setTimeout(() => {
    doc().getElementById(id).append(text);
    window.putAt[text] = Date.now();
    resolve(window.putAt[text]);
  }, ms));
  window.remount = () => new Promise((resolve) => {
    const old = document.querySelector("iframe.doc-frame");
    const fresh = old.cloneNode(false);
    fresh.onload = () => resolve(true);
    old.replaceWith(fresh);
  });
  window.swapBody = (html) => { const d = doc(); const b = d.createElement("body"); b.innerHTML = html; d.body.replaceWith(b); };
</script></body></html>`;

const OPAQUE = `<!doctype html><html><body><div class="viewer-body"><iframe class="doc-frame" sandbox="" src="/doc"></iframe></div></body></html>`;

let server;
let target;
let pool = null;

before(async () => {
  server = http.createServer((req, res) => {
    const path = new URL(req.url, "http://x").pathname;
    res.setHeader("content-type", "text/html; charset=utf-8");
    if (path === "/doc") return res.end(DOC);
    if (path === "/opaque") return res.end(OPAQUE);
    if (path === "/none") return res.end("<!doctype html><body><div class=viewer-body>no frame</div></body>");
    res.end(APP);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  target = { kind: "local", runId: "selftest-arrival", origin: `http://127.0.0.1:${port}`, stack: { ports: { hosting: port } }, capabilities: new Set(["local"]) };
});

after(async () => {
  await pool?.close();
  await new Promise((r) => server.close(r));
});

async function user() {
  pool ??= new BrowserPool({ target });
  const u = await pool.user();
  await u.goto("/");
  await u.waitForFrame();
  return u;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("the time is when the text came, taken in the page, not when anyone looked; the frame runs no script and is left as it was", async () => {
  const u = await user();
  const f = await docFrame(u.page);
  assert.equal(await f.evaluate(() => document.documentElement.getAttribute("data-ran")), null, "the document's own script did not run: the frame runs none");
  const before = await f.evaluate(() => document.documentElement.outerHTML);
  const keysBefore = await u.page.evaluate(() => Object.keys(window).sort());
  const armed = await armArrival(u.page, "p2", "TOKEN-1");
  assert.deepEqual(Object.keys(armed).sort(), ["already", "armedAt"]);
  assert.equal(armed.already, false);
  assert.equal(await f.evaluate(() => document.documentElement.outerHTML), before, "arming added no node and no attribute to the document");
  assert.deepEqual(await u.page.evaluate(() => Object.keys(window).sort()), keysBefore, "and no string-keyed global to the page");
  assert.equal(await u.page.evaluate((k) => window[Symbol.for(k)] instanceof Map, ARRIVAL_KEY), true, "the probes live under Symbol.for(ARRIVAL_KEY)");

  // The reason the probe runs from the top page: an observer installed by evaluating IN this frame is never called.
  await f.evaluate(() => new MutationObserver(() => document.documentElement.setAttribute("data-inframe", "1")).observe(document, { childList: true, subtree: true, characterData: true }));
  const putAt = await u.page.evaluate(() => put("p2", " TOKEN-1", 50));
  await sleep(600); // anyone polling now would be 600 ms late
  const a = await arrival(u.page, "TOKEN-1");
  assert.deepEqual({ armed: a.armed, id: a.id, already: a.already, reloaded: a.reloaded }, { armed: true, id: "p2", already: false, reloaded: false });
  assert.ok(a.at >= armed.armedAt, "after it was armed");
  assert.ok(Math.abs(a.at - putAt) <= 5, `NEGATIVE CONTROL: the arrival is the insertion's time (${a.at - putAt} ms from it), not the read's, 600 ms later`);
  assert.deepEqual(await waitForArrival(u, "TOKEN-1", { timeout: 1000 }), a, "a User does as well as its Page; waitForArrival resolves at once");
  assert.equal(await f.evaluate(() => document.documentElement.getAttribute("data-inframe")), null, "pinned: the in-frame observer was never called (measured; why the probe is installed from the top page)");
});

test("only the text whole, and only in that element: elsewhere or in part it has not arrived", async () => {
  const u = await user();
  await armArrival(u.page, "p1", "SPLIT-TOKEN");
  await u.page.evaluate(() => put("p2", " SPLIT-TOKEN"));
  await u.page.evaluate(() => put("p1", " SPLIT-"));
  await sleep(100);
  assert.equal((await arrival(u.page, "SPLIT-TOKEN")).at, null, "NEGATIVE: not in #p2, and not half of it in #p1");
  const putAt = await u.page.evaluate(() => put("p1", "TOKEN", 20));
  const a = await waitForArrival(u.page, "SPLIT-TOKEN", { timeout: 5000 });
  assert.ok(Math.abs(a.at - putAt) <= 5, `when the second half made it whole (${a.at - putAt} ms)`);
});

test("a text already there is reported as such; re-arming replaces the earlier probe; a body replaced whole is still watched", async () => {
  const u = await user();
  const pre = await armArrival(u.page, "p3", "PRESENT");
  assert.equal(pre.already, true);
  const a = await arrival(u.page, "PRESENT");
  assert.deepEqual([a.at, a.already], [pre.armedAt, true], "already: at is when it was armed, and says so");

  await armArrival(u.page, "p1", "MOVED");
  await armArrival(u.page, "p2", "MOVED"); // replaces the probe on #p1
  await u.page.evaluate(() => put("p1", " MOVED"));
  await sleep(100);
  assert.equal((await arrival(u.page, "MOVED")).at, null, "the replaced probe on #p1 no longer counts");
  assert.equal((await arrival(u.page, "MOVED")).id, "p2");
  await u.page.evaluate(() => put("p2", " MOVED"));
  assert.equal((await waitForArrival(u.page, "MOVED", { timeout: 5000 })).id, "p2");

  await armArrival(u.page, "p9", "REBUILT");
  const t0 = Date.now();
  await u.page.evaluate(() => swapBody('<p id="p9">rebuilt from the wire REBUILT</p>'));
  const b = await waitForArrival(u.page, "REBUILT", { timeout: 5000 });
  assert.ok(b.at >= t0 - 50 && b.reloaded === false, "an element that did not exist when armed, in a body that replaced the old one, is seen");
});

test("a replaced frame or a navigated page is reported, never waited out; a text that never comes times out", async () => {
  const u = await user();
  await armArrival(u.page, "p1", "NEVER");
  await assert.rejects(waitForArrival(u.page, "NEVER", { timeout: 300 }), (e) => e.code === "E2E_ARRIVAL" && e.reason === "timeout" && /"NEVER" did not arrive in #p1 within 300 ms/.test(e.message) && e.arrival.armed === true);

  await armArrival(u.page, "p1", "LOST");
  await u.page.evaluate(() => remount());
  await u.waitForFrame();
  const r = await arrival(u.page, "LOST");
  assert.deepEqual([r.armed, r.at, r.reloaded], [true, null, true], "the probe watched the old document");
  await u.page.evaluate(() => put("p1", " LOST"));
  await assert.rejects(waitForArrival(u.page, "LOST", { timeout: 2000 }), (e) => e.reason === "reloaded" && /was replaced before "LOST" arrived in #p1/.test(e.message), "NEGATIVE: the new document's text is not taken for the old probe's");

  await armArrival(u.page, "p1", "KEPT");
  const putAt = await u.page.evaluate(() => put("p1", " KEPT"));
  await u.page.evaluate(() => remount());
  const k = await waitForArrival(u.page, "KEPT", { timeout: 2000 });
  assert.deepEqual([k.reloaded, Math.abs(k.at - putAt) <= 5], [true, true], "an arrival before the remount stands, flagged");

  await u.goto("/");
  await u.waitForFrame();
  assert.deepEqual(await arrival(u.page, "KEPT"), { armed: false, id: null, at: null, armedAt: null, already: false, reloaded: false });
  await assert.rejects(waitForArrival(u.page, "KEPT", { timeout: 2000 }), (e) => e.reason === "unarmed" && /arm it with armArrival first/.test(e.message));
});

test("arming refuses a page with no frame, a frame out of the page's reach, and bad arguments", async () => {
  const u = await user();
  await u.goto("/none");
  await assert.rejects(armArrival(u.page, "p1", "X"), /armArrival: no iframe\.doc-frame on the page/);
  await u.goto("/opaque");
  for (let i = 0; i < 100 && !u.page.frames().some((fr) => fr.url().endsWith("/doc")); i += 1) await sleep(50);
  await assert.rejects(armArrival(u.page, "p1", "X"), /has no document this page can reach/, "a sandbox without allow-same-origin is opaque to the page");
  await assert.rejects(armArrival(u.page, "", "X"), /id is an element id/);
  await assert.rejects(armArrival(u.page, "p1", ""), /text is a non-empty string/);
  await assert.rejects(arrival(u.page, 7), /text is a non-empty string/);
});
