// SPDX-License-Identifier: Apache-2.0
// Self-test: an arrival probe with no id (armArrival(page, null, text), probeArrivals({anywhere: true})) times text that lands in the SECOND copy of a doubled body, which a probe by #id never sees (SPEC §6b, §12).

/**
 * Hermetic: a local server stands in for the viewer in edit mode, as in
 * frame-arrival.test.mjs: `iframe.doc-frame` with `sandbox="allow-same-origin"`
 * and no allow-scripts, so nothing runs inside the document and the top page
 * changes its DOM. The document is DOUBLED (S1, S27): its paragraphs twice,
 * so two elements carry each id. `put(copy, id, text, ms)` appends `text` to
 * the `copy`th element with that id after `ms` and records when
 * (`window.putAt[text]`, the page's Date.now()).
 *
 * For probeArrivals two pages are relayed as two peers on one live document
 * whose bodies were doubled in opposite orders: whatever a person types into
 * a page's FIRST #e2e-2 (its own seed) is sent to the server, which puts it
 * at the end of every OTHER page's SECOND #e2e-2 (the copy it holds of that
 * seed). On the observer's screen the text is in the body, never in the
 * element getElementById("e2e-2") returns. Needs Chrome.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { BrowserPool } from "../lib/browser.mjs";
import { armArrival, arrival, docFrame, waitForArrival } from "../lib/frame.mjs";
import { probeArrivals } from "../lib/live.mjs";

const HALF = `<p id="e2e-1">First.</p><p id="e2e-2">Second.</p><p id="e2e-3">Third.</p>`;
const DOC = `<!doctype html><html><head><script>document.documentElement.setAttribute("data-ran", "1")</script></head><body contenteditable="true">${HALF}${HALF.replace("Second.", "Second, again. PRESENT")}</body></html>`;

const APP = `<!doctype html><html><body>
<div class="viewer-body"><span class="share-state" data-state="shared">Shared</span><iframe class="doc-frame" sandbox="allow-same-origin" src="/doc" style="width:600px;height:300px"></iframe></div>
<script>
  const me = Math.random().toString(36).slice(2);
  const doc = () => document.querySelector("iframe.doc-frame").contentDocument;
  const copy = (k, id) => doc().querySelectorAll('[id="' + id + '"]')[k];
  window.putAt = {};
  window.put = (k, id, text, ms = 0) => new Promise((resolve) => setTimeout(() => {
    copy(k, id).append(text);
    window.putAt[text] = Date.now();
    resolve(window.putAt[text]);
  }, ms));
  window.remount = () => new Promise((resolve) => {
    const old = document.querySelector("iframe.doc-frame");
    const fresh = old.cloneNode(false);
    fresh.onload = () => resolve(true);
    old.replaceWith(fresh);
  });
  // The relay: my FIRST #e2e-2, as typed, goes to every other page's SECOND #e2e-2.
  window.relayed = [];
  const relaying = new WeakSet();
  const relay = () => {
    const d = doc();
    if (!d || !d.URL.endsWith("/doc") || relaying.has(d)) return;
    relaying.add(d);
    d.addEventListener("input", () => fetch("/relay", { method: "POST", body: JSON.stringify({ from: me, text: copy(0, "e2e-2").textContent }) }), true);
  };
  document.querySelector("iframe.doc-frame").addEventListener("load", relay);
  if (doc()?.readyState === "complete") relay();
  new EventSource("/events").onmessage = (m) => {
    const { from, text } = JSON.parse(m.data);
    if (from === me) return;
    copy(1, "e2e-2").textContent = text;
    window.relayed.push(Date.now());
  };
</script></body></html>`;

let server;
let target;
let pool = null;
const listeners = new Set();

before(async () => {
  server = http.createServer((req, res) => {
    const path = new URL(req.url, "http://x").pathname;
    if (path === "/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
      res.write(": open\n\n");
      listeners.add(res);
      req.on("close", () => listeners.delete(res));
      return;
    }
    if (path === "/relay" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        for (const l of listeners) l.write(`data: ${body}\n\n`);
        res.end("ok");
      });
      return;
    }
    res.setHeader("content-type", "text/html; charset=utf-8");
    if (path === "/doc") return res.end(DOC);
    res.end(APP);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  target = { kind: "local", runId: "selftest-arrival-anywhere", origin: `http://127.0.0.1:${port}`, stack: { ports: { hosting: port } }, capabilities: new Set(["local"]) };
});

after(async () => {
  for (const l of listeners) l.end();
  await pool?.close();
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
});

async function user(name = null) {
  pool ??= new BrowserPool({ target });
  const u = await pool.user(name ? { name } : {});
  await u.goto("/");
  await u.waitForFrame();
  return u;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("text put into the SECOND copy of a doubled body: by #id it never arrives, anywhere it arrives, timed when it came, the frame left as it was", async () => {
  const u = await user();
  const f = await docFrame(u.page);
  assert.equal(await f.evaluate(() => document.querySelectorAll('[id="e2e-2"]').length), 2, "the body is doubled: two #e2e-2");
  assert.equal(await f.evaluate(() => document.documentElement.getAttribute("data-ran")), null, "the frame runs no script");
  const before = await f.evaluate(() => document.documentElement.outerHTML);
  const byId = await armArrival(u.page, "e2e-2", "TOKEN-A");
  const anywhere = await armArrival(u, null, "TOKEN-B");
  assert.deepEqual(Object.keys(anywhere).sort(), ["already", "armedAt"], "the same answer as an id's probe");
  assert.deepEqual([byId.already, anywhere.already], [false, false]);
  assert.equal(await f.evaluate(() => document.documentElement.outerHTML), before, "arming anywhere added no node and no attribute");

  await u.page.evaluate(() => put(1, "e2e-2", " TOKEN-A"));
  const putAt = await u.page.evaluate(() => put(1, "e2e-2", " TOKEN-B", 50));
  await sleep(600); // a poll now is 600 ms late
  const a = await arrival(u.page, "TOKEN-B");
  assert.deepEqual(Object.keys(a).sort(), ["already", "armed", "armedAt", "at", "id", "reloaded"], "the keys an id's probe has, no more");
  assert.deepEqual({ armed: a.armed, id: a.id, already: a.already, reloaded: a.reloaded }, { armed: true, id: null, already: false, reloaded: false });
  assert.ok(Math.abs(a.at - putAt) <= 5, `NEGATIVE CONTROL: the arrival is the insertion's time (${a.at - putAt} ms from it), not the read's`);
  assert.deepEqual(await waitForArrival(u, "TOKEN-B", { timeout: 1000 }), a);
  assert.equal((await arrival(u.page, "TOKEN-A")).at, null, "pinned, the gap this closes: by #e2e-2 the same kind of text in the second copy never arrives (getElementById returns the first)");
  await assert.rejects(waitForArrival(u.page, "TOKEN-A", { timeout: 300 }), (e) => e.reason === "timeout" && /"TOKEN-A" did not arrive in #e2e-2 within 300 ms/.test(e.message), "an id's message is unchanged");
});

test("anywhere: already there, whole text only, a replaced frame reported, a navigation unarms, and its own words when it times out", async () => {
  const u = await user();
  const pre = await armArrival(u.page, null, "PRESENT");
  assert.equal(pre.already, true, "already in the body (in the second copy) when armed");
  assert.deepEqual([(await arrival(u.page, "PRESENT")).at, (await arrival(u.page, "PRESENT")).already], [pre.armedAt, true]);

  await armArrival(u.page, null, "SPLIT-TOKEN");
  await u.page.evaluate(() => put(0, "e2e-1", " SPLIT-"));
  await sleep(100);
  assert.equal((await arrival(u.page, "SPLIT-TOKEN")).at, null, "NEGATIVE: half of it is not it");
  const putAt = await u.page.evaluate(() => put(0, "e2e-1", "TOKEN", 20));
  const w = await waitForArrival(u.page, "SPLIT-TOKEN", { timeout: 5000 });
  assert.ok(Math.abs(w.at - putAt) <= 5, `when the second half made it whole (${w.at - putAt} ms)`);

  await armArrival(u.page, null, "NEVER");
  await assert.rejects(waitForArrival(u.page, "NEVER", { timeout: 300 }), (e) => e.code === "E2E_ARRIVAL" && e.reason === "timeout" && /"NEVER" did not arrive anywhere in the frame's body within 300 ms/.test(e.message) && e.arrival.id === null);

  await armArrival(u.page, null, "LOST");
  await u.page.evaluate(() => remount());
  await u.waitForFrame();
  await u.page.evaluate(() => put(1, "e2e-2", " LOST"));
  await assert.rejects(waitForArrival(u.page, "LOST", { timeout: 2000 }), (e) => e.reason === "reloaded" && /was replaced before "LOST" arrived anywhere in the frame's body/.test(e.message), "NEGATIVE: the new document's text is not taken for the old probe's");

  await u.goto("/");
  await u.waitForFrame();
  assert.deepEqual(await arrival(u.page, "LOST"), { armed: false, id: null, at: null, armedAt: null, already: false, reloaded: false }, "no probe: the same answer as before");
});

test("arming refuses an id that is neither a non-empty string nor null (undefined included); null and a string are taken", async () => {
  const u = await user();
  for (const bad of [undefined, "", 7, false, {}]) {
    await assert.rejects(armArrival(u.page, bad, "X"), /armArrival: id is an element id \(a non-empty string\), or null for anywhere in the frame's body/, `id ${String(bad)}`);
  }
  await assert.rejects(armArrival(u.page, null, ""), /text is a non-empty string/);
  await armArrival(u.page, null, "X");
  await armArrival(u.page, "e2e-1", "Y");
});

test("probeArrivals({anywhere: true}) times a keystroke that lands in the other peer's SECOND copy; by #id the same keystroke never arrives", { timeout: 60_000 }, async () => {
  const typist = await user("p1");
  const peer = await user("p2");
  await peer.page.waitForFunction(() => typeof window.relayed === "object");
  await sleep(300); // both EventSources open
  const r = await probeArrivals([typist, peer], { from: typist, id: "e2e-2", text: "PROBE-ANY", timeoutMs: 10_000, anywhere: true });
  assert.equal(r.arrivals.length, 1);
  const [p2] = r.arrivals;
  assert.deepEqual([p2.name, p2.shared], ["p2", true]);
  assert.ok(Number.isFinite(p2.ms) && p2.ms >= 0 && p2.ms < 5000, `p2 saw it ${p2.ms} ms after the last keystroke`);
  const relayedAt = await peer.page.evaluate(() => window.relayed.at(-1));
  assert.ok(Math.abs(r.after + p2.ms - relayedAt) <= 5 || p2.ms === 0, `timed when the relay put it in (${r.after + p2.ms} vs ${relayedAt})`);
  assert.ok((await (await docFrame(peer.page)).evaluate(() => document.querySelectorAll('[id="e2e-2"]')[1].textContent)).includes("PROBE-ANY"), "it is in p2's second copy");

  const byId = await probeArrivals([typist, peer], { from: typist, id: "e2e-2", text: "PROBE-ID", timeoutMs: 1500 });
  assert.equal(byId.arrivals[0].ms, null, "NEGATIVE CONTROL: by #e2e-2 (anywhere left out, the old call) the same kind of keystroke never arrives: the gap c04 hit");
  await assert.rejects(probeArrivals([typist, peer], { from: typist, id: "e2e-2", text: "Z", anywhere: "yes" }), /probeArrivals: anywhere is a boolean/);
});

test("README states the anywhere probe and probeArrivals' anywhere", async () => {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { REPO_ROOT } = await import("../lib/paths.mjs");
  const readme = readFileSync(join(REPO_ROOT, "e2e", "README.md"), "utf8");
  for (const s of ["`armArrival(page, null, text)`", "anywhere in the frame's body", "`probeArrivals(users, {from, id, text, timeoutMs = 15_000, delay = 0, anywhere = false})`"]) {
    assert.ok(readme.includes(s), `README lacks ${JSON.stringify(s)}`);
  }
});
