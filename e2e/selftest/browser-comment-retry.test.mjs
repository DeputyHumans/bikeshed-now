// SPDX-License-Identifier: Apache-2.0
// Self-test: User.comment presses again when a loaded emulator refused the press with a rules "Service call error", and only then; when every press is refused so, the refusal carries a stackCut (SPEC §6, §12).

/**
 * Hermetic: a local server stands in for the viewer, as in
 * browser-comment.test.mjs. Its Comment press is refused, with the app's
 * error toast and the frame's selection cleared, the first `service` times
 * with the Firestore emulator's "Service call error. Function: [get], …"
 * (or, with `?refuse=1`, every time with "Missing or insufficient
 * permissions."); after that it lists the new thread and selects it once
 * acknowledged. `window.state.presses` counts the presses. Needs Chrome.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { BrowserPool, RULES_SERVICE_ERROR_RE } from "../lib/browser.mjs";
import { stackDidNotAnswer } from "../lib/test.mjs";

const SERVICE_TOAST = "false for 'create' @ L212, Service call error. Function: [get], Argument: [path_value { segments { simple: \"databases\" } }].";

const DOC = `<!doctype html><html><body><p id="p1">The first passage, about lanterns over the harbour wall.</p></body></html>`;

const APP = `<!doctype html><html><head><style>
body{margin:0;font:14px sans-serif}
.comments-panel{position:absolute;left:760px;top:20px;width:420px;border:1px solid #888}
.selection-fab-bar{position:absolute;left:200px;top:440px;display:none}
.toast-stack{position:absolute;left:20px;top:520px}
</style></head><body>
<div class="viewer"><div class="viewer-body" data-comments="open">
<iframe class="doc-frame" sandbox="allow-same-origin" src="/content/d-one/v1/index.html" style="position:absolute;left:20px;top:20px;width:700px;height:400px;border:1px solid #888"></iframe>
<div class="selection-fab-bar" role="toolbar" aria-label="Selection"><button type="button" class="selection-fab">Comment</button></div>
<aside class="comments-panel" aria-label="Comments"><ul class="comments-list"></ul></aside>
</div></div>
<div class="toast-stack"></div>
<script>
  const q = new URLSearchParams(location.search);
  let service = Number(q.get("service") ?? 0);
  const list = document.querySelector(".comments-list");
  const frameDoc = () => document.querySelector("iframe.doc-frame").contentDocument;
  const bar = document.querySelector(".selection-fab-bar");
  const update = () => {
    const sel = frameDoc().getSelection();
    bar.style.display = sel && !sel.isCollapsed && sel.rangeCount > 0 ? "inline-flex" : "none";
  };
  document.querySelector("iframe.doc-frame").addEventListener("load", () => frameDoc().addEventListener("selectionchange", update));
  window.state = { presses: 0 };
  const toast = (text) => {
    const t = document.createElement("div");
    t.className = "toast toast-error";
    t.setAttribute("role", "alert");
    t.innerHTML = "<span></span>";
    t.firstChild.textContent = text;
    document.querySelector(".toast-stack").appendChild(t);
  };
  document.querySelector(".selection-fab").addEventListener("click", () => {
    window.state.presses += 1;
    const quote = frameDoc().getSelection().toString().trim();
    if (q.get("refuse") === "1") { frameDoc().getSelection().removeAllRanges(); return toast("Missing or insufficient permissions."); }
    if (service > 0) { service -= 1; frameDoc().getSelection().removeAllRanges(); return toast(${JSON.stringify(SERVICE_TOAST)}); }
    const li = document.createElement("li");
    li.className = "thread";
    li.setAttribute("aria-selected", "false");
    li.innerHTML = '<p class="thread-quote"></p><textarea rows="2" placeholder="Reply"></textarea>';
    li.querySelector(".thread-quote").textContent = quote;
    const box = li.querySelector("textarea");
    box.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      const c = document.createElement("p");
      c.className = "comment-body";
      c.textContent = box.value.trim();
      box.value = "";
      li.insertBefore(c, box);
    });
    list.appendChild(li);
    setTimeout(() => li.setAttribute("aria-selected", "true"), 300);
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
  target = { kind: "local", runId: "selftest-comment-retry", origin: `http://127.0.0.1:${port}`, stack: { ports: { hosting: port } }, capabilities: new Set(["local"]) };
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
const QUOTE = "lanterns over the harbour wall";
const presses = (u) => u.page.evaluate(() => window.state.presses);
const comments = (u) => u.page.evaluate(() => Array.from(document.querySelectorAll(".comment-body")).map((b) => b.textContent));

test("RULES_SERVICE_ERROR_RE reads the emulator's words, and nothing else", () => {
  assert.ok(RULES_SERVICE_ERROR_RE.test(SERVICE_TOAST));
  assert.ok(!RULES_SERVICE_ERROR_RE.test("Missing or insufficient permissions."));
  assert.ok(!RULES_SERVICE_ERROR_RE.test("Null value error. for 'create' @ L12"));
});

test("comment {retryServiceError, reselect}: presses refused with a Service call error are made again, the passage selected again first; it resolves with how many were refused", async () => {
  const u = await reader("?service=2");
  try {
    await u.selectText("#p1", QUOTE);
    let reselected = 0;
    const out = await u.comment("third time lucky", { timeout: 10_000, retryServiceError: 2, reselect: async () => { reselected += 1; await u.selectText("#p1", QUOTE); } });
    assert.deepEqual(out, { quote: QUOTE, serviceErrors: 2 });
    assert.deepEqual([await presses(u), reselected], [3, 2]);
    assert.deepEqual(await comments(u), ["third time lucky"]);
  } finally {
    await u.close();
  }
});

test("comment {retryServiceError}: when every press is refused so, the last refusal throws with serviceErrors and a stackCut, which the case's judges read as the stack not answering", async () => {
  const u = await reader("?service=9");
  try {
    await u.selectText("#p1", QUOTE);
    const err = await u.comment("never", { timeout: 10_000, retryServiceError: 2, reselect: () => u.selectText("#p1", QUOTE) }).then(() => null, (e) => e);
    assert.match(err?.message ?? "", /^reader: the Comment press made no thread: the app said ".*Service call error.*" \(3 press\(es\), each refused with "Service call error"\)$/);
    assert.equal(err.serviceErrors, 3);
    assert.equal(err.stackCut, `reader: the emulator failed a rule's get() ("Service call error") on 3 Comment press(es) in a row, so the rules never judged the write`);
    assert.equal(stackDidNotAnswer(err), err.stackCut);
    assert.equal(await presses(u), 3);
  } finally {
    await u.close();
  }
});

test("NEGATIVE: any other refusal throws at once, however many retries are allowed, with no stackCut", async () => {
  const u = await reader("?refuse=1");
  try {
    await u.selectText("#p1", QUOTE);
    let reselected = 0;
    const t0 = Date.now();
    const err = await u.comment("never", { timeout: 10_000, retryServiceError: 3, reselect: () => (reselected += 1) }).then(() => null, (e) => e);
    assert.match(err?.message ?? "", /the app said "Missing or insufficient permissions\."$/);
    assert.equal(err.stackCut, undefined);
    assert.equal(stackDidNotAnswer(err), null, "the rules' verdict: judged");
    assert.deepEqual([await presses(u), reselected], [1, 0]);
    assert.ok(Date.now() - t0 < 5_000, "at once");
  } finally {
    await u.close();
  }
});

test("NEGATIVE: without the option a Service call error throws at once, as it always did, with no stackCut and no serviceErrors", async () => {
  const u = await reader("?service=1");
  try {
    await u.selectText("#p1", QUOTE);
    const err = await u.comment("once", { timeout: 10_000 }).then(() => null, (e) => e);
    assert.match(err?.message ?? "", /Service call error/);
    assert.deepEqual([err.stackCut, err.serviceErrors, await presses(u)], [undefined, undefined, 1]);
    assert.equal(stackDidNotAnswer(err), null);
    await assert.rejects(u.comment("x", { retryServiceError: 2 }), /retryServiceError needs reselect/);
    await assert.rejects(u.comment("x", { retryServiceError: -1, reselect: () => {} }), /retryServiceError is how many more presses/);
    await assert.rejects(u.comment("x", { reselect: "again" }), /reselect is async \(\) => …/);
    assert.equal(await presses(u), 1, "a bad option presses nothing");
  } finally {
    await u.close();
  }
});
