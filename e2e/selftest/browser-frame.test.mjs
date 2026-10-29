// SPDX-License-Identifier: Apache-2.0
// Self-test: clickInFrame clicks the element it names through a scaled, scriptless frame, and watchFrameLoads records each load of the reading frame once, with its own sandbox (SPEC §6c, §12).

/**
 * Hermetic: a local server stands in for the app. Its page holds the reading
 * frame `iframe.doc-frame`, sandboxed `allow-same-origin` (no scripts, as an
 * untrusted document is), inside an ancestor scaled to 0.5, plus a srcdoc
 * thumbnail, a second document's frame and a cover the page can lay over the
 * frame. The document has a <details>, a fragment link, a sibling link and an
 * iframe of its own that loads another file of the same document. The server
 * also answers a link-key path, draft paths, a redirect and one file it holds
 * until released. Needs Chrome.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { BrowserPool, parseDocumentPath } from "../lib/browser.mjs";

const DOC = `<!doctype html><html><head><style>body{font:16px/1.5 sans-serif;margin:16px} #spacer{height:1600px}</style></head>
<body><p id="top">Top line of the document.</p>
<details id="det"><summary id="sum">More about it</summary><p id="inside">The inside of the details.</p></details>
<p><a id="frag" href="#far">to the far end</a> · <a id="sib" href="other.html">to the sibling file</a></p>
<p id="under">A line the document covers itself.</p><div id="lid" style="position:relative;margin-top:-40px;height:44px;background:rgba(0,0,0,.1)"></div>
<iframe id="own" src="nested.html" style="width:200px;height:60px"></iframe>
<div id="spacer"></div><p id="far">The far end.</p></body></html>`;

const OTHER = `<!doctype html><html><body><h1 id="sibling-page">The sibling file</h1></body></html>`;
const NESTED = `<!doctype html><html><body><p>nested</p></body></html>`;

const APP = `<!doctype html><html><body style="margin:0">
<div class="viewer"><div class="viewer-body">
<div id="stage" style="position:absolute;left:100px;top:60px;transform:scale(0.5);transform-origin:0 0">
<iframe class="doc-frame" sandbox="allow-same-origin" src="/content/d-one/v1/index.html" style="width:900px;height:600px;border:4px solid #888;padding:6px"></iframe>
</div>
<div id="cover" style="display:none;position:absolute;left:90px;top:50px;width:480px;height:330px;background:rgba(0,0,0,.2)"></div>
<iframe class="slide-thumb-frame" sandbox="allow-same-origin" srcdoc="<p>thumb</p>" style="position:absolute;left:700px;top:60px;width:80px;height:60px"></iframe>
<iframe class="doc-frame-other" src="/content/d-two/v1/index.html" style="position:absolute;left:700px;top:200px;width:80px;height:60px"></iframe>
</div></div>
<script>
  window.coverClicks = 0;
  document.getElementById("cover").addEventListener("click", () => { window.coverClicks += 1; });
  window.cover = (on) => { document.getElementById("cover").style.display = on ? "block" : "none"; };
  // A remount: a NEW iframe element, as React makes when the frame's key changes.
  window.remount = (sandbox, src) => {
    const old = document.querySelector("iframe.doc-frame");
    const el = document.createElement("iframe");
    el.className = "doc-frame";
    if (sandbox != null) el.setAttribute("sandbox", sandbox);
    el.setAttribute("style", old.getAttribute("style"));
    el.src = src;
    old.replaceWith(el);
  };
  // A navigation of the SAME element, optionally after changing its sandbox in place.
  window.setSrc = (src, sandbox) => {
    const el = document.querySelector("iframe.doc-frame");
    if (sandbox !== undefined) sandbox === null ? el.removeAttribute("sandbox") : el.setAttribute("sandbox", sandbox);
    el.src = src;
  };
</script>
</body></html>`;

const served = [];
const held = [];
let server;
let target;
before(async () => {
  server = http.createServer((req, res) => {
    const path = new URL(req.url, "http://x").pathname;
    served.push(path);
    const html = (body) => {
      res.setHeader("content-type", "text/html");
      res.end(body);
    };
    if (path === "/") return html(APP);
    if (path === "/content/d-one/v1/redir.html") {
      res.writeHead(302, { location: "/content/d-one/v1/index.html" });
      return res.end();
    }
    if (path === "/content/d-one/v1/slow.html") {
      // Held before any header: a navigation still waiting for its response.
      held.push(res);
      return;
    }
    if (path.endsWith("/other.html")) return html(OTHER);
    if (path.endsWith("/nested.html")) return html(NESTED);
    if (path.startsWith("/content/") || path.startsWith("/draft/")) return html(DOC);
    res.statusCode = 404;
    res.end("no");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  target = { kind: "local", runId: "selftest-frame", origin: `http://127.0.0.1:${port}`, stack: { ports: { hosting: port } }, capabilities: new Set(["local"]) };
});
after(async () => {
  for (const res of held.splice(0)) res.destroy();
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
});

/** Wait until the reading frame shows `path` (and `hash`), fully loaded. */
async function frameShows(u, path, hash = "") {
  return u.poll(
    () =>
      u.page.evaluate(
        ({ path, hash }) => {
          const d = document.querySelector("iframe.doc-frame")?.contentDocument;
          return Boolean(d && d.readyState === "complete" && d.location.pathname + d.location.search === path && d.location.hash === hash);
        },
        { path, hash },
      ),
    { timeout: 10_000, what: `the reading frame at ${path}${hash}` },
  );
}

const detailsOpen = async (u) => (await u.frame()).evaluate(() => document.getElementById("det").open);

test("parseDocumentPath: content (with and without a link key, plain or run) and draft paths of one document; anything else is null", () => {
  assert.deepEqual(parseDocumentPath("/content/d-one/v1/index.html"), { kind: "content", docId: "d-one", versionId: "v1", keyed: false, run: false });
  assert.deepEqual(parseDocumentPath("/content/~k3y/d-one/v2/a/b.html"), { kind: "content", docId: "d-one", versionId: "v2", keyed: true, run: false });
  assert.deepEqual(parseDocumentPath("/content/d-one/v1/"), { kind: "content", docId: "d-one", versionId: "v1", keyed: false, run: false }, "the version's directory");
  // The run variant an unsandboxed frame loads (ADR 0021): the same document, not a document called "!run".
  assert.deepEqual(parseDocumentPath("/content/!run/d-one/v1/index.html"), { kind: "content", docId: "d-one", versionId: "v1", keyed: false, run: true });
  assert.deepEqual(parseDocumentPath("/content/~k3y/!run/d-one/v2/x.html"), { kind: "content", docId: "d-one", versionId: "v2", keyed: true, run: true });
  assert.deepEqual(parseDocumentPath("/draft/d-one/index.html"), { kind: "draft", docId: "d-one", versionId: null, keyed: false, run: false });
  assert.deepEqual(parseDocumentPath("/content/d%20one/v1/x.html")?.docId, "d one", "segments are decoded");
  for (const p of ["/content/d-one/v1", "/content/~k3y/d-one/v1", "/content/~/d-one/v1/x", "/content/!run/d-one/v1", "/draft/d-one", "/d/d-one", "/contents/d-one/v1/x", "content/d-one/v1/x", "/content/%E0%A4%A/v1/x", "", null]) {
    assert.equal(parseDocumentPath(p), null, `NEGATIVE: ${JSON.stringify(p)} is not a document file`);
  }
});

test("clickInFrame clicks through a 0.5 CSS scale into a scriptless sandboxed frame: a <summary> toggles, at its centre and at its start", async () => {
  const pool = new BrowserPool({ target });
  try {
    const u = await pool.user();
    await u.goto("/");
    await frameShows(u, "/content/d-one/v1/index.html");
    assert.equal(await detailsOpen(u), false);
    const r = await u.clickInFrame("#sum");
    assert.ok(Math.abs(r.scale - 0.5) < 1e-6, `scale ${r.scale}`);
    assert.deepEqual(r.hit, { page: "frame", frame: "summary#sum" }, "the page's topmost element is the frame, and the frame's is the summary");
    assert.ok(Math.abs(r.clickedAt.x - (100 + (4 + 6 + r.inner.x) * 0.5)) < 0.01, `the frame point is mapped through the border, padding and scale: ${JSON.stringify(r)}`);
    await u.poll(() => detailsOpen(u), { timeout: 5_000, what: "the details to open" });
    const s = await u.clickInFrame("#sum", { where: "start" });
    assert.ok(s.clickedAt.x < r.clickedAt.x, "the start is left of the centre");
    await u.poll(async () => !(await detailsOpen(u)), { timeout: 5_000, what: "the details to close again" });
    const f = await u.frame();
    assert.equal(await f.evaluate(() => getSelection().toString()), "", "a click selects nothing and types nothing");
    await u.clickInFrame({ x: r.inner.x, y: r.inner.y });
    await u.poll(() => detailsOpen(u), { timeout: 5_000, what: "a click at a frame point to open the details" });
  } finally {
    await pool.close();
  }
});

test("NEGATIVE: clickInFrame refuses a point the page covers, a target the frame point misses, an absent selector and an unknown where", async () => {
  const pool = new BrowserPool({ target });
  try {
    const u = await pool.user();
    await u.goto("/");
    await frameShows(u, "/content/d-one/v1/index.html");
    await u.page.evaluate(() => window.cover(true));
    await assert.rejects(u.clickInFrame("#sum"), /would land on the page's div#cover, not #sum/);
    assert.equal(await u.page.evaluate(() => window.coverClicks), 0, "a refused click is never sent");
    assert.equal(await detailsOpen(u), false);
    const forced = await u.clickInFrame("#sum", { hitTest: false });
    assert.equal(forced.hit, null);
    await u.poll(async () => (await u.page.evaluate(() => window.coverClicks)) === 1, { timeout: 5_000, what: "the forced click to reach the cover" });
    assert.equal(await detailsOpen(u), false, "…and not the summary under it: what the hit test said would happen");
    await u.page.evaluate(() => window.cover(false));
    await assert.rejects(u.clickInFrame("#under"), /would land on div#lid in the frame, not #under/, "the document's own element over the target");
    await assert.rejects(u.clickInFrame("#nope"), /no element #nope/);
    await assert.rejects(u.clickInFrame("#sum", { where: "middle" }), /where must be "center", "start" or "end"/);
  } finally {
    await pool.close();
  }
});

test("watchFrameLoads: one row per load of the reading frame with the sandbox it had; a fragment, a nested frame, a thumbnail and another document are no rows", async () => {
  const pool = new BrowserPool({ target });
  try {
    const u = await pool.user();
    const w = u.watchFrameLoads("d-one");
    const any = u.watchFrameLoads();
    // What counting framenavigated would have said, for the NEGATIVE below.
    const naive = [];
    u.page.on("framenavigated", (fr) => {
      if (fr !== u.page.mainFrame() && /\/d-one\//.test(fr.url())) naive.push(fr.url());
    });
    served.length = 0;
    await u.goto("/");
    await frameShows(u, "/content/d-one/v1/index.html");

    await u.clickInFrame("#frag");
    await frameShows(u, "/content/d-one/v1/index.html", "#far");
    await u.clickInFrame("#sib", { where: "start" });
    await frameShows(u, "/content/d-one/v1/other.html");
    await u.page.evaluate(() => window.remount(null, "/content/d-one/v1/index.html"));
    await frameShows(u, "/content/d-one/v1/index.html");
    await u.page.evaluate(() => window.setSrc("/draft/d-one/index.html?r=1"));
    await frameShows(u, "/draft/d-one/index.html?r=1");
    await u.page.evaluate(() => window.setSrc("/draft/d-one/index.html?r=2", "allow-same-origin"));
    await frameShows(u, "/draft/d-one/index.html?r=2");
    await u.page.evaluate(() => window.setSrc("/content/~k3y/d-one/v1/index.html", null));
    await frameShows(u, "/content/~k3y/d-one/v1/index.html");
    await u.page.evaluate(() => window.setSrc("/content/d-one/v1/redir.html"));
    await frameShows(u, "/content/d-one/v1/index.html");
    // At least seven: the comparison below, not this wait, says what an extra row was.
    await u.poll(() => w.loads.filter((l) => l.committed).length >= 7, { timeout: 10_000, what: "seven committed loads" });
    await w.stop();
    await u.page.evaluate(() => window.remount("allow-same-origin", "/content/d-one/v1/index.html"));
    await frameShows(u, "/content/d-one/v1/index.html");

    const rows = w.summary();
    const C = "/content/d-one/v1/index.html";
    assert.deepEqual(
      rows.map(({ seq, frameIndex, kind, path, search, sandbox, cls, status, committed, failure, redirects, unread }) => ({ seq, frameIndex, kind, path, search, sandbox, cls, status, committed, failure, redirects, unread })),
      [
        { seq: 0, frameIndex: 1, kind: "content", path: C, search: "", sandbox: "allow-same-origin", cls: "doc-frame", status: 200, committed: true, failure: null, redirects: 0, unread: null },
        { seq: 1, frameIndex: 1, kind: "content", path: "/content/d-one/v1/other.html", search: "", sandbox: "allow-same-origin", cls: "doc-frame", status: 200, committed: true, failure: null, redirects: 0, unread: null },
        { seq: 2, frameIndex: 2, kind: "content", path: C, search: "", sandbox: null, cls: "doc-frame", status: 200, committed: true, failure: null, redirects: 0, unread: null },
        { seq: 3, frameIndex: 2, kind: "draft", path: "/draft/d-one/index.html", search: "?r=1", sandbox: null, cls: "doc-frame", status: 200, committed: true, failure: null, redirects: 0, unread: null },
        { seq: 4, frameIndex: 2, kind: "draft", path: "/draft/d-one/index.html", search: "?r=2", sandbox: "allow-same-origin", cls: "doc-frame", status: 200, committed: true, failure: null, redirects: 0, unread: null },
        { seq: 5, frameIndex: 2, kind: "content", path: "/content/~k3y/d-one/v1/index.html", search: "", sandbox: null, cls: "doc-frame", status: 200, committed: true, failure: null, redirects: 0, unread: null },
        { seq: 6, frameIndex: 2, kind: "content", path: C, search: "", sandbox: null, cls: "doc-frame", status: 200, committed: true, failure: null, redirects: 1, unread: null },
      ],
      "the reading frame's seven loads, each with the sandbox it was given; after stop() the last remount is not one",
    );
    assert.ok(rows.every((r) => Number.isFinite(r.pageMs) && r.pageMs >= 0), `pageMs counts from the page's own navigation: ${JSON.stringify(rows.map((r) => r.pageMs))}`);
    assert.ok(rows.every((r) => !("frame" in r) && !("url" in r)), "summary() is plain data");
    assert.doesNotThrow(() => JSON.stringify(rows));
    assert.ok(w.loads.every((l) => typeof l.frame?.url === "function"), "loads keep the live Frame");

    // NEGATIVE: each excluded thing really happened, so its absence is not vacuous.
    assert.ok(naive.some((x) => x.endsWith("#far")), `framenavigated fired for the fragment: ${JSON.stringify(naive)}`);
    assert.ok(naive.some((x) => x.endsWith("/nested.html")), "…and for the document's own nested iframe");
    assert.ok(naive.length > rows.length, `counting framenavigated says ${naive.length}, not ${rows.length}`);
    assert.ok(served.includes("/content/d-one/v1/nested.html") && served.includes("/content/d-two/v1/index.html"), `the nested frame and the other document were served: ${JSON.stringify(served)}`);
    assert.equal(served.filter((p) => p === "/content/d-one/v1/redir.html").length, 1, "the redirect was followed once");
    await any.stop();
    const all = any.summary();
    assert.deepEqual(all.filter((r) => r.path.includes("/d-two/")).map((r) => [r.path, r.cls, r.sandbox]), [["/content/d-two/v1/index.html", "doc-frame-other", null]], "with no docId every document's loads are rows, the other document's frame among them");
    assert.ok(!all.some((r) => r.path.endsWith("/nested.html")), "a frame inside the document is never the reading frame");
    assert.equal(all.length, rows.length + 2, "everything else is the same seven loads, and the remount after stop()");
  } finally {
    await pool.close();
  }
});

test("watchFrameLoads: a load the frame abandoned before it committed stays a row, committed false; a watcher started late has no pageMs", async () => {
  const pool = new BrowserPool({ target });
  try {
    const u = await pool.user();
    await u.goto("/");
    await frameShows(u, "/content/d-one/v1/index.html");
    const w = u.watchFrameLoads("d-one");
    const heldBefore = held.length;
    await u.page.evaluate(() => window.setSrc("/content/d-one/v1/slow.html"));
    await u.poll(() => held.length > heldBefore, { timeout: 10_000, what: "the server to hold slow.html" });
    await u.page.evaluate(() => window.remount(null, "/content/d-one/v1/index.html"));
    await frameShows(u, "/content/d-one/v1/index.html");
    await u.poll(() => w.loads.length === 2 && w.loads[1].committed && w.loads[0].failure, { timeout: 10_000, what: "the remount committed and the abandoned load failed" });
    await w.stop();
    const rows = w.summary().map(({ frameIndex, path, sandbox, status, committed, failure, pageMs }) => ({ frameIndex, path, sandbox, status, committed, failure: Boolean(failure), pageMs }));
    assert.deepEqual(rows, [
      { frameIndex: 1, path: "/content/d-one/v1/slow.html", sandbox: "allow-same-origin", status: null, committed: false, failure: true, pageMs: null },
      { frameIndex: 2, path: "/content/d-one/v1/index.html", sandbox: null, status: 200, committed: true, failure: false, pageMs: null },
    ]);
  } finally {
    for (const res of held.splice(0)) res.destroy();
    await pool.close();
  }
});
