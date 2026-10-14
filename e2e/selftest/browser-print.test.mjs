// SPDX-License-Identifier: Apache-2.0
// Self-test: User.capturePrint records what the app hands to print() and nothing else, printRenderer renders under print media and judges by pixels, and lib/png.mjs decodes as Chrome does (SPEC §12, §20).

/**
 * Hermetic: a local server stands in for the viewer. Its page has the reading
 * frame (`iframe.doc-frame`), a More menu, and a printDoc that does what
 * app/src/export/pdf.ts does: append an iframe sandboxed `allow-same-origin
 * allow-modals`, write the snapshot into it, wait, call its print(), remove
 * it 1.5 s later. Before the print it marks the frame's body
 * `data-late`, after it `data-after`, so a snapshot taken at the write, or
 * after the call, is told from one taken AT the call. Variants: the frame
 * inside a wrapper element, a frame sandboxed without allow-same-origin
 * (unhookable), two print frames, a reading-frame remount in the middle, an
 * error toast instead of a frame, a navigation instead of a print. Needs
 * Chrome.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { BrowserPool, PRINT_KEY, PRINT_PAGE } from "../lib/browser.mjs";
import { colourPixels, pngPixels } from "../lib/png.mjs";
import { expectedRgba, randomPng, sameBytes } from "./helpers/png-encode.mjs";

const SNAPSHOT = `<!DOCTYPE html>
<html><head><title>Snapshot one</title><style>.bshd-print-mark{color:#b02318}</style></head>
<body><div class="bshd-print-mark" style="display: block !important; position: fixed !important;">LABEL</div><p id="c">Content</p></body></html>`;

const APP = `<!doctype html><html><head><style>
body{margin:0;font:14px sans-serif}
.viewer-toolbar{height:40px}
[role="menu"]{position:absolute;left:10px;top:40px;background:#fff;border:1px solid #888}
</style></head><body>
<div class="viewer-toolbar"><button type="button" aria-label="More actions" id="more">More</button></div>
<div id="menu-slot"></div>
<div class="viewer-body"><div id="stage"><iframe class="doc-frame" sandbox="allow-same-origin" src="/content/d-one/v1/index.html" style="width:600px;height:300px"></iframe></div></div>
<div id="wrapper-slot"></div>
<div class="toast-stack"></div>
<button id="print" type="button">print</button>
<script>
  const q = new URLSearchParams(location.search);
  const SNAP = ${JSON.stringify(SNAPSHOT)};
  window.marks = [];
  async function printDoc({ sandbox = "allow-same-origin allow-modals", wrap = false } = {}) {
    const frame = document.createElement("iframe");
    frame.setAttribute("aria-hidden", "true");
    frame.setAttribute("sandbox", sandbox);
    frame.className = "print-frame";
    frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden;";
    if (wrap) {
      const w = document.createElement("div");
      w.appendChild(frame);
      document.getElementById("wrapper-slot").appendChild(w);
    } else {
      document.body.appendChild(frame);
    }
    let fdoc = null;
    try { fdoc = frame.contentDocument; } catch {}
    if (fdoc) { fdoc.open(); fdoc.write(SNAP); fdoc.close(); }
    await new Promise((r) => setTimeout(r, 120));
    try { fdoc?.body.setAttribute("data-late", "1"); } catch {}
    await new Promise((r) => setTimeout(r, 130));
    try {
      frame.contentWindow?.focus();
      frame.contentWindow?.print();
      try { fdoc?.body.setAttribute("data-after", "1"); } catch {}
    } finally {
      setTimeout(() => frame.remove(), 1500);
    }
  }
  window.printDoc = printDoc;
  const remountReadingFrame = () => {
    const old = document.querySelector("iframe.doc-frame");
    const f = old.cloneNode();
    old.replaceWith(f);
  };
  document.getElementById("print").addEventListener("click", () => {
    const v = q.get("v");
    if (v === "toast") {
      const t = document.createElement("div");
      t.className = "toast toast-error";
      t.setAttribute("role", "alert");
      t.innerHTML = "<span>Could not open a print view.</span>";
      document.querySelector(".toast-stack").appendChild(t);
      return;
    }
    if (v === "navigate") { setTimeout(() => location.assign("/?v=after-navigation"), 50); return; }
    if (v === "two") { remountReadingFrame(); void printDoc({ wrap: true }); setTimeout(() => void printDoc(), 400); return; }
    if (v === "unhookable") { void printDoc({ sandbox: "allow-modals" }); return; }
    void printDoc();
  });
  // A More menu, as app/src/components/Menu.tsx renders it.
  document.getElementById("more").addEventListener("click", () => {
    const slot = document.getElementById("menu-slot");
    if (slot.firstChild) { slot.innerHTML = ""; return; }
    slot.innerHTML = '<div role="menu" aria-label="More actions"><div class="menu-label">Export</div><button role="menuitem" type="button">Print or save as PDF</button></div>';
    slot.querySelector('[role="menuitem"]').addEventListener("click", () => { slot.innerHTML = ""; void printDoc(); });
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") document.getElementById("menu-slot").innerHTML = ""; });
</script></body></html>`;

const DOC = `<!doctype html><html><body><p>The reading frame's document.</p></body></html>`;

let server;
let target;
before(async () => {
  server = http.createServer((req, res) => {
    const path = new URL(req.url, "http://x").pathname;
    res.setHeader("content-type", "text/html");
    if (path === "/") return res.end(APP);
    if (path.startsWith("/content/d-one/")) return res.end(DOC);
    res.statusCode = 404;
    res.end("no");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  target = { kind: "local", runId: "selftest-print", origin: `http://127.0.0.1:${port}`, stack: { ports: { hosting: port } }, capabilities: new Set(["local"]) };
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

test("capturePrint records the frame printDoc writes, its sandbox, and its document AT the print() call", async () => {
  const u = await app();
  try {
    const rec = await u.capturePrint(() => u.page.locator("#print").click(), {
      extract: (doc, arg) => ({ first: doc.body.firstElementChild.className, priority: doc.body.firstElementChild.style.getPropertyPriority(arg.prop), late: doc.body.getAttribute("data-late") }),
      arg: { prop: "display" },
    });
    assert.equal(rec.frames.length, 1);
    const [f] = rec.frames;
    assert.deepEqual({ sandbox: f.sandbox, className: f.className, printed: f.printed, hookError: f.hookError, snaps: f.snaps.length }, { sandbox: "allow-same-origin allow-modals", className: "print-frame", printed: 1, hookError: null, snaps: 1 });
    assert.ok(f.hooks >= 1, `the recorder was installed (${f.hooks} times)`);
    const [s] = f.snaps;
    assert.equal(s.error, null);
    assert.equal(s.title, "Snapshot one");
    assert.ok(s.html.startsWith("<!DOCTYPE html>\n<html><head><title>Snapshot one</title>"), s.html.slice(0, 80));
    assert.match(s.html, /<body data-late="1"><div class="bshd-print-mark"/, "the document as it was at the call: marked before it");
    assert.doesNotMatch(s.html, /data-after/, "and not after it");
    assert.deepEqual(s.extra, { first: "bshd-print-mark", priority: "important", late: "1" }, "extract ran in the page at the call");
    assert.equal(s.extractError, null);
    assert.ok(s.t >= rec.armedAt && f.t >= rec.armedAt);

    // Disarmed once it resolved: a frame added now keeps the browser's own print().
    const own = await u.page.evaluate(async (key) => {
      const fr = document.createElement("iframe");
      document.body.appendChild(fr);
      await new Promise((r) => setTimeout(r, 100)); // past the observer's callback, were it still connected
      const native = /\[native code\]/.test(Function.prototype.toString.call(fr.contentWindow.print));
      fr.remove();
      return { native, frames: window[Symbol.for(key)].rec.frames.length };
    }, PRINT_KEY);
    assert.deepEqual(own, { native: true, frames: 1 }, "no hook and no row after the capture");
  } finally {
    await u.close();
  }
});

test("a More-menu label is chosen, and an extract written as a method works", async () => {
  const u = await app();
  try {
    const rec = await u.capturePrint("Print or save as PDF", { extract: { pick(doc) { return doc.querySelector("#c").textContent; } }.pick });
    assert.deepEqual(rec.frames.map((f) => [f.sandbox, f.printed, f.snaps[0].extra]), [["allow-same-origin allow-modals", 1, "Content"]]);
  } finally {
    await u.close();
  }
});

test("frames: 2 waits for both print frames, one of them inside a wrapper; a remounted reading frame is not a row", async () => {
  const u = await app("?v=two");
  try {
    const rec = await u.capturePrint(() => u.page.locator("#print").click(), { frames: 2 });
    assert.deepEqual(rec.frames.map((f) => [f.index, f.className, f.printed]), [[0, "print-frame", 1], [1, "print-frame", 1]], "two print frames, the reading frame's remount not among them");
    assert.equal(await u.page.locator("iframe.doc-frame").count(), 1, "the reading frame was remounted meanwhile");
  } finally {
    await u.close();
  }
});

test("a frame it cannot reach times out with hookError; an error toast fails at once; a navigation is said", async () => {
  const u = await app("?v=unhookable");
  try {
    const err = await u.capturePrint(() => u.page.locator("#print").click(), { timeout: 2_000 }).then(() => null, (e) => e);
    assert.ok(err, "it did not resolve");
    assert.match(err.message, /no print from the action within 2000 ms: 1 frame\(s\) added/);
    assert.equal(err.record.frames[0].sandbox, "allow-modals");
    assert.match(err.record.frames[0].hookError, /cross-origin|Blocked|denied|SecurityError/i);
  } finally {
    await u.close();
  }
  const t = await app("?v=toast");
  try {
    const t0 = Date.now();
    await assert.rejects(t.capturePrint(() => t.page.locator("#print").click(), { timeout: 20_000 }), /no print from the action: the app said "Could not open a print view\."/);
    assert.ok(Date.now() - t0 < 5_000, "at once");
  } finally {
    await t.close();
  }
  const n = await app("?v=navigate");
  try {
    await assert.rejects(n.capturePrint(() => n.page.locator("#print").click(), { timeout: 10_000 }), /the page navigated during capturePrint/);
  } finally {
    await n.close();
  }
  const v = await app();
  try {
    await assert.rejects(v.capturePrint(null), /capturePrint takes a More-menu label or a function/);
    await assert.rejects(v.capturePrint(() => {}, { frames: 0 }), /frames is a positive integer/);
    await assert.rejects(v.capturePrint(() => {}, { extract: "doc.title" }), /extract is a function/);
    await assert.rejects(v.capturePrint(() => {}, { extract: Math.max }), /extract is a function written in the spec/);
  } finally {
    await v.close();
  }
});

const RED = [0xb0, 0x23, 0x18];
/** A stamp in the top-right corner and, in the same corner, the author's own solid red block. */
const RENDERED = (stampStyle) => `<!DOCTYPE html><html><head><style>
  body { margin: 0; font: 16px sans-serif; }
  .stamp { display: none !important; visibility: hidden !important; }
  #only-print { display: none; }
  @media print { #only-print { display: block; } }
  #block { position: absolute; top: 40px; right: 30px; width: 40px; height: 20px; background: rgb(176, 35, 24); }
</style></head><body>
<div class="stamp" style="${stampStyle}">CONFIDENTIAL</div>
<div id="block"></div>
<p id="only-print">printed only</p>
<img src="http://e2e-render.invalid/never.png" alt="">
</body></html>`;
const VISIBLE = "display: block !important; visibility: visible !important; position: fixed !important; top: 0; right: 0; padding: 6px 12px; color: #b02318 !important; font: 700 14px/1 sans-serif !important; letter-spacing: 0.1em";

test("printRenderer: print media, computed styles, the stamp's pixels against the render without it, and no network", async () => {
  pool ??= new BrowserPool({ target });
  const r = await pool.printRenderer();
  try {
    assert.deepEqual([r.width, r.height, r.media], [PRINT_PAGE.width, PRINT_PAGE.height, "print"]);
    const corner = { label: { x: PRINT_PAGE.width - 300, y: 0, w: 300, h: 80, color: RED } };
    const out = await r.render(RENDERED(VISIBLE), {
      computed: { selector: ".stamp, #only-print", properties: ["display", "visibility", "color"] },
      probe: (page) => page.evaluate(() => matchMedia("print").matches),
      without: ".stamp",
      regions: corner,
    });
    assert.deepEqual(out.elements.map((e) => [e.className ?? e.id, e.computed.display, e.computed.visibility, e.computed.color]), [
      ["stamp", "block", "visible", "rgb(176, 35, 24)"],
      ["only-print", "block", "visible", "rgb(0, 0, 0)"],
    ], "inline !important beats the author's !important; print media is live");
    assert.equal(out.elements[0].text, "CONFIDENTIAL");
    assert.equal(out.probed, true, "the probe ran in the page, under print media");
    assert.equal(out.removed, 1);
    assert.ok(Buffer.isBuffer(out.png) && Buffer.isBuffer(out.basePng));
    assert.deepEqual([pngPixels(out.png).width, pngPixels(out.png).height], [PRINT_PAGE.width, PRINT_PAGE.height], "one device pixel per CSS pixel");
    const p = out.pixels.label;
    assert.ok(p.count >= 20 && p.fill <= 0.6, `the stamp paints glyphs, not a box: ${JSON.stringify(p)}`);
    // The author's red block sits in the same corner: counted without the baseline, not with it.
    const all = colourPixels(out.png, { color: RED, region: { x: PRINT_PAGE.width - 300, y: 0, w: 300, h: 80 } });
    assert.ok(all.count >= p.count + 40 * 20 * 0.9, `without the baseline the block counts too: ${all.count} vs ${p.count}`);
    assert.deepEqual(out.blocked, ["http://e2e-render.invalid/never.png"], "the image was aborted, never fetched");

    const hidden = await r.render(RENDERED("display: none"), { without: ".stamp", regions: corner });
    assert.deepEqual([hidden.pixels.label.count, hidden.pixels.label.box], [0, null], "a hidden stamp paints nothing: the oracle can say so");

    const bare = await r.render(RENDERED(VISIBLE), { stripAuthorStyles: true, computed: { selector: ".stamp, #block", properties: ["display", "position"] } });
    assert.deepEqual(bare.elements.map((e) => [e.computed.display, e.computed.position]), [["block", "fixed"], ["block", "static"]], "no author CSS: the stamp's inline style stays, the block loses its author position");
    const styled = await r.render(RENDERED(VISIBLE), { computed: { selector: "#block", properties: ["position"] } });
    assert.equal(styled.elements[0].computed.position, "absolute", "the control: with the author CSS, it is positioned");
    assert.deepEqual([bare.png, bare.pixels, bare.probed, bare.removed], [null, null, null, null], "nothing asked, nothing taken");

    const narrow = await r.render(RENDERED(VISIBLE), { width: 500, height: 300, screenshot: true });
    assert.deepEqual([narrow.width, narrow.height, pngPixels(narrow.png).width, pngPixels(narrow.png).height], [500, 300, 500, 300]);

    await assert.rejects(r.render(RENDERED(VISIBLE), { regions: { a: { x: 0, y: 0, w: 1.5, h: 1 } } }), /region "a" is \{x, y, w, h\} in whole pixels/);
    await assert.rejects(r.render(RENDERED(VISIBLE), { computed: { selector: ".stamp" } }), /computed is \{selector, properties/);
    await assert.rejects(r.render(42), /html is a string/);
  } finally {
    await r.close();
  }
  const screen = await pool.printRenderer({ media: "screen", width: 400, height: 200 });
  try {
    const out = await screen.render(RENDERED(VISIBLE), { computed: { selector: "#only-print", properties: ["display"] } });
    assert.deepEqual(out.elements.map((e) => e.computed.display), ["none"], "screen media: the print-only rule is not live");
  } finally {
    await screen.close();
  }
  await assert.rejects(pool.printRenderer({ media: "paper" }), /media is "print", "screen" or null/);
});

test("pngPixels decodes as Chrome does: every filter and colour type, and Chrome's own screenshots", async () => {
  pool ??= new BrowserPool({ target });
  const page = await pool.parser();
  const chromeDecode = (png) =>
    page.evaluate(async (b64) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.width;
      c.height = img.height;
      const g = c.getContext("2d");
      g.drawImage(img, 0, 0);
      return Array.from(g.getImageData(0, 0, c.width, c.height).data);
    }, png.toString("base64"));
  const PALETTE = Array.from({ length: 16 }, (_, i) => [i * 16, 255 - i * 15, (i * 37) % 256]);
  // Opaque only: a canvas premultiplies alpha, so a translucent pixel does not come back exactly.
  const cases = [
    { colorType: 2, bitDepth: 8 }, { colorType: 0, bitDepth: 8 }, { colorType: 0, bitDepth: 1 }, { colorType: 0, bitDepth: 4 },
    { colorType: 3, bitDepth: 4, palette: PALETTE }, { colorType: 3, bitDepth: 8, palette: PALETTE },
    { colorType: 2, bitDepth: 16 }, { colorType: 0, bitDepth: 16 },
  ];
  for (const [i, c] of cases.entries()) {
    const o = { width: 17, height: 10, ...c, seed: 7 + i };
    const { samples, png } = randomPng(o);
    const ours = Array.from(pngPixels(png).data);
    const chrome = await chromeDecode(png);
    const want = Array.from(expectedRgba({ ...o, samples }));
    // 16-bit: Chrome may round where the high byte truncates; never by more than one.
    const tol = c.bitDepth === 16 ? 1 : 0;
    const off = ours.findIndex((v, k) => Math.abs(v - chrome[k]) > tol);
    assert.equal(off, -1, `colour type ${c.colorType} at ${c.bitDepth} bits: byte ${off} is ${ours[off]} here, ${chrome[off]} in Chrome`);
    sameBytes(ours, want, `colour type ${c.colorType} at ${c.bitDepth} bits: as encoded`);
  }
  const r = await pool.printRenderer({ width: 320, height: 200 });
  try {
    const shot = (await r.render(RENDERED(VISIBLE), { screenshot: true })).png;
    sameBytes(pngPixels(shot).data, await chromeDecode(shot), "a Chrome screenshot decodes to what Chrome decodes");
  } finally {
    await r.close();
  }
});
