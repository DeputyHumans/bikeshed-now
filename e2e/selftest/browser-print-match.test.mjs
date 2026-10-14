// SPDX-License-Identifier: Apache-2.0
// Self-test: capturePrint's `match` leaves out an iframe that is not a print frame, and printRenderer settles a page (fonts ready, two animation frames) before it reads or shoots it (SPEC §12, §20).

/**
 * Hermetic: a local server stands in for the viewer, as in
 * browser-print.test.mjs. Its printDoc appends a frame sandboxed
 * `allow-same-origin allow-modals`, writes a snapshot, and 250 ms later calls
 * print(). With `?v=capture`, 60 ms into the print it also appends what the
 * owner's thumbnail capture appends (app/src/viewer/capture.ts): a frame
 * sandboxed `allow-same-origin` alone, which never prints. The renderer's
 * pages count animation frames from their own load, so a render that
 * settled has seen at least two. Needs Chrome.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { BrowserPool, PRINT_KEY } from "../lib/browser.mjs";
import { colourPixels } from "../lib/png.mjs";

const SNAPSHOT = `<!DOCTYPE html><html><head><title>Snapshot</title></head><body><p id="c">Content</p></body></html>`;

const APP = `<!doctype html><html><head><style>body{margin:0;font:14px sans-serif}</style></head><body>
<div class="viewer-body"><iframe class="doc-frame" sandbox="allow-same-origin" src="/content/d-one/v1/index.html" style="width:600px;height:300px"></iframe></div>
<div class="toast-stack"></div>
<button id="print" type="button">print</button>
<script>
  const q = new URLSearchParams(location.search);
  const SNAP = ${JSON.stringify(SNAPSHOT)};
  window.captureFrames = [];
  function captureFrame() {
    const f = document.createElement("iframe");
    f.setAttribute("sandbox", "allow-same-origin");
    f.setAttribute("aria-hidden", "true");
    f.style.cssText = "position:fixed;left:-10000px;width:400px;height:300px";
    document.body.appendChild(f);
    window.captureFrames.push(f);
  }
  async function printDoc() {
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "allow-same-origin allow-modals");
    frame.className = "print-frame";
    frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden;";
    document.body.appendChild(frame);
    const d = frame.contentDocument;
    d.open(); d.write(SNAP); d.close();
    if (q.get("v") === "capture") setTimeout(captureFrame, 60);
    await new Promise((r) => setTimeout(r, 250));
    try { frame.contentWindow.print(); } finally { setTimeout(() => frame.remove(), 1500); }
  }
  document.getElementById("print").addEventListener("click", () => void printDoc());
</script></body></html>`;

let server;
let target;
before(async () => {
  server = http.createServer((req, res) => {
    const path = new URL(req.url, "http://x").pathname;
    res.setHeader("content-type", "text/html");
    if (path === "/") return res.end(APP);
    if (path.startsWith("/content/d-one/")) return res.end("<!doctype html><p>reading frame</p>");
    res.statusCode = 404;
    res.end("no");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  target = { kind: "local", runId: "selftest-print-match", origin: `http://127.0.0.1:${port}`, stack: { ports: { hosting: port } }, capabilities: new Set(["local"]) };
});
let pool = null;
after(async () => {
  await pool?.close();
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
});

async function app(search = "") {
  pool ??= new BrowserPool({ target });
  const u = await pool.user({ name: "printer" });
  await u.goto(`/${search}`);
  await u.waitForFrame();
  return u;
}

const PRINT_FRAME = '[sandbox~="allow-modals"]';

test("NEGATIVE (the failure measured in A17): a capture frame added mid-print holds capturePrint up until it times out, when nothing narrows what a print frame is", async () => {
  const u = await app("?v=capture");
  try {
    const err = await u.capturePrint(() => u.page.locator("#print").click(), { timeout: 2_000 }).then(() => null, (e) => e);
    assert.ok(err, "it did not resolve");
    assert.match(err.message, /no print from the action within 2000 ms: 2 frame\(s\) added \(1 wanted\)/);
    assert.deepEqual(err.record.frames.map((f) => [f.sandbox, f.printed]), [["allow-same-origin allow-modals", 1], ["allow-same-origin", 0]]);
  } finally {
    await u.close();
  }
});

test("capturePrint {match}: the print frame alone is a row; the capture frame is listed in `ignored`, never hooked, and waited for by nothing", async () => {
  const u = await app("?v=capture");
  try {
    const rec = await u.capturePrint(() => u.page.locator("#print").click(), { match: PRINT_FRAME, timeout: 5_000, extract: (doc) => doc.querySelector("#c").textContent });
    assert.deepEqual(rec.frames.map((f) => [f.index, f.sandbox, f.className, f.printed, f.snaps[0].extra]), [[0, "allow-same-origin allow-modals", "print-frame", 1, "Content"]]);
    await u.poll(() => u.page.evaluate(() => window.captureFrames.length === 1), { timeout: 5_000, what: "the capture frame" });
    const again = await u.page.evaluate((key) => window[Symbol.for(key)].rec.ignored, PRINT_KEY);
    assert.deepEqual(again.map((f) => [f.sandbox, f.className, f.src]), [["allow-same-origin", null, null]], "the capture frame, as it was added");
    const native = await u.page.evaluate(() => /\[native code\]/.test(Function.prototype.toString.call(window.captureFrames[0].contentWindow.print)));
    assert.equal(native, true, "the capture frame keeps the browser's own print()");
  } finally {
    await u.close();
  }
});

test("capturePrint {match}: a match the print frame fails times out naming what was ignored; a selector the page cannot parse, or one that is not a string, throws before anything runs", async () => {
  const u = await app();
  try {
    const err = await u.capturePrint(() => u.page.locator("#print").click(), { match: ".no-such-frame", timeout: 1_500 }).then(() => null, (e) => e);
    assert.match(err?.message ?? "", /no print from the action within 1500 ms: 0 frame\(s\) added \(1 wanted\) \[\]; 1 iframe\(s\) not matching \.no-such-frame ignored$/);
    assert.deepEqual(err.record.ignored.map((f) => f.sandbox), ["allow-same-origin allow-modals"]);
    let clicked = false;
    await assert.rejects(u.capturePrint(() => (clicked = true), { match: "[sandbox~=" }), /capturePrint match "\[sandbox~=" is not a selector the page can use/);
    await assert.rejects(u.capturePrint(() => (clicked = true), { match: "" }), /capturePrint match is a CSS selector a print frame matches, or null/);
    await assert.rejects(u.capturePrint(() => (clicked = true), { match: 3 }), /capturePrint match is a CSS selector/);
    assert.equal(clicked, false, "the action never ran");
  } finally {
    await u.close();
  }
});

/** A page that counts its own animation frames from its load, and paints a red block in the second frame after a `.gone` element is removed (the first is busy for 150 ms). */
const COUNTING = `<!DOCTYPE html><html><head><style>
  body { margin: 0; }
  #late { position: absolute; left: 10px; top: 10px; width: 60px; height: 40px; background: rgb(200, 20, 20); display: none; }
</style><script>
  window.frames_ = 0;
  addEventListener("load", () => {
    const tick = () => { window.frames_ += 1; requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    new MutationObserver(() => {
      if (document.querySelector(".gone")) return;
      // A first frame that is busy for 150 ms, then the block in the next one: a shot taken without
      // settling is taken in that first frame, before the block.
      requestAnimationFrame(() => {
        const t = performance.now();
        while (performance.now() - t < 150) {}
        requestAnimationFrame(() => { document.getElementById("late").style.display = "block"; });
      });
    }).observe(document.body, { childList: true, subtree: true });
  });
</script></head><body><div class="gone">x</div><div id="late"></div></body></html>`;

test("printRenderer render: settles before it reads, so the probe sees a page two animation frames on; the shot after `without` is two frames on as well (Playwright's own wait); settle: false does not settle", async () => {
  pool ??= new BrowserPool({ target });
  const r = await pool.printRenderer({ width: 200, height: 100 });
  try {
    const frames = (page) => page.evaluate(() => window.frames_);
    const RED = [200, 20, 20];
    const box = { x: 0, y: 0, w: 100, h: 70, color: RED };
    for (let i = 0; i < 5; i += 1) {
      const out = await r.render(COUNTING, { probe: frames, without: ".gone", regions: { late: box } });
      assert.equal(out.settled, true);
      assert.ok(out.probed >= 2, `two animation frames had passed before the probe (round ${i}: ${out.probed})`);
      // Not render's settle: Playwright's screenshot waits for this itself (render's header), pinned here so a change in it shows.
      assert.ok(colourPixels(out.basePng, { color: RED, region: { x: 0, y: 0, w: 100, h: 70 } }).count >= 60 * 40 * 0.9, `round ${i}: the shot after the removal is two frames on, the late block painted`);
    }
    const raw = await r.render(COUNTING, { probe: frames, settle: false });
    assert.equal(raw.settled, false, "settle: false is reported");
    await assert.rejects(r.render(COUNTING, { settle: "yes" }), /settle is true or false, got "yes"/);
  } finally {
    await r.close();
  }
});
