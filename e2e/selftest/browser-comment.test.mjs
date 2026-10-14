// SPDX-License-Identifier: Apache-2.0
// Self-test: User.comment types into the thread its own Comment press made, even while an earlier thread is still selected, and fails at once on the app's refusal (SPEC §6, §12).

/**
 * Hermetic: a local server stands in for the viewer. Its reading frame is
 * `iframe.doc-frame` (sandboxed `allow-same-origin`, no scripts); a selection
 * toolbar shows while the frame has a selection; the comments panel lists
 * threads as app/src/annotation/Sidebar.tsx does, each with its reply box.
 * The FAB's Comment does what DocViewer.tsx startComment does: the new
 * thread is listed at once (Firestore's local write), and only once the write
 * is acknowledged, ACK_MS later, is it selected; until then the thread
 * selected before the press stays selected. Clicking a thread selects it;
 * Enter in a reply box adds the comment to THAT thread. `?refuse=1` makes the
 * press show the error toast the app shows when the write is refused, and
 * list nothing. Needs Chrome.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { BrowserPool } from "../lib/browser.mjs";

const ACK_MS = 900;

const DOC = `<!doctype html><html><head><style>body{font:16px/1.6 sans-serif;margin:16px}</style></head><body>
<p id="p1">The first passage, about lanterns over the harbour wall.</p>
<p id="p2">The second passage, about gulls above the fish market.</p>
<p id="p3">The third passage, about the ferry leaving at dusk.</p>
</body></html>`;

const APP = `<!doctype html><html><head><style>
body{margin:0;font:14px sans-serif}
.viewer-body[data-comments="closed"] .comments-panel{display:none}
.comments-panel{position:absolute;left:760px;top:20px;width:420px;border:1px solid #888}
.thread{border-bottom:1px solid #ccc;padding:6px}
.thread[aria-selected="true"]{background:#eef}
.selection-fab-bar{position:absolute;left:200px;top:440px;display:none}
.toast-stack{position:absolute;left:20px;top:520px}
</style></head><body>
<div class="viewer"><div class="viewer-body" data-comments="closed">
<iframe class="doc-frame" sandbox="allow-same-origin" src="/content/d-one/v1/index.html" style="position:absolute;left:20px;top:20px;width:700px;height:400px;border:1px solid #888"></iframe>
<div class="selection-fab-bar" role="toolbar" aria-label="Selection"><button type="button" class="selection-fab">Comment</button></div>
<aside class="comments-panel" aria-label="Comments"><ul class="comments-list"></ul></aside>
</div></div>
<div class="toast-stack"></div>
<script>
  const q = new URLSearchParams(location.search);
  const body = document.querySelector(".viewer-body");
  const list = document.querySelector(".comments-list");
  const frameDoc = () => document.querySelector("iframe.doc-frame").contentDocument;
  const bar = document.querySelector(".selection-fab-bar");
  const update = () => {
    const sel = frameDoc().getSelection();
    bar.style.display = sel && !sel.isCollapsed && sel.rangeCount > 0 ? "inline-flex" : "none";
  };
  document.querySelector("iframe.doc-frame").addEventListener("load", () => frameDoc().addEventListener("selectionchange", update));
  window.state = { selected: null, threads: [] };
  const select = (li) => {
    for (const t of list.children) t.setAttribute("aria-selected", String(t === li));
    window.state.selected = li ? li.dataset.n : null;
  };
  let n = 0;
  function newThread(quote) {
    n += 1;
    const li = document.createElement("li");
    li.className = "thread";
    li.dataset.n = String(n);
    li.setAttribute("aria-selected", "false");
    li.setAttribute("data-resolved", "false");
    li.innerHTML = '<p class="thread-quote"></p><textarea class="textarea" rows="2" placeholder="Reply"></textarea>';
    li.querySelector(".thread-quote").textContent = quote;
    li.addEventListener("click", () => select(li));
    const box = li.querySelector("textarea");
    box.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" || e.shiftKey) return;
      e.preventDefault();
      const text = box.value.trim();
      if (!text) return;
      box.value = "";
      setTimeout(() => {
        const c = document.createElement("div");
        c.className = "comment";
        c.innerHTML = '<p class="comment-body"></p>';
        c.firstChild.textContent = text;
        li.insertBefore(c, box);
      }, 100);
    });
    list.appendChild(li);
    return li;
  }
  document.querySelector(".selection-fab").addEventListener("click", () => {
    const quote = frameDoc().getSelection().toString().trim();
    if (q.get("refuse") === "1") {
      const t = document.createElement("div");
      t.className = "toast toast-error";
      t.setAttribute("role", "alert");
      t.innerHTML = "<span>Missing or insufficient permissions.</span>";
      document.querySelector(".toast-stack").appendChild(t);
      return;
    }
    const li = newThread(quote); // listed at once, from the local write
    setTimeout(() => { select(li); body.setAttribute("data-comments", "open"); }, ${ACK_MS}); // selected once acknowledged
  });
</script></body></html>`;

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
  target = { kind: "local", runId: "selftest-comment", origin: `http://127.0.0.1:${port}`, stack: { ports: { hosting: port } }, capabilities: new Set(["local"]) };
});
let pool = null;
after(async () => {
  await pool?.close();
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
});

async function reader(search = "") {
  pool ??= new BrowserPool({ target });
  const u = await pool.user({ name: "reader" });
  await u.goto(`/${search}`);
  await u.waitForFrame();
  await u.poll(() => u.page.evaluate(() => document.querySelector("iframe.doc-frame").contentDocument?.readyState === "complete"), { what: "the frame" });
  return u;
}

/** Each thread's quote and its comments, in order. */
const threads = (u) =>
  u.page.evaluate(() => Array.from(document.querySelectorAll(".comments-panel .thread")).map((t) => ({ quote: t.querySelector(".thread-quote").textContent, selected: t.getAttribute("aria-selected"), comments: Array.from(t.querySelectorAll(".comment-body")).map((b) => b.textContent) })));

test("a second comment on the page reaches its own new thread, not the one still selected from the first", async () => {
  const u = await reader();
  try {
    await u.selectText("#p1", "lanterns over the harbour wall");
    const first = await u.comment("first remark", { timeout: 10_000 });
    assert.deepEqual(first, { quote: "lanterns over the harbour wall" });
    assert.deepEqual(await threads(u), [{ quote: "lanterns over the harbour wall", selected: "true", comments: ["first remark"] }]);

    // Thread 1 is selected now; the press lists thread 2 at once and selects it only ACK_MS later.
    await u.selectText("#p2", "gulls above the fish market");
    const t0 = Date.now();
    const second = await u.comment("second remark", { timeout: 10_000 });
    const took = Date.now() - t0;
    await u.page.waitForTimeout(ACK_MS); // a settle for the oracle only: anything misdirected has landed
    assert.deepEqual(await threads(u), [
      { quote: "lanterns over the harbour wall", selected: "false", comments: ["first remark"] },
      { quote: "gulls above the fish market", selected: "true", comments: ["second remark"] },
    ], "each comment in its own thread");
    assert.deepEqual(second, { quote: "gulls above the fish market" });
    assert.ok(took >= ACK_MS, `it waited for the new thread to be selected (${took} ms)`);

    // And a third, with the reader having clicked the first thread meanwhile.
    await u.page.locator(".comments-panel .thread").first().click();
    await u.selectText("#p3", "the ferry leaving at dusk");
    await u.comment("third remark", { timeout: 10_000 });
    assert.deepEqual((await threads(u)).map((t) => t.comments), [["first remark"], ["second remark"], ["third remark"]]);
  } finally {
    await u.close();
  }
});

test("a refused Comment press throws at once with the app's words; nothing is typed", async () => {
  const u = await reader("?refuse=1");
  try {
    await u.selectText("#p1", "lanterns over the harbour wall");
    const t0 = Date.now();
    await assert.rejects(u.comment("never sent", { timeout: 15_000 }), /the Comment press made no thread: the app said "Missing or insufficient permissions\."/);
    assert.ok(Date.now() - t0 < 5_000, "at once, not at the timeout");
    assert.deepEqual(await threads(u), []);
  } finally {
    await u.close();
  }
});

test("comment refuses an empty text before pressing anything", async () => {
  const u = await reader();
  try {
    await assert.rejects(u.comment(""), /comment takes a non-empty text/);
    assert.deepEqual(await threads(u), [], "no press, no thread");
  } finally {
    await u.close();
  }
});
