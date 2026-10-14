// SPDX-License-Identifier: Apache-2.0
// Self-test: the comments panel opens whatever the first snapshot does, threads are found by a suggestion's quote, a refused Suggest edit is pressed under a toast, the form is typed from its caret, selections span elements, and the frame's text leaves out the app's own nodes (SPEC §6, §12, §22).

/**
 * Hermetic: a local server stands in for the viewer. Its page holds the
 * reading frame `iframe.doc-frame` (sandboxed `allow-same-origin`, no
 * scripts, inside an ancestor scaled to 0.5), a selection toolbar that
 * follows the frame's selection and leaves "Suggest edit" aria-disabled, with
 * its reason as the title, for a selection across blocks or holding a <br>
 * (as app/src/components/SelectionFab.tsx does), a toast stack laid over that
 * toolbar, a suggestion form that focuses its field with the caret at the end
 * (or, on demand, at the start) and POSTs /suggestion, and a comments panel
 * whose default the first snapshot decides unless the reader toggled first
 * (app/src/viewer/useCommentsOpen.ts). `?race=1` makes that snapshot land
 * when the pointer reaches the toggle: between a read of the panel's state
 * and the click. `/threads` is a static panel with every kind of thread.
 * Needs Chrome.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { BrowserPool } from "../lib/browser.mjs";
import { bodyHash, frameText, selectionBetween, setSelectionBetween } from "../lib/frame.mjs";

const REASON = Object.freeze({
  across: "A suggestion stays within one paragraph.",
  structure: "A suggestion can only change text, and this includes a line break, list, table or image.",
});

const DOC = `<!doctype html><html><head><style>body{font:16px/1.5 sans-serif;margin:16px}td{border:1px solid #999}</style></head>
<body><p id="p1">The quick <em>brown</em> fox jumps over the lazy dog near the riverbank.</p>
<p id="p2">A second paragraph mentions lanterns and harbour lights at dusk.</p>
<p id="pbr">First line of the verse<br>second line of the verse</p>
<div id="listbox">Before the list<ul><li id="li">a single list item worth editing</li></ul>after the list</div>
<div id="tablebox">Before the table<table><tbody><tr><td id="td">a table cell worth editing</td></tr></tbody></table>after the table</div>
<p id="rep">echo one, echo two, echo three</p>
<p id="hl">Highlighted <mark class="bshd-hl" data-bshd-sug="a1" data-bshd-ins="cat">quick</mark> words.</p>
<span data-bshd="whatever" id="authors">AUTHOR-OWN</span>
<div data-bshd="peers" id="bshd-peers"><span class="peer">alice@example.com</span><span class="peer">bob@example.com</span></div>
<style data-bshd="peer-style">.peer{outline:1px solid red}</style>
<div id="spacer" style="height:1600px"></div>
<p id="far">The far end of the document.</p></body></html>`;

const APP = `<!doctype html><html><head><style>
body{margin:0;font:14px sans-serif}
.viewer-toolbar-actions{position:absolute;left:900px;top:8px}
.viewer-body[data-comments="closed"] .comments-panel{display:none}
.comments-panel{position:absolute;left:900px;top:60px;width:300px;height:300px;border:1px solid #888}
.selection-fab-bar{position:absolute;left:600px;top:420px;display:none;gap:4px}
.selection-fab{height:34px;padding:0 12px}
.selection-fab[aria-disabled="true"]{opacity:.6}
.toast-stack{position:absolute;left:580px;top:405px;z-index:20}
.toast{width:320px;height:64px;background:#fdd;border:1px solid #a00}
.suggest-popover{position:absolute;left:600px;top:480px;width:340px;z-index:11;background:#fff;border:1px solid #888}
#cover{display:none;position:absolute;left:90px;top:50px;width:480px;height:330px;background:rgba(0,0,0,.2);z-index:5}
</style></head><body>
<div class="viewer">
<div class="viewer-toolbar"><div class="viewer-toolbar-actions"><button type="button" aria-label="Comments" aria-pressed="false">Comments</button></div></div>
<div class="viewer-body" data-comments="closed">
<div id="stage" style="position:absolute;left:100px;top:60px;transform:scale(0.5);transform-origin:0 0">
<iframe class="doc-frame" sandbox="allow-same-origin" src="/content/d-one/v1/index.html" style="width:900px;height:600px;border:4px solid #888;padding:6px"></iframe>
</div>
<div id="cover"></div>
<div class="selection-fab-bar" role="toolbar" aria-label="Selection"><button type="button" class="selection-fab">Comment</button><button type="button" class="selection-fab" id="suggest">Suggest edit</button></div>
<aside class="comments-panel"><ul><li class="thread" aria-selected="false" data-resolved="false"><p class="thread-quote">harbour lights</p></li></ul></aside>
</div></div>
<div class="toast-stack"></div>
<script>
  const q = new URLSearchParams(location.search);
  // --- the comments panel: the first snapshot decides, unless the reader toggled first ---
  let decided = null;
  const body = document.querySelector(".viewer-body");
  const toggle = document.querySelector('.viewer-toolbar-actions button[aria-label="Comments"]');
  const render = () => {
    body.setAttribute("data-comments", decided ? "open" : "closed");
    toggle.setAttribute("aria-pressed", String(Boolean(decided)));
  };
  window.presses = 0;
  window.snapshotAt = null;
  window.snapshot = (unresolved) => {
    if (decided !== null) return;
    decided = unresolved;
    window.snapshotAt = Date.now();
    render();
  };
  toggle.addEventListener("click", () => { window.presses += 1; decided = !(decided ?? false); render(); });
  if (q.get("race") === "1") toggle.addEventListener("pointerenter", () => window.snapshot(true));
  if (q.get("snapshot") === "unresolved") window.snapshot(true);
  if (q.get("snapshot") === "resolved") window.snapshot(false);

  // --- toasts ---
  window.toastClicks = 0;
  window.showToast = (text, ms = 1500, kind = "toast-error") => {
    const t = document.createElement("div");
    t.className = "toast " + kind;
    t.setAttribute("role", "alert");
    t.innerHTML = "<span></span>";
    t.firstChild.textContent = text;
    t.addEventListener("click", () => { window.toastClicks += 1; });
    document.querySelector(".toast-stack").appendChild(t);
    setTimeout(() => t.remove(), ms);
  };

  // --- the selection toolbar, following the frame's selection ---
  const bar = document.querySelector(".selection-fab-bar");
  const suggestBtn = document.getElementById("suggest");
  window.suggestPresses = 0;
  window.refusals = [];
  let refusal = null;
  let quote = "";
  const frameDoc = () => document.querySelector("iframe.doc-frame").contentDocument;
  const blockOf = (n) => (n.nodeType === 3 ? n.parentElement : n)?.closest("p, li, td") ?? null;
  const update = () => {
    const sel = frameDoc().getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) { bar.style.display = "none"; return; }
    const r = sel.getRangeAt(0);
    quote = r.toString().trim();
    const a = blockOf(r.startContainer);
    refusal = !a || a !== blockOf(r.endContainer) ? ${JSON.stringify(REASON.across)} : r.cloneContents().querySelector("br") ? ${JSON.stringify(REASON.structure)} : null;
    if (refusal) { suggestBtn.setAttribute("aria-disabled", "true"); suggestBtn.title = refusal; }
    else { suggestBtn.removeAttribute("aria-disabled"); suggestBtn.removeAttribute("title"); }
    bar.style.display = "inline-flex";
  };
  document.querySelector("iframe.doc-frame").addEventListener("load", () => frameDoc().addEventListener("selectionchange", update));
  suggestBtn.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    window.suggestPresses += 1;
    if (refusal) { window.refusals.push(refusal); window.showToast(refusal, 1500); return; }
    openForm(quote);
  });

  // --- the suggestion form (app/src/components/SuggestPopover.tsx) ---
  window.caretAtStart = false;
  window.fieldKeys = [];
  function openForm(exact) {
    document.querySelector(".suggest-popover")?.remove();
    const pop = document.createElement("div");
    pop.className = "suggest-popover";
    pop.setAttribute("role", "dialog");
    pop.setAttribute("aria-label", "Suggest an edit");
    pop.innerHTML = '<form class="suggest-form"><label class="field-label">Replace “<span class="suggest-quote"></span>” with</label>' +
      '<textarea class="textarea" rows="2"></textarea><span class="field-hint"></span>' +
      '<input class="input" aria-label="Note (optional)" placeholder="Note (optional)">' +
      '<div class="suggest-actions"><button type="submit">Suggest</button><button type="button" class="cancel">Cancel</button></div></form>';
    pop.querySelector(".suggest-quote").textContent = exact;
    const field = pop.querySelector("textarea");
    const note = pop.querySelector("input");
    const submitBtn = pop.querySelector('button[type="submit"]');
    field.value = exact;
    const sync = () => {
      if (/[\\r\\n\\t]/.test(field.value)) field.value = field.value.replace(/[\\r\\n\\t]+/g, " ");
      submitBtn.disabled = field.value === exact;
      pop.querySelector(".field-hint").textContent = field.value === "" ? "Left empty, this suggests deleting it." : "Leave it empty to suggest deleting it.";
    };
    sync();
    field.addEventListener("input", sync);
    const submit = async () => {
      if (field.value === exact) return;
      const r = await fetch("/suggestion", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ exact, replacement: field.value, note: note.value.trim() }) });
      const j = await r.json();
      if (r.ok) pop.remove();
      else window.showToast(j.error, 4000);
    };
    const keys = (e) => {
      if (e.target === field) window.fieldKeys.push(e.key);
      if (e.key === "Escape") { e.preventDefault(); pop.remove(); }
      else if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void submit(); }
    };
    field.addEventListener("keydown", keys);
    note.addEventListener("keydown", keys);
    pop.querySelector("form").addEventListener("submit", (e) => { e.preventDefault(); void submit(); });
    pop.querySelector(".cancel").addEventListener("click", () => pop.remove());
    document.body.appendChild(pop);
    // As the form's effect does, a moment after it mounts.
    setTimeout(() => {
      field.focus();
      const at = window.caretAtStart ? 0 : field.value.length;
      field.setSelectionRange(at, at);
    }, 30);
  }
  window.cover = (on) => { document.getElementById("cover").style.display = on ? "block" : "none"; };
</script></body></html>`;

/** Every kind of thread the panel lists (app/src/annotation/Sidebar.tsx), and a floating form outside it. */
const THREADS = `<!doctype html><html><body>
<aside class="comments-panel"><ul>
<li class="thread" aria-selected="false" data-resolved="false"><p class="thread-quote">harbour lights</p><div class="comment"><p class="comment-body">a comment</p></div></li>
<li class="thread" aria-selected="false" data-resolved="false" id="sug"><div class="suggestion" data-state="pending"><p class="suggestion-change"><span class="visually-hidden">Replace </span><del>quick brown fox</del><span class="visually-hidden"> with </span><span aria-hidden="true"> → </span><ins>quick brown cat</ins></p><p class="suggestion-status">Waiting for the owner or an approver.</p><details class="suggestion-history"><summary>Changed once</summary><ol><li><del>lantern glow</del></li></ol></details></div></li>
<li class="thread" aria-selected="false" data-resolved="false" id="editing"><form class="suggest-form"><label class="field-label">Replace “<span class="suggest-quote">lazy dog</span>” with</label><textarea>lazy cat</textarea></form></li>
<li class="thread" aria-selected="true" data-resolved="false" id="selected"><p class="thread-quote">Closing words</p></li>
</ul></aside>
<div class="suggest-popover" role="dialog" aria-label="Suggest an edit"><form class="suggest-form"><label class="field-label">Replace “<span class="suggest-quote">near the riverbank</span>” with</label><textarea>near the river</textarea></form></div>
</body></html>`;

const posts = [];
let server;
let target;
before(async () => {
  server = http.createServer((req, res) => {
    const path = new URL(req.url, "http://x").pathname;
    if (req.method === "POST" && path === "/suggestion") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const got = JSON.parse(body);
        posts.push(got);
        res.setHeader("content-type", "application/json");
        if (got.replacement === "REFUSE-ME") {
          res.statusCode = 409;
          return res.end(JSON.stringify({ error: "You already have 20 suggestions waiting on this version. Wait for some to be decided, or withdraw one." }));
        }
        res.end(JSON.stringify({ annId: `a-${posts.length}`, versionId: "v1" }));
      });
      return;
    }
    res.setHeader("content-type", "text/html");
    if (path === "/") return res.end(APP);
    if (path === "/threads") return res.end(THREADS);
    if (path.startsWith("/content/d-one/")) return res.end(DOC);
    res.statusCode = 404;
    res.end("no");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  target = { kind: "local", runId: "selftest-suggest", origin: `http://127.0.0.1:${port}`, stack: { ports: { hosting: port } }, capabilities: new Set(["local"]) };
});
after(async () => {
  await shared?.close();
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
});

/**
 * One Chrome, one context and one page for the whole file; every test
 * navigates it afresh, so no window state survives from one to the next.
 * Light on purpose: this file runs beside sync.test.mjs, whose 40 ms browser
 * window missed under load while a Chrome and a renderer per test were
 * starting here.
 */
let shared = null;
let reader = null;
function users() {
  return {
    user: async () => {
      shared ??= new BrowserPool({ target });
      reader ??= await shared.user({ name: "reader" });
      // Off every control, so a hover handler fires only when a test moves onto it.
      await reader.page.mouse.move(0, 0);
      return reader;
    },
    close: async () => {},
  };
}

/** The app page with its frame loaded and its selection toolbar listening. */
async function openApp(u, search = "") {
  await u.goto(`/${search}`);
  await u.waitForFrame();
  await u.poll(() => u.page.evaluate(() => document.querySelector("iframe.doc-frame").contentDocument?.readyState === "complete"), { what: "the frame" });
}

/** What openComments did before this change: one read, one press. Kept here to prove the race page reproduces the race. */
async function legacyOpenComments(u, { timeout }) {
  const state = await u.page.locator(".viewer-body").getAttribute("data-comments");
  if (state !== "open") await u.page.locator('.viewer-toolbar-actions button[aria-label="Comments"]').first().click();
  await u.page.locator('.viewer-body[data-comments="open"] .comments-panel').waitFor({ state: "visible", timeout });
}

const pageState = (u) => u.page.evaluate(() => ({ comments: document.querySelector(".viewer-body").getAttribute("data-comments"), presses: window.presses, snapshot: window.snapshotAt != null }));

test("openComments opens the panel when the first snapshot lands between its read and its press; NEGATIVE: one read and one press closes it", async () => {
  const pool = users();
  try {
    const u = await pool.user();
    await openApp(u, "?race=1");
    assert.deepEqual(await pageState(u), { comments: "closed", presses: 0, snapshot: false });
    const r = await u.openComments({ timeout: 8_000 });
    assert.deepEqual(r, { presses: 2 }, "the first press closed what the snapshot had just opened; the second opened it");
    assert.deepEqual(await pageState(u), { comments: "open", presses: 2, snapshot: true });
    assert.equal(await u.page.locator(".comments-panel").isVisible(), true);

    // NEGATIVE: the same page defeats a single read-then-press, so the pass above is not vacuous.
    const v = await pool.user();
    assert.equal(v, u, "the same page, navigated afresh");
    await openApp(v, "?race=1");
    await assert.rejects(legacyOpenComments(v, { timeout: 2_000 }), /Timeout 2000ms exceeded/);
    assert.deepEqual(await pageState(v), { comments: "closed", presses: 1, snapshot: true }, "the snapshot opened it and the one press closed it");
  } finally {
    await pool.close();
  }
});

test("openComments: no press when the snapshot has opened it, one when it decided closed or never came; the panel stays open after", async () => {
  const pool = users();
  try {
    const u = await pool.user();
    await openApp(u, "?snapshot=unresolved");
    assert.deepEqual(await u.openComments(), { presses: 0 }, "the snapshot opened it");
    assert.equal((await pageState(u)).comments, "open");
    await openApp(u, "?snapshot=resolved");
    assert.deepEqual(await u.openComments(), { presses: 1 }, "the snapshot decided closed");
    assert.equal((await pageState(u)).comments, "open");
    await openApp(u);
    assert.deepEqual(await u.openComments(), { presses: 1 }, "no snapshot came");
    // A snapshot after the reader's press changes nothing, and a second call presses nothing.
    await u.page.evaluate(() => window.snapshot(false));
    assert.deepEqual(await u.openComments(), { presses: 0 });
    assert.deepEqual(await pageState(u), { comments: "open", presses: 1, snapshot: false });
  } finally {
    await pool.close();
  }
});

test("thread(quote) finds a comment by its quote, a suggestion by its struck quote or its open Edit form, never by an earlier replacement or the floating form; kind narrows it", async () => {
  const pool = users();
  try {
    const u = await pool.user();
    await u.goto("/threads");
    const ids = async (loc) => loc.evaluateAll((els) => els.map((e) => e.id || e.querySelector(".thread-quote")?.textContent));
    assert.deepEqual(await ids(u.thread("harbour lights")), ["harbour lights"], "a comment thread");
    assert.deepEqual(await ids(u.thread("quick brown fox")), ["sug"], "a suggestion, by the quote its change strikes");
    assert.deepEqual(await ids(u.thread("brown")), ["sug"], "a substring, as hasText");
    assert.deepEqual(await ids(u.thread("lazy dog")), ["editing"], "a suggestion whose Edit form is open");
    assert.deepEqual(await ids(u.thread(null)), ["selected"], "no quote: the selected thread");
    // NEGATIVE: things that are not a thread's quote.
    assert.equal(await u.thread("lantern glow").count(), 0, "an earlier replacement in the history is not the quote");
    assert.equal(await u.thread("quick brown cat").count(), 0, "the replacement is not the quote");
    assert.equal(await u.thread("near the riverbank").count(), 0, "the floating form is outside the panel");
    assert.equal(await u.page.locator(".suggest-popover .suggest-quote", { hasText: "near the riverbank" }).count(), 1, "…and it is there, so that count is not vacuous");
    // kind
    assert.deepEqual(await ids(u.thread("quick brown fox", { kind: "suggestion" })), ["sug"]);
    assert.equal(await u.thread("quick brown fox", { kind: "comment" }).count(), 0);
    assert.deepEqual(await ids(u.thread("harbour lights", { kind: "comment" })), ["harbour lights"]);
    assert.equal(await u.thread("harbour lights", { kind: "suggestion" }).count(), 0);
    assert.throws(() => u.thread("x", { kind: "comments" }), /thread kind must be "any", "comment" or "suggestion"/);
  } finally {
    await pool.close();
  }
});

test("pressSuggest presses a refused Suggest edit once the toast over it has gone; NEGATIVE: Playwright's click hangs on it and force lands on the toast", async () => {
  const pool = users();
  try {
    const u = await pool.user();
    await openApp(u);
    const sel = await u.selectBetween({ sel: "#p1", exact: "lazy dog" }, { sel: "#p2", exact: "A second" });
    assert.equal(sel.via, "drag");
    const button = u.page.locator(".selection-fab", { hasText: "Suggest edit" }).first();
    assert.equal(await button.getAttribute("aria-disabled"), "true", "the stand-in refuses a selection across paragraphs");

    // NEGATIVE: why the lib does not use Playwright's click here.
    await assert.rejects(button.click({ timeout: 1_000 }), /Timeout 1000ms exceeded/, "click waits for enabled, which aria-disabled never becomes");
    await u.page.evaluate(() => window.showToast("an earlier refusal", 1_500));
    await button.click({ force: true });
    assert.deepEqual(await u.page.evaluate(() => [window.suggestPresses, window.toastClicks]), [0, 1], "force clicked the toast lying over the button, not the button");
    await u.poll(async () => (await u.page.locator(".toast").count()) === 0, { what: "the toast to go" });

    // The lib: waits the toast out, then one real press.
    await u.page.evaluate(() => window.showToast("an earlier refusal", 1_500));
    const mark = u.toastMark();
    const t0 = Date.now();
    const r = await u.pressSuggest({ refused: true });
    const waited = Date.now() - t0;
    assert.equal(r.refused, true);
    assert.equal(r.reason, REASON.across, "the reason is the button's title");
    assert.ok(waited >= 1_000, `it waited for the toast to go (${waited} ms)`);
    assert.deepEqual(await u.page.evaluate(() => [window.suggestPresses, window.toastClicks, window.refusals]), [1, 1, [REASON.across]], "one press reached the button, none the toast");
    assert.equal((await u.waitForToast(REASON.across, { since: mark, timeout: 5_000 })).text, REASON.across);
    assert.deepEqual(await u.suggestState(), { open: false }, "a refusal opens no form");

    // An expectation that disagrees with the button throws before any press.
    await assert.rejects(u.pressSuggest({ refused: false }), /Suggest edit is refused here \(aria-disabled, "A suggestion stays within one paragraph\."\), not offered/);
    await assert.rejects(u.suggest("anything"), /Suggest edit is refused here/, "suggest() on a refused selection says so instead of hanging");
    assert.equal(await u.page.evaluate(() => window.suggestPresses), 1, "neither pressed");
    await assert.rejects(u.pressSuggest({ refused: "yes" }), /refused is true, false or null/);

    // A press that can never land: the toast stays.
    await u.page.evaluate(() => window.showToast("a toast that stays", 60_000));
    await assert.rejects(u.pressSuggest({ timeout: 700 }), /Suggest edit was not the topmost element at its own centre .* within 700 ms \(the page's div\.toast\.toast-error is\); nothing was pressed/);
    assert.equal(await u.page.evaluate(() => window.suggestPresses), 1);
  } finally {
    await pool.close();
  }
});

test("pressSuggest on an offered selection opens the form, which suggestState reads: prefilled, focused, caret at the end", async () => {
  const pool = users();
  try {
    const u = await pool.user();
    await openApp(u);
    await u.selectText("#p2", "harbour lights");
    await assert.rejects(u.pressSuggest({ refused: true }), /Suggest edit is offered here \(not aria-disabled\), not refused/);
    const r = await u.pressSuggest({ refused: false });
    assert.deepEqual({ refused: r.refused, reason: r.reason }, { refused: false, reason: null });
    const state = await u.poll(async () => {
      const s = await u.suggestState();
      return s.open && s.focused ? s : null;
    }, { timeout: 5_000, what: "the focused form" });
    assert.deepEqual(state, { open: true, quote: "harbour lights", value: "harbour lights", start: 14, end: 14, focused: true, hint: "Leave it empty to suggest deleting it.", note: "", submitDisabled: true });
    await u.page.keyboard.press("Escape");
    assert.deepEqual(await u.suggestState(), { open: false });
  } finally {
    await pool.close();
  }
});

test("suggest(replacement, {keyboard: true}) types from the caret and reports what it sent; NEGATIVE: with the caret at the start it throws before Enter, where fill() would have sent", async () => {
  const pool = users();
  try {
    const u = await pool.user();
    await openApp(u);
    await u.selectText("#p2", "harbour lights");
    const before = posts.length;
    const r = await u.suggest("harbour beacons", { keyboard: true, note: "brighter" });
    assert.deepEqual(r.opened, { open: true, quote: "harbour lights", value: "harbour lights", start: 14, end: 14, focused: true, hint: "Leave it empty to suggest deleting it.", note: "", submitDisabled: true });
    assert.equal(r.value, "harbour beacons");
    assert.equal(r.response?.status, 200);
    assert.deepEqual(r.response.postJson, { exact: "harbour lights", replacement: "harbour beacons", note: "brighter" });
    assert.deepEqual(posts.slice(before), [{ exact: "harbour lights", replacement: "harbour beacons", note: "brighter" }]);
    assert.deepEqual(await u.page.evaluate(() => window.fieldKeys), [..."Backspace ".repeat(6).trim().split(" "), ..."beacons"], "six Backspaces over \"lights\", then \"beacons\" key by key; Enter went from the note field");
    assert.deepEqual(await u.suggestState(), { open: false });

    // A deletion: Backspace over everything.
    await u.page.evaluate(() => { window.fieldKeys = []; });
    await u.selectText("#p1", "lazy");
    const del = await u.suggest("", { keyboard: true });
    assert.equal(del.value, "");
    assert.deepEqual(posts.at(-1), { exact: "lazy", replacement: "", note: "" });
    assert.deepEqual(await u.page.evaluate(() => window.fieldKeys), ["Backspace", "Backspace", "Backspace", "Backspace", "Enter"]);

    // NEGATIVE: the caret at the start. Keyboard mode sees it and sends nothing…
    await u.page.evaluate(() => { window.caretAtStart = true; });
    await u.selectText("#p2", "harbour lights");
    const n = posts.length;
    await assert.rejects(
      u.suggest("harbour beacons", { keyboard: true }),
      /typed at the caret, the suggestion field holds "beaconsharbour lights", not "harbour beacons" \(it opened holding "harbour lights", selection 0–0\); nothing was sent/,
    );
    assert.equal(posts.length, n, "nothing was sent");
    await u.page.keyboard.press("Escape");
    // …where fill() cannot see the caret at all, and sends.
    await u.selectText("#p2", "harbour lights");
    const filled = await u.suggest("harbour beacons");
    assert.equal(filled.value, "harbour beacons");
    assert.equal(filled.opened.open, true);
    assert.equal(posts.length, n + 1, "fill() sent it");

    await assert.rejects(u.suggest("two\nlines", { keyboard: true }), /cannot type a line break or tab/);
  } finally {
    await pool.close();
  }
});

test("suggest() throws as soon as the refusal toast shows, not when its timeout runs out", async () => {
  const pool = users();
  try {
    const u = await pool.user();
    await openApp(u);
    await u.selectText("#p2", "lanterns");
    const t0 = Date.now();
    await assert.rejects(u.suggest("REFUSE-ME", { timeout: 20_000 }), /suggestion refused: You already have 20 suggestions waiting on this version\./);
    assert.ok(Date.now() - t0 < 8_000, `refused within ${Date.now() - t0} ms`);
    assert.equal((await u.suggestState()).open, true, "the form stays open, as the app's does");
  } finally {
    await pool.close();
  }
});

test("selectBetween drags across paragraphs, a <br>, a list and a table, honours occurrence, and falls back to the Range when the drag cannot reach or is covered", async () => {
  const pool = users();
  try {
    const u = await pool.user();
    await openApp(u);
    const frame = await u.frame();
    const ends = () => frame.evaluate(() => {
      const r = getSelection().getRangeAt(0);
      const id = (n) => (n.nodeType === 3 ? n.parentElement : n).closest("[id]")?.id ?? null;
      return [id(r.startContainer), id(r.endContainer)];
    });
    // Mouse presses that reach the frame's document, counted from the top page (the frame runs no script of its own).
    await u.page.evaluate(() => {
      window.frameDowns = 0;
      document.querySelector("iframe.doc-frame").contentDocument.addEventListener("mousedown", () => { window.frameDowns += 1; });
    });
    const frameDowns = () => u.page.evaluate(() => window.frameDowns);
    const cases = [
      [{ sel: "#p1", exact: "lazy dog" }, { sel: "#p2", exact: "A second" }, "lazy dog near the riverbank.\nA second", ["p1", "p2"]],
      [{ sel: "#pbr", exact: "the verse" }, { sel: "#pbr", exact: "second line" }, "the versesecond line", ["pbr", "pbr"]],
      [{ sel: "#listbox", exact: "Before the list" }, { sel: "#listbox", exact: "after the list" }, "Before the lista single list item worth editingafter the list", ["listbox", "listbox"]],
      [{ sel: "#tablebox", exact: "Before the table" }, { sel: "#tablebox", exact: "after the table" }, "Before the tablea table cell worth editingafter the table", ["tablebox", "tablebox"]],
      [{ sel: "#rep", exact: "echo", occurrence: 1 }, { sel: "#rep", exact: "three" }, "echo two, echo three", ["rep", "rep"]],
      [{ sel: "#p1", exact: "quick" }, { sel: "#p1", exact: "fox" }, "quick brown fox", ["p1", "p1"]],
    ];
    for (const [from, to, text, at] of cases) {
      const r = await u.selectBetween(from, to);
      assert.deepEqual(r, { via: "drag", text }, `${from.sel} "${from.exact}" → ${to.sel} "${to.exact}"`);
      assert.deepEqual(await ends(), at, "the selection starts and ends in the elements named");
      assert.equal((await selectionBetween(frame, from, to)).ok, true);
    }
    assert.equal(await u.page.locator(".selection-fab", { hasText: "Suggest edit" }).getAttribute("aria-disabled"), null, "the toolbar followed: one paragraph is offered");
    assert.equal(await frameDowns(), cases.length, "each drag pressed the mouse in the frame once, so the count below is not vacuous");

    // Out of reach: the far end is below the frame's painted box, so no drag at all (no press in the frame); the Range instead.
    const far = await u.selectBetween({ sel: "#p1", exact: "quick" }, { sel: "#far", exact: "far end" });
    assert.equal(far.via, "range-fallback");
    assert.ok(far.text.startsWith("quick brown fox") && far.text.endsWith("The far end"), far.text.slice(0, 80));
    assert.deepEqual(await ends(), ["p1", "far"]);
    assert.equal(await frameDowns(), cases.length, "an end out of reach is never dragged to: no press reached the frame");

    // NEGATIVE: a cover over the frame takes the drag; the drag selected nothing, and the result says so.
    await frame.evaluate(() => getSelection().removeAllRanges());
    await u.page.evaluate(() => window.cover(true));
    // fab: false, so it is the result, not the toolbar's wait, that says what the drag did.
    const covered = await u.selectBetween({ sel: "#p1", exact: "lazy dog" }, { sel: "#p2", exact: "A second" }, { fab: false });
    assert.deepEqual(covered, { via: "range-fallback", text: "lazy dog near the riverbank.\nA second" });
    assert.deepEqual(await ends(), ["p1", "p2"]);
    assert.equal(await frameDowns(), cases.length, "the cover took the press: none reached the frame");
    await u.page.locator(".selection-fab").first().waitFor({ state: "visible", timeout: 5_000 });
    await u.page.evaluate(() => window.cover(false));

    await assert.rejects(u.selectBetween({ sel: "#p2", exact: "A second" }, { sel: "#p1", exact: "lazy dog" }), /"lazy dog" in #p1 comes before "A second" in #p2/);
    await assert.rejects(u.selectBetween({ sel: "#p1", exact: "nowhere" }, { sel: "#p2", exact: "A second" }), /"nowhere" not found in #p1/);
    await assert.rejects(u.selectBetween({ sel: "#p1", exact: "" }, { sel: "#p2", exact: "A second" }), /selectBetween from is \{sel, exact, occurrence\?\} with a non-empty exact/);
  } finally {
    await pool.close();
  }
});

test("setSelectionBetween and selectionBetween: set a Range across elements with no mouse, and say whether the selection is it", async () => {
  const pool = users();
  try {
    const u = await pool.user();
    await openApp(u);
    const frame = await u.frame();
    const from = { sel: "#p1", exact: "fox" };
    const to = { sel: "#li", exact: "single" };
    const text = await setSelectionBetween(frame, from, to);
    assert.ok(text.startsWith("fox jumps") && text.endsWith("a single"), text);
    assert.deepEqual(await selectionBetween(frame, from, to), { want: text, text, startIn: true, endIn: true, ok: true });
    await setSelectionBetween(frame, { sel: "#p2", exact: "harbour" }, { sel: "#p2", exact: "lights" });
    const other = await selectionBetween(frame, from, to);
    assert.equal(other.ok, false, "NEGATIVE: another selection is not it");
    assert.deepEqual([other.startIn, other.endIn, other.text], [false, false, "harbour lights"]);
    await frame.evaluate(() => getSelection().removeAllRanges());
    assert.equal((await selectionBetween(frame, from, to)).ok, false, "NEGATIVE: no selection is not it");
    await assert.rejects(setSelectionBetween(frame, { sel: "#p1", exact: "x", occurrence: -1 }, to), /occurrence is a whole number/);
    await assert.rejects(setSelectionBetween(frame, { sel: "#nope", exact: "x" }, to), /no element #nope/);
  } finally {
    await pool.close();
  }
});

test("frameText {withoutOwn} leaves out the app's own nodes by VALUE and keeps the author's data-bshd and highlighted text; NEGATIVE: the raw text has the overlay", async () => {
  const pool = users();
  try {
    const u = await pool.user();
    await openApp(u);
    const frame = await u.frame();
    const before = await bodyHash(frame);
    const raw = await frameText(frame);
    assert.equal(raw, await frame.evaluate(() => document.body.textContent), "with no option it is body.textContent, as before");
    assert.match(raw, /alice@example\.com/, "NEGATIVE: the raw text holds the peer overlay's labels…");
    assert.match(raw, /\.peer\{outline/, "…and the injected stylesheet");
    const clean = await frameText(frame, { withoutOwn: true });
    const expected = await frame.evaluate(() => {
      const c = document.body.cloneNode(true);
      c.querySelector("#bshd-peers").remove();
      c.querySelector('style[data-bshd="peer-style"]').remove();
      return c.textContent;
    });
    assert.equal(clean, expected, "exactly the body's text less the two own nodes");
    assert.doesNotMatch(clean, /alice@example\.com|bob@example\.com|\.peer\{/);
    assert.match(clean, /AUTHOR-OWN/, "a data-bshd value that is not the app's is the author's, and kept");
    assert.match(clean, /Highlighted quick words\./, "a highlight wrapper's text is kept");
    assert.equal(await frameText(frame, { selector: "#hl", withoutOwn: true }), "Highlighted quick words.");
    assert.equal(await frameText(frame, { selector: "#hl" }), "Highlighted quick words.");
    assert.equal(await frameText(frame, { selector: "#bshd-peers", withoutOwn: true }), "", "inside the overlay, nothing");
    assert.equal(await frameText(frame, { selector: "#bshd-peers" }), "alice@example.combob@example.com");
    const named = await frameText(frame, { withoutOwn: ["whatever"] });
    assert.ok(!named.includes("AUTHOR-OWN") && named.includes("alice@example.com"), "a list names the values to leave out instead");
    await assert.rejects(frameText(frame, { selector: "#nope" }), /no element #nope/);
    await assert.rejects(frameText(frame, { withoutOwn: "peers" }), /withoutOwn is true or a list/);
    assert.deepEqual(await bodyHash(frame), before, "read in place: the document is unchanged");
    assert.equal(await frame.evaluate(() => document.querySelectorAll('[data-bshd="peers"] .peer').length), 2);
  } finally {
    await pool.close();
  }
});
