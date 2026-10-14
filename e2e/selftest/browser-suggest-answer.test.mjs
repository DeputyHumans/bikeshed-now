// SPDX-License-Identifier: Apache-2.0
// Self-test: User.suggest's refusal carries the page's own POST /suggestion answer, so Hosting's cut-off behind an error toast is the stack not answering and any other answer the product's refusal (SPEC §6, §12).

/**
 * Hermetic: a local server serves an app page with a document frame, a
 * Suggest edit button and the suggestion form, whose submit POSTs
 * /suggestion and shows an error toast for anything but a 200 (the app does
 * the same, Hosting's 504 included). The answer depends on the replacement:
 * "REFUSE-409" a quick 409 with the product's words, "CUT-504" a 504 the
 * harness stamps as Hosting's cut-off, "TWICE" a 500 then (the page sending
 * again) the cut-off, and anything else a 200. "LOCAL-REFUSE" is refused by
 * the form itself, which sends nothing. A self-test cannot wait out
 * Hosting's minute: a 504 the server marks with `x-e2e-cutoff` has its entry
 * stamped as taking 60,010 ms (the Hosting emulator's own, measured) as the
 * user records it. Needs Chrome.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { BrowserPool } from "../lib/browser.mjs";
import { stackDidNotAnswer, unanswered } from "../lib/test.mjs";

const CUTOFF_ANSWER_MS = 60_010;
const LIMIT = "You already have 20 suggestions waiting on this version. Wait for some to be decided, or withdraw one.";

const DOC = `<!doctype html><html><head><style>body{font:16px/1.5 sans-serif;margin:16px}</style></head>
<body><p id="p1">The quick brown fox jumps over the lazy dog near the riverbank.</p>
<p id="p2">A second paragraph mentions lanterns and harbour lights at dusk.</p></body></html>`;

const APP = `<!doctype html><html><head><style>
body{margin:0;font:14px sans-serif}
.selection-fab-bar{position:absolute;left:700px;top:40px;display:none}
.selection-fab{height:34px;padding:0 12px}
.toast-stack{position:absolute;left:700px;top:400px}
.suggest-popover{position:absolute;left:700px;top:100px;width:340px;background:#fff;border:1px solid #888}
</style></head><body>
<div class="viewer"><div class="viewer-body" data-comments="closed">
<iframe class="doc-frame" sandbox="allow-same-origin" src="/content/d/v1/index.html" style="position:absolute;left:20px;top:20px;width:640px;height:400px;border:0"></iframe>
<div class="selection-fab-bar" role="toolbar" aria-label="Selection"><button type="button" class="selection-fab" id="suggest">Suggest edit</button></div>
</div></div>
<div class="toast-stack"></div>
<script>
  window.showToast = (text) => {
    const t = document.createElement("div");
    t.className = "toast toast-error";
    t.setAttribute("role", "alert");
    t.innerHTML = "<span></span>";
    t.firstChild.textContent = text;
    document.querySelector(".toast-stack").appendChild(t);
    setTimeout(() => t.remove(), 4000);
  };
  const bar = document.querySelector(".selection-fab-bar");
  let quote = "";
  const frameDoc = () => document.querySelector("iframe.doc-frame").contentDocument;
  const update = () => {
    const sel = frameDoc().getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) { bar.style.display = "none"; return; }
    quote = sel.getRangeAt(0).toString().trim();
    bar.style.display = "inline-flex";
  };
  document.querySelector("iframe.doc-frame").addEventListener("load", () => frameDoc().addEventListener("selectionchange", update));
  document.getElementById("suggest").addEventListener("pointerdown", (e) => { e.preventDefault(); openForm(quote); });
  const post = (exact, replacement, attempt) => fetch("/suggestion", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ exact, replacement, attempt }) });
  function openForm(exact) {
    document.querySelector(".suggest-popover")?.remove();
    const pop = document.createElement("div");
    pop.className = "suggest-popover";
    pop.setAttribute("role", "dialog");
    pop.setAttribute("aria-label", "Suggest an edit");
    pop.innerHTML = '<form class="suggest-form"><span class="suggest-quote"></span><textarea rows="2"></textarea><button type="submit">Suggest</button></form>';
    pop.querySelector(".suggest-quote").textContent = exact;
    const field = pop.querySelector("textarea");
    field.value = exact;
    const submit = async () => {
      if (field.value === "LOCAL-REFUSE") { window.showToast("A suggestion can only change text."); return; }
      let r = await post(exact, field.value, 1);
      if (r.status === 500) r = await post(exact, field.value, 2); // the page sending again
      if (r.ok) { pop.remove(); return; }
      let j = null;
      try { j = await r.json(); } catch {}
      window.showToast(j?.error ?? "Could not save the suggestion. Try again.");
    };
    field.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void submit(); } });
    pop.querySelector("form").addEventListener("submit", (e) => { e.preventDefault(); void submit(); });
    document.body.appendChild(pop);
    setTimeout(() => { field.focus(); field.setSelectionRange(field.value.length, field.value.length); }, 30);
  }
</script></body></html>`;

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
        const send = (status, json, headers = {}) => {
          res.statusCode = status;
          for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
          if (json === null) {
            res.setHeader("content-type", "text/plain");
            return res.end("Timed out waiting for function to respond.");
          }
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(json));
        };
        if (got.replacement === "REFUSE-409") return send(409, { error: LIMIT });
        if (got.replacement === "CUT-504" || (got.replacement === "TWICE" && got.attempt === 2)) return send(504, null, { "x-e2e-cutoff": "1" });
        if (got.replacement === "TWICE") return send(500, { error: "busy" });
        if (got.replacement === "QUICK-504") return send(504, null);
        send(200, { annId: `a-${posts.length}`, versionId: "v1" });
      });
      return;
    }
    res.setHeader("content-type", "text/html");
    if (path === "/") return res.end(APP);
    if (path === "/content/d/v1/index.html") return res.end(DOC);
    res.statusCode = 404;
    res.end("no");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  target = { kind: "local", runId: "selftest-suggest-answer", origin: `http://127.0.0.1:${port}`, stack: { ports: { hosting: port } }, capabilities: new Set(["local"]) };
});

let pool = null;
let reader = null;
after(async () => {
  await pool?.close();
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
});

/** The reader, on a fresh app page, its frame loaded; each 504 the server marks is recorded as Hosting's cut-off. */
async function onApp() {
  pool ??= new BrowserPool({ target });
  if (!reader) {
    reader = await pool.user({ name: "reader" });
    const push = reader.responses.push.bind(reader.responses);
    reader.responses.push = (...entries) => push(...entries.map((e) => (e.status === 504 && e.headers?.["x-e2e-cutoff"] === "1" ? Object.assign(e, { ms: CUTOFF_ANSWER_MS }) : e)));
  }
  await reader.page.mouse.move(0, 0);
  await reader.goto("/");
  await reader.waitForFrame();
  return reader;
}

const rejection = (p) => p.then(() => assert.fail("expected a rejection"), (e) => e);

test("a refusal the product answered carries that answer: the page's POST /suggestion since the press, never one before it; the stack answered, so nothing excuses it", async () => {
  const u = await onApp();
  await u.selectText("#p2", "lanterns");
  const ok = await u.suggest("lamps");
  assert.equal(ok.response.status, 200, "an earlier suggestion on this page, answered 200");
  await u.selectText("#p1", "lazy dog");
  const mark = u.responseMark();
  const err = await rejection(u.suggest("REFUSE-409", { timeout: 20_000 }));
  assert.equal(err.message, `reader: suggestion refused: ${LIMIT}`, "the message as before");
  assert.equal(err.toast?.kind, "error");
  assert.ok(err.response, "the refusal carries the page's answer");
  assert.deepEqual([err.response.method, err.response.path, err.response.status], ["POST", "/suggestion", 409]);
  assert.ok(err.response.seq >= mark, `the answer to this press (seq ${err.response.seq}), not the earlier 200 (mark ${mark})`);
  assert.deepEqual(err.response.postJson, { exact: "lazy dog", replacement: "REFUSE-409", attempt: 1 });
  assert.equal(stackDidNotAnswer(err), null, "a refusal is the product's: judged");
  assert.equal(unanswered(err), null, "so untilLanded throws it as it is");
});

test("Hosting's cut-off behind the toast is on the refusal, and stackDidNotAnswer names it; a quick 504 is an answer, and judged", async () => {
  const u = await onApp();
  await u.selectText("#p1", "riverbank");
  const err = await rejection(u.suggest("CUT-504", { timeout: 20_000 }));
  assert.match(err.message, /^reader: suggestion refused: Could not save the suggestion\. Try again\.$/);
  assert.deepEqual([err.response?.status, err.response?.ms], [504, CUTOFF_ANSWER_MS]);
  assert.equal(stackDidNotAnswer(err), `POST /suggestion answered 504 after ${CUTOFF_ANSWER_MS} ms, Hosting's cut-off for a function that has not answered`);
  assert.equal(unanswered(err), stackDidNotAnswer(err), "untilLanded would send it again");

  await u.selectText("#p2", "harbour lights");
  const quick = await rejection(u.suggest("QUICK-504", { timeout: 20_000 }));
  assert.equal(quick.response?.status, 504);
  assert.ok(quick.response.ms < 59_000);
  assert.equal(stackDidNotAnswer(quick), null, "a quick 504 is an answer");
});

test("when the page sent more than once behind one toast, the refusal carries the latest answer", async () => {
  const u = await onApp();
  await u.selectText("#p1", "quick brown");
  const mark = u.responseMark();
  const err = await rejection(u.suggest("TWICE", { timeout: 20_000 }));
  assert.deepEqual(u.findResponses({ method: "POST", path: "/suggestion" }, { since: mark }).map((r) => r.status), [500, 504], "two answers since the press");
  assert.deepEqual([err.response?.status, err.response?.postJson?.attempt], [504, 2], "the latest, which the toast reports");
  assert.match(stackDidNotAnswer(err) ?? "", /^POST \/suggestion answered 504 after 60010 ms/);
});

test("NEGATIVE: a refusal the form made itself sent nothing: its response is null, it is the case's to judge, and it is thrown within moments", async () => {
  const u = await onApp();
  await u.selectText("#p2", "at dusk");
  const before = posts.length;
  const t0 = Date.now();
  const err = await rejection(u.suggest("LOCAL-REFUSE", { timeout: 20_000 }));
  assert.ok(Date.now() - t0 < 8_000, `thrown within ${Date.now() - t0} ms`);
  assert.equal(err.message, "reader: suggestion refused: A suggestion can only change text.");
  assert.ok("response" in err);
  assert.equal(err.response, null);
  assert.equal(posts.length, before, "nothing was sent");
  assert.equal(stackDidNotAnswer(err), null);
});
