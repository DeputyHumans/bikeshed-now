// SPDX-License-Identifier: Apache-2.0
// Self-test: watchFor sees an element that was in the DOM for a single render, across a reload and a navigation, and nothing after stop (SPEC §12).

/**
 * Hermetic: a local server stands in for the viewer. Its page holds the
 * banner row `.viewer-banners` (app/src/components/ViewerBanners.tsx) and
 * puts a `.banner` there in ways a poll cannot catch: for exactly one
 * animation frame (`flash`), or only while the page loads (`?flash=` — added
 * by the page's own first script, removed one task later, with
 * `window.loadFlashGone` set once it has gone). `show`, `relabel`, `classify`
 * and `clear` change it in the other ways an element can start or stop
 * matching. Needs Chrome.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { BrowserPool } from "../lib/browser.mjs";

const NEWER = "A newer version has been published.";
const SEL = ".viewer-banners .banner";

const APP = `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;font:14px sans-serif}.banner{padding:8px;background:#ffd}.hidden{display:none}
</style></head><body>
<div class="viewer-banners"></div>
<p id="other">Not a banner.</p>
<script>
  const row = document.querySelector(".viewer-banners");
  const make = (text, cls = "banner") => {
    const b = document.createElement("div");
    b.className = cls;
    b.textContent = text;
    return b;
  };
  window.show = (text, cls) => row.appendChild(make(text, cls)) && true;
  window.clear = () => row.replaceChildren();
  window.relabel = (text) => { row.lastElementChild.firstChild.data = text; };
  window.classify = (cls) => { row.lastElementChild.className = cls; };
  // In the DOM for one animation frame: added in one, removed in the next.
  window.flash = (text) => new Promise((resolve) => {
    requestAnimationFrame(() => {
      const b = row.appendChild(make(text));
      requestAnimationFrame(() => { b.remove(); resolve(true); });
    });
  });
  // In the DOM only while the page loads, never after: the page's first script adds it.
  const q = new URLSearchParams(location.search).get("flash");
  if (q) {
    const b = row.appendChild(make(q));
    setTimeout(() => { b.remove(); window.loadFlashGone = true; }, 0);
  }
</script></body></html>`;

let server;
let target;
let pool = null;
let shared = null;

before(async () => {
  server = http.createServer((req, res) => {
    const path = new URL(req.url, "http://x").pathname;
    res.setHeader("content-type", "text/html; charset=utf-8");
    if (path === "/" || path === "/d/other") return res.end(APP);
    res.statusCode = 404;
    res.end("no");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  target = { kind: "local", runId: "selftest-watch", origin: `http://127.0.0.1:${port}`, stack: { ports: { hosting: port } }, capabilities: new Set(["local"]) };
});

/** One Chrome for the file; a fresh user per test, since a watch's init script stays on its page. */
async function user() {
  pool ??= new BrowserPool({ target });
  shared = await pool.user();
  await shared.goto("/");
  return shared;
}

after(async () => {
  await pool?.close();
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
});

/** As a spec's own helper did it: a MutationObserver installed by one evaluate, in the current document only. */
async function evaluateOnlyWatch(u) {
  await u.page.evaluate(({ sel, text }) => {
    window.__evalOnly = [];
    const seen = () => {
      for (const b of document.querySelectorAll(sel)) if (b.textContent.includes(text)) window.__evalOnly.push(b.textContent);
    };
    new MutationObserver(seen).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    seen();
  }, { sel: SEL, text: NEWER });
}

test("watchFor records a banner that was in the DOM for one animation frame, and when it went; it adds nothing to the page; NEGATIVE: a read once it has gone finds nothing", async () => {
  const u = await user();
  const before = await u.page.evaluate(() => document.documentElement.outerHTML);
  const w = await u.watchFor(SEL, NEWER);
  assert.equal(await u.page.evaluate(() => document.documentElement.outerHTML), before, "no node and no attribute added");
  assert.deepEqual(await w.sightings(), [], "nothing before the flash");

  const t0 = Date.now();
  await u.page.evaluate((text) => window.flash(text), NEWER);
  // NEGATIVE: what a poll reads after the fact.
  assert.equal(await u.page.locator(SEL).count(), 0, "a read after the flash finds nothing, so a poll cannot prove absence");

  const rows = await w.sightings();
  assert.equal(rows.length, 1, JSON.stringify(rows));
  const [r] = rows;
  assert.deepEqual({ seq: r.seq, doc: r.doc, gone: r.gone, path: r.path, text: r.text, visible: r.visible }, { seq: 0, doc: 1, gone: "removed", path: "/", text: NEWER, visible: true });
  assert.ok(r.t >= t0 - 5 && r.goneAt >= r.t && r.goneAt - r.t < 2_000, `seen at ${r.t - t0} ms, gone ${r.goneAt - r.t} ms later`);
  assert.deepEqual((await w.documents()).map((d) => [d.doc, d.path, d.via]), [[1, "/", "call"]]);

  // Present at the call: a sighting at once, still open.
  await u.page.evaluate((text) => window.show(text), NEWER);
  const w2 = await u.watchFor(SEL);
  const open = await w2.sightings();
  assert.deepEqual(open.map((x) => [x.text, x.gone, x.goneAt]), [[NEWER, null, null]], "an element present at the call is a row, with no goneAt");
  await u.close();
});

test("watchFor: the text narrows (a string or a RegExp), and a text, class or attribute change that makes an element match is a sighting, as is the change that unmakes it", async () => {
  const u = await user();
  const w = await u.watchFor(SEL, NEWER);
  const wre = await u.watchFor(SEL, /^Open v\d+$/);
  const any = await u.watchFor(".viewer-banners .banner.urgent");

  await u.page.evaluate(() => window.show("Saved."));
  await u.page.evaluate(() => window.relabel("Open v3"));
  await u.page.evaluate((t) => window.relabel(t), NEWER);
  await u.page.evaluate(() => window.relabel("Something else"));
  await u.page.evaluate(() => window.clear());
  await u.page.evaluate((t) => window.show(t, "note"), NEWER);
  await u.page.evaluate(() => window.classify("banner"));
  await u.page.evaluate(() => window.classify("banner urgent"));
  await u.page.evaluate(() => window.classify("banner urgent hidden"));
  await u.page.evaluate(() => window.clear());

  const rows = await w.sightings();
  assert.deepEqual(rows.map((r) => [r.text, r.gone]), [[NEWER, "removed"], [NEWER, "removed"]], "the relabel into the text, then the class change into the selector");
  assert.deepEqual((await wre.sightings()).map((r) => r.text), ["Open v3"], "a RegExp over the text");
  const urgent = await any.sightings();
  assert.deepEqual(urgent.map((r) => [r.text, r.visible, r.gone]), [[NEWER, true, "removed"]], "one element, seen as it gained the class, visible then; hiding it later is not a new row");
  await u.close();
});

test("watchFor survives a reload and a navigation: a banner shown only while the new page loads is a row of that document, and one still shown when the page goes is closed by it; NEGATIVE: a watch installed by one evaluate never sees it", async () => {
  const u = await user();
  const w = await u.watchFor(SEL, NEWER);

  await u.goto(`/?flash=${encodeURIComponent(NEWER)}`);
  await u.poll(() => u.page.evaluate(() => window.loadFlashGone === true), { what: "the load-time banner to go" });
  await evaluateOnlyWatch(u);
  assert.deepEqual(await u.page.evaluate(() => window.__evalOnly), [], "NEGATIVE: installed once the page has loaded, it never sees the load-time banner");

  const rows = await w.sightings();
  assert.deepEqual(rows.map((r) => [r.doc, r.text, r.gone, r.path]), [[2, NEWER, "removed", "/"]], "seen in the reloaded document, before load ended");

  await u.page.evaluate((t) => window.show(t), NEWER);
  await u.goto("/d/other");
  const after = await w.sightings();
  assert.equal(after.length, 2, JSON.stringify(after));
  assert.deepEqual([after[1].doc, after[1].gone], [2, "navigation"], "still shown when its document went");
  const docs = await w.documents();
  assert.deepEqual(docs.map((d) => [d.doc, d.path, d.via]), [[1, "/", "call"], [2, "/", "load"], [3, "/d/other", "load"]]);
  assert.ok(after[1].goneAt >= after[1].t && after[1].goneAt <= docs[2].t + 5, "closed when the next document started");
  await u.close();
});

test("watchFor: stop() freezes the record, in this document and the next; two watches are independent; a bad selector or text throws before anything is installed", async () => {
  const u = await user();
  const a = await u.watchFor(SEL, NEWER);
  const b = await u.watchFor(SEL, NEWER);
  await u.page.evaluate((t) => window.flash(t), NEWER);
  const frozen = await a.stop();
  assert.equal(frozen.length, 1);
  await u.page.evaluate((t) => window.flash(t), NEWER);
  await u.goto(`/?flash=${encodeURIComponent(NEWER)}`);
  await u.poll(() => u.page.evaluate(() => window.loadFlashGone === true), { what: "the load-time banner to go" });
  assert.deepEqual(await a.sightings(), frozen, "nothing after stop, here or in the next document");
  assert.deepEqual(await a.stop(), frozen, "stop again: the same rows");
  assert.deepEqual((await b.sightings()).map((r) => r.doc), [1, 1, 2], "the other watch kept going");
  // The stopped watch's init script still runs in the new document, and is told to stop there.
  const states = () => u.page.evaluate(() => Object.keys(window).filter((k) => k.startsWith("__e2eWatch_")).map((k) => window[k].stopped).sort());
  await u.poll(async () => JSON.stringify(await states()) === "[false,true]", { what: "the new document's copy of the stopped watch to stop" });

  await assert.rejects(u.watchFor("div["), /watchFor selector "div\[" is not one querySelectorAll takes/);
  await assert.rejects(u.watchFor(""), /watchFor selector is a CSS selector, got ""/);
  await assert.rejects(u.watchFor(null), /watchFor selector is a CSS selector, got null/);
  await assert.rejects(u.watchFor(SEL, ""), /watchFor text is a non-empty string, a RegExp or null, got ""/);
  await assert.rejects(u.watchFor(SEL, 5), /watchFor text is a non-empty string, a RegExp or null, got 5/);
  await u.close();
});
