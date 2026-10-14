// SPDX-License-Identifier: Apache-2.0
// Self-test: User.reply, resolve and reopen bound EACH of their waits by `timeout` — the panel, the thread's control, the outcome (SPEC §6, §12).

/**
 * Hermetic: a local server stands in for the viewer's comments panel as
 * app/src/annotation/Sidebar.tsx renders it: a Comments toggle in the
 * toolbar, `.viewer-body[data-comments]`, threads with their quote, comments,
 * a Reply box, and Resolve or Reopen by their state, and "Show resolved" in
 * the head (a resolved thread is not listed until it is pressed). The query
 * slows what a loaded stack slows: `panel=<ms>|never` ignores the toggle
 * until then (the panel slow to open), `late=<ms>|never` lists the thread
 * quoting LATE only then (another user's thread, on this page's snapshot),
 * `ack=<ms>|never` is how long a reply, Resolve or Reopen takes to show (the
 * write's snapshot). Elements are kept, never rebuilt, so a box being typed
 * into survives a thread arriving. Needs Chrome.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { BrowserPool } from "../lib/browser.mjs";
import { pageStall } from "../lib/test.mjs";

const OPEN = "lanterns over the harbour wall"; // listed, unresolved
const DONE = "gulls above the fish market"; // listed, resolved
const LATE = "the ferry leaving at dusk"; // listed only once ?late= has passed
const LOST_LINE = "@firebase/firestore: Firestore (11.0.0): Could not reach Cloud Firestore backend. Backend didn't respond within 10 seconds.";

const APP = `<!doctype html><html><head><style>
body{margin:0;font:14px sans-serif}
.viewer-body[data-comments="closed"] .comments-panel{display:none}
.comments-panel{position:absolute;left:20px;top:60px;width:520px;border:1px solid #888}
.thread{border-bottom:1px solid #ccc;padding:6px}
</style></head><body>
<div class="viewer">
<div class="viewer-toolbar"><div class="viewer-toolbar-actions"><button type="button" aria-label="Comments">Comments</button></div></div>
<div class="viewer-body" data-comments="closed">
<aside class="comments-panel" aria-label="Comments">
<div class="comments-head"><span class="comments-count"></span><button type="button" class="btn btn-quiet btn-sm" aria-pressed="false">Show resolved</button></div>
<ul class="comments-list"></ul>
</aside></div></div>
<script>
  const q = new URLSearchParams(location.search);
  const at = (k, d) => (q.get(k) === "never" ? Infinity : Number(q.get(k) ?? d));
  const t0 = Date.now();
  const later = (ms, fn) => { if (ms !== Infinity) setTimeout(fn, ms); };
  const body = document.querySelector(".viewer-body");
  const list = document.querySelector(".comments-list");
  const showBtn = document.querySelector(".comments-head button");
  let showResolved = false;
  const threads = [
    { id: "a", quote: ${JSON.stringify(OPEN)}, resolved: false, comments: ["the first remark"], listed: true },
    { id: "r", quote: ${JSON.stringify(DONE)}, resolved: true, comments: ["a settled remark"], listed: true },
    { id: "l", quote: ${JSON.stringify(LATE)}, resolved: false, comments: ["another user's remark"], listed: false },
  ];
  const els = new Map();
  function element(t) {
    const li = document.createElement("li");
    li.className = "thread";
    li.innerHTML = '<p class="thread-quote"></p><div class="comments"></div><textarea class="textarea" rows="2" placeholder="Reply"></textarea><div class="thread-actions"><button type="button" class="reply">Reply</button><button type="button" class="state"></button></div>';
    li.querySelector(".thread-quote").textContent = t.quote;
    const box = li.querySelector("textarea");
    box.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" || e.shiftKey) return;
      e.preventDefault();
      const text = box.value.trim();
      if (!text) return;
      box.value = "";
      later(at("ack", 300), () => { t.comments.push(text); render(); });
    });
    li.querySelector(".state").addEventListener("click", () => later(at("ack", 300), () => { t.resolved = !t.resolved; render(); }));
    return li;
  }
  function render() {
    for (const t of threads) {
      const shown = t.listed && (showResolved || !t.resolved);
      let li = els.get(t.id);
      if (!shown) { li?.remove(); continue; }
      if (!li) { li = element(t); els.set(t.id, li); }
      if (!li.isConnected) list.appendChild(li);
      li.setAttribute("data-resolved", String(t.resolved));
      li.setAttribute("aria-selected", "false");
      li.querySelector(".state").textContent = t.resolved ? "Reopen" : "Resolve";
      const c = li.querySelector(".comments");
      while (c.children.length < t.comments.length) {
        const p = document.createElement("p");
        p.className = "comment-body";
        p.textContent = t.comments[c.children.length];
        c.appendChild(p);
      }
    }
    showBtn.textContent = showResolved ? "Hide resolved" : "Show resolved";
    showBtn.setAttribute("aria-pressed", String(showResolved));
  }
  showBtn.addEventListener("click", () => { showResolved = !showResolved; render(); });
  document.querySelector('[aria-label="Comments"]').addEventListener("click", () => {
    if (Date.now() - t0 < at("panel", 0)) return; // the panel slow to open: the press does nothing yet
    body.setAttribute("data-comments", body.getAttribute("data-comments") === "open" ? "closed" : "open");
  });
  later(at("late", 0), () => { threads[2].listed = true; render(); });
  render();
  window.threadsNow = () => threads.map((t) => ({ quote: t.quote, resolved: t.resolved, comments: [...t.comments], listed: Boolean(els.get(t.id)?.isConnected) }));
</script></body></html>`;

let server;
let target;
let pool = null;

before(async () => {
  server = http.createServer((req, res) => {
    const path = new URL(req.url, "http://x").pathname;
    res.setHeader("content-type", "text/html");
    if (path === "/") return res.end(APP);
    res.statusCode = 404;
    res.end("no");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  target = { kind: "local", runId: "selftest-thread-actions", origin: `http://127.0.0.1:${port}`, stack: { ports: { hosting: port } }, capabilities: new Set(["local"]) };
});

after(async () => {
  await pool?.close();
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
});

async function reader(search = "") {
  pool ??= new BrowserPool({ target });
  const u = await pool.user({ name: "reader" });
  await u.goto(`/${search}`);
  await u.page.locator('.viewer-toolbar-actions button[aria-label="Comments"]').waitFor({ timeout: 15_000 });
  return u;
}

/** What `p` rejects with, and how long it took (it must reject). */
async function timedRejection(p) {
  const t0 = Date.now();
  try {
    await p;
  } catch (err) {
    return { err, ms: Date.now() - t0 };
  }
  assert.fail("expected a rejection");
}

const state = (u) => u.page.evaluate(() => window.threadsNow());
const panel = (u) => u.page.locator(".viewer-body").getAttribute("data-comments");

test("reply, resolve and reopen act on a thread this page's snapshot lists late, each wait given the caller's timeout", async () => {
  const u = await reader("?panel=1500&late=2500&ack=600");
  try {
    assert.equal((await state(u))[2].listed, false, "precondition: the thread is not listed yet as the reply begins");
    await u.reply(LATE, "a reply to the late thread", { timeout: 8_000 });
    assert.deepEqual((await state(u))[2], { quote: LATE, resolved: false, comments: ["another user's remark", "a reply to the late thread"], listed: true });

    await u.resolve(LATE, { timeout: 8_000 });
    assert.deepEqual((await state(u))[2], { quote: LATE, resolved: true, comments: ["another user's remark", "a reply to the late thread"], listed: false }, "resolved, and so no longer listed");

    await u.reopen(LATE, { timeout: 8_000 });
    const s = await state(u);
    assert.equal(s[2].resolved, false, "reopened");
    assert.equal(s[1].resolved, true, "the other resolved thread is untouched");
    assert.equal(await panel(u), "open");
  } finally {
    await u.close();
  }
});

test("the panel's wait is the caller's timeout, not openComments' fixed 10 s: a panel that never opens fails each of the three at it", async () => {
  const u = await reader("?panel=never");
  try {
    for (const [verb, call] of [
      ["reply", () => u.reply(OPEN, "never typed", { timeout: 2_000 })],
      ["resolve", () => u.resolve(OPEN, { timeout: 2_000 })],
      ["reopen", () => u.reopen(DONE, { timeout: 2_000 })],
    ]) {
      const { err, ms } = await timedRejection(call());
      assert.match(err.message, /^reader: the comments panel did not open within 2000 ms \(data-comments "closed", \d+ press(es)?\)$/, verb);
      assert.ok(ms >= 1_900 && ms < 6_000, `${verb}: ran out after ${ms} ms, at its timeout`);
    }
    assert.deepEqual((await state(u)).map((t) => [t.resolved, t.comments.length]), [[false, 1], [true, 1], [false, 1]], "nothing changed");
  } finally {
    await u.close();
  }
});

test("the control's wait is the caller's timeout, not Playwright's 30 s: a thread never listed fails each of the three at it, naming the control and how many such threads the panel lists", async () => {
  const u = await reader("?late=never");
  try {
    const cases = [
      ["reply", () => u.reply(LATE, "never typed", { timeout: 2_000 }), /^reader: reply: the thread quoting "the ferry leaving at dusk" showed no Reply box to press within 2000 ms \(0 such threads in the panel\)$/],
      ["resolve", () => u.resolve(LATE, { timeout: 2_000 }), /^reader: resolve: the thread quoting "the ferry leaving at dusk" showed no Resolve button to press within 2000 ms \(0 such threads in the panel\)$/],
      ["reopen", () => u.reopen(LATE, { timeout: 2_000 }), /^reader: reopen: the thread quoting "the ferry leaving at dusk" showed no Reopen button to press within 2000 ms \(0 such threads in the panel\)$/],
      // Listed but not resolved (as this page sees it): Reopen is not there to press.
      ["reopen an open thread", () => u.reopen(OPEN, { timeout: 2_000 }), /^reader: reopen: the thread quoting "lanterns over the harbour wall" showed no Reopen button to press within 2000 ms \(1 such thread in the panel\)$/],
    ];
    for (const [what, call, re] of cases) {
      const { err, ms } = await timedRejection(call());
      assert.match(err.message, re, what);
      assert.ok(ms >= 1_900 && ms < 6_000, `${what}: ran out after ${ms} ms, at its timeout`);
      assert.match(String(err.cause?.message), /Timeout 2000ms exceeded/, `${what}: Playwright's own error is its cause`);
    }
  } finally {
    await u.close();
  }
});

test("the outcome's wait is the caller's timeout: a reply, Resolve or Reopen that never shows fails at it, in words that name it", async () => {
  const u = await reader("?ack=never");
  try {
    const cases = [
      ["reply", () => u.reply(OPEN, "never shown", { timeout: 2_000 }), /^reader: reply: "never shown" did not show in the thread quoting "lanterns over the harbour wall" within 2000 ms$/],
      ["resolve", () => u.resolve(OPEN, { timeout: 2_000 }), /^reader: the thread to resolve not reached within 2000 ms/],
      ["reopen", () => u.reopen(DONE, { timeout: 2_000 }), /^reader: the thread to reopen not reached within 2000 ms/],
    ];
    for (const [what, call, re] of cases) {
      const { err, ms } = await timedRejection(call());
      assert.match(err.message, re, what);
      assert.ok(ms >= 1_900 && ms < 6_000, `${what}: ran out after ${ms} ms, at its timeout`);
    }
  } finally {
    await u.close();
  }
});

test("each such failure is a wait pageStall reads, its window the caller's timeout, at the caller's line via the User method", async () => {
  const u = await reader("?late=never");
  try {
    const lost = { usersSoFar: [{ name: "reader", log: { console: [{ t: Date.now(), type: "error", text: LOST_LINE }], sdkProbes: [] }, responses: [] }] };
    const quiet = { usersSoFar: [{ name: "reader", log: { console: [], sdkProbes: [] }, responses: [] }] };
    const { err } = await timedRejection(u.reply(LATE, "never typed", { timeout: 2_000 }));
    const why = pageStall(err, lost);
    assert.match(why, /^a page's Firestore client lost the emulator \(reader: "Could not reach Cloud Firestore backend"\), in the 12 s before a wait ran out — the failure, at browser-thread-actions\.test\.mjs:\d+ \(via User\.reply, browser\.mjs:\d+\): reader: reply: the thread quoting/);
    assert.equal(pageStall(err, quiet), null, "NEGATIVE: the same wait on a page that saw no stall is the product's");
  } finally {
    await u.close();
  }
});

test("an empty reply or a timeout that is not a positive number throws before anything is pressed", async () => {
  const u = await reader();
  try {
    await assert.rejects(u.reply(OPEN, ""), /^Error: reader: reply takes a non-empty text, got ""$/);
    await assert.rejects(u.reply(OPEN, undefined), /reply takes a non-empty text, got undefined/);
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, "5000", null]) {
      await assert.rejects(u.reply(OPEN, "x", { timeout: bad }), /^Error: reader: reply timeout is a positive number of ms, bounding each of its waits, got /, String(bad));
      await assert.rejects(u.resolve(OPEN, { timeout: bad }), /reader: resolve timeout is a positive number of ms/, String(bad));
      await assert.rejects(u.reopen(DONE, { timeout: bad }), /reader: reopen timeout is a positive number of ms/, String(bad));
    }
    assert.equal(await panel(u), "closed", "the panel was never pressed open");
    assert.deepEqual((await state(u)).map((t) => [t.resolved, t.comments.length]), [[false, 1], [true, 1], [false, 1]], "nothing changed");
  } finally {
    await u.close();
  }
});
