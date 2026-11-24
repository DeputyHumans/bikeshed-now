// SPDX-License-Identifier: Apache-2.0
// Self-test: the painted-highlight readers find a thread's passage in the frame's CSS.highlights, in document order, and where to click it (ADR 0043).

/**
 * Hermetic: a local server stands in for the viewer with one trusted frame
 * whose own script registers highlights as the viewer's painter names them —
 * a comment on the second paragraph, a suggestion on the first, the selected
 * thread's overlay, and a highlight of the document's own that is not ours.
 * Needs Chrome.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { BrowserPool } from "../lib/browser.mjs";
import { docFrame, paintedCount, paintedFor, paintedHighlights, paintedInOrder, paintedPoint, paintedText } from "../lib/frame.mjs";

const DOC = `<!doctype html><html><body style="margin:0;font:20px/1.5 sans-serif">
<section id="s1"><p id="p1">The first passage of the document.</p></section>
<section id="s2"><p id="p2">A second passage, further down.</p></section>
<script>
const over = (id, from, to) => { const r = document.createRange(); const t = document.getElementById(id).firstChild; r.setStart(t, from); r.setEnd(t, to); return r; };
CSS.highlights.set("bshd-hl-c-t2", new Highlight(over("p2", 2, 16)));
CSS.highlights.set("bshd-hl-s-t1", new Highlight(over("p1", 4, 9), over("p1", 10, 17)));
CSS.highlights.set("bshd-hl-selected", new Highlight(over("p2", 2, 16)));
CSS.highlights.set("their-own", new Highlight(over("p1", 0, 3)));
document.documentElement.setAttribute("data-ready", "1");
</script></body></html>`;

const PAGE = `<!doctype html><html><body><div class="viewer-body"><iframe class="doc-frame" src="/doc" style="width:600px;height:300px"></iframe></div></body></html>`;

let server;
let target;
let pool = null;

before(async () => {
  server = http.createServer((req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(new URL(req.url, "http://x").pathname === "/doc" ? DOC : PAGE);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  target = { kind: "local", runId: "selftest-frame-painted", origin: `http://127.0.0.1:${port}`, stack: { ports: { hosting: port } }, capabilities: new Set(["local"]) };
});

after(async () => {
  await pool?.close();
  await new Promise((r) => server.close(r));
});

async function frame() {
  pool ??= new BrowserPool({ target });
  const u = await pool.user();
  await u.goto("/");
  await u.waitForFrame();
  const f = await docFrame(u.page);
  await u.poll(() => f.evaluate(() => document.documentElement.getAttribute("data-ready") === "1"), { timeout: 10_000, what: "the frame registered its highlights" });
  return { u, f };
}

test("every highlight of ours, by name and text, and none of the document's own", { timeout: 60_000 }, async () => {
  const { f } = await frame();
  const rows = await paintedHighlights(f);
  assert.deepEqual(rows.map((r) => [r.name, r.text]), [
    ["bshd-hl-c-t2", "second passage"],
    ["bshd-hl-s-t1", "first"],
    ["bshd-hl-s-t1", "passage"],
    ["bshd-hl-selected", "second passage"],
  ]);
  assert.ok(rows.every((r) => r.rect && r.rect.width > 0), "each with its first line box");
});

test("a thread's passage by its id; the passages in document order, overlays left out; a count in a region", { timeout: 60_000 }, async () => {
  const { f } = await frame();
  assert.deepEqual((await paintedFor(f, "t1")).map((r) => r.text), ["first", "passage"]);
  assert.deepEqual((await paintedFor(f, "t2")).map((r) => r.text), ["second passage"]);
  assert.deepEqual(await paintedFor(f, "nobody"), []);
  assert.deepEqual((await paintedInOrder(f)).map((r) => r.text), ["first", "passage", "second passage"]);
  assert.equal(await paintedCount(f), 3);
  assert.equal(await paintedCount(f, "#s2"), 1);
  assert.equal(await paintedCount(f, "#nowhere"), 0);
  assert.equal(await paintedText(f), "firstpassagesecond passage");
});

test("where to click a painted passage: a point inside its line box; a passage that is not painted refuses", { timeout: 60_000 }, async () => {
  const { f } = await frame();
  const p = await paintedPoint(f, "second passage");
  const box = await f.evaluate(() => {
    const r = document.createRange();
    const t = document.getElementById("p2").firstChild;
    r.setStart(t, 2);
    r.setEnd(t, 16);
    const b = r.getClientRects()[0];
    return { left: b.left, right: b.right, top: b.top, bottom: b.bottom };
  });
  assert.ok(p.x >= box.left && p.x <= box.right && p.y >= box.top && p.y <= box.bottom, `${JSON.stringify(p)} inside ${JSON.stringify(box)}`);
  await assert.rejects(paintedPoint(f, "not there"), /no painted passage holds "not there"/);
});
