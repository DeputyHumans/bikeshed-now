// SPDX-License-Identifier: Apache-2.0
// Self-test: User.awaitEdit waits for edit mode after a press made elsewhere (in the page at a shared instant, or with its draft frame held) without pressing again, and enterEdit is that press plus the same waits (SPEC §6b, §12).

/**
 * Hermetic: a local server stands in for the viewer. Its toolbar's Edit
 * button is a TOGGLE, as the product's is (Edit / Stop editing): a press
 * shows the Formatting toolbar at once and points the document frame at
 * /draft/, whose load makes the body editable, relabels the button and shows
 * the share state ("Joining…", then "Shared" or off after 300 ms). Until
 * the draft frame has loaded the button still reads Edit, so a second press
 * while the frame is held would leave edit mode again: the hazard of
 * pressing twice. `window.presses` counts every press. Needs Chrome.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { BrowserPool } from "../lib/browser.mjs";
import { holdRequests, syncPages } from "../lib/sync.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DOC = `<!doctype html><html><head><meta charset="utf-8"></head><body><p id="p1">One paragraph.</p></body></html>`;

const APP = `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;font:14px sans-serif}</style></head><body>
<div class="viewer-toolbar"><button type="button" id="edit" aria-label="Edit">Edit</button></div>
<div class="viewer-body"><iframe class="doc-frame" sandbox="allow-same-origin" src="/content/d-one/v1/index.html" style="width:700px;height:300px;border:0"></iframe></div>
<script>
  const btn = document.getElementById("edit");
  const frame = document.querySelector("iframe.doc-frame");
  window.presses = 0;
  window.shareAfter = "shared";
  window.editing = false;
  btn.addEventListener("click", () => {
    window.presses += 1;
    if (window.editing) leave();
    else enter();
  });
  function enter() {
    window.editing = true;
    const bar = document.createElement("div");
    bar.className = "edit-toolbar";
    bar.setAttribute("role", "toolbar");
    bar.setAttribute("aria-label", "Formatting");
    bar.innerHTML = '<button type="button">Done</button>';
    bar.querySelector("button").addEventListener("click", leave);
    document.querySelector(".viewer-toolbar").after(bar);
    frame.onload = () => {
      if (!window.editing) return;
      frame.contentDocument.body.setAttribute("contenteditable", "true");
      btn.setAttribute("aria-label", "Stop editing");
      const st = document.createElement("span");
      st.className = "share-state";
      st.setAttribute("data-state", "joining");
      bar.appendChild(st);
      setTimeout(() => st.setAttribute("data-state", window.shareAfter), 300);
    };
    frame.src = "/draft/d-one/index.html";
  }
  function leave() {
    window.editing = false;
    document.querySelector('[aria-label="Formatting"]')?.remove();
    btn.setAttribute("aria-label", "Edit");
    frame.onload = null;
    frame.src = "/content/d-one/v1/index.html";
  }
</script></body></html>`;

let server;
let target;
let pool = null;

before(async () => {
  server = http.createServer((req, res) => {
    const path = new URL(req.url, "http://x").pathname;
    res.setHeader("content-type", "text/html; charset=utf-8");
    if (path === "/content/d-one/v1/index.html" || path === "/draft/d-one/index.html") return res.end(DOC);
    res.end(APP);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  target = { kind: "local", runId: "selftest-await-edit", origin: `http://127.0.0.1:${port}`, stack: { ports: { hosting: port } }, capabilities: new Set(["local"]) };
});

after(async () => {
  await pool?.close();
  await new Promise((r) => server.close(r));
});

async function user(name, { shareAfter = "shared" } = {}) {
  pool ??= new BrowserPool({ target });
  const u = await pool.user({ name });
  await u.goto("/");
  await u.waitForFrame({ match: /\/content\// });
  await u.page.evaluate((s) => (window.shareAfter = s), shareAfter);
  return u;
}

/** Runs IN the page (syncPages serialises it): press the toolbar's Edit button once. */
function pressEditInPage() {
  const b = document.querySelector('.viewer-toolbar [aria-label="Edit"]');
  if (!b) throw new Error("no Edit button");
  b.click();
  return true;
}

const pageState = (u) => u.page.evaluate(() => ({ presses: window.presses, editing: window.editing, src: document.querySelector("iframe.doc-frame").getAttribute("src") }));

test("a press made in the page at a shared instant (syncPages): awaitEdit waits for the toolbar, the editable /draft/ frame and Shared, marks inEdit, and never presses again", async () => {
  const u = await user("t1");
  assert.equal(u.inEdit, false);
  const fire = await syncPages([u.page], pressEditInPage, { leadMs: 200 });
  assert.equal(fire.fires[0].result, true, JSON.stringify(fire.fires));
  const r = await u.awaitEdit({ waitShared: true, timeout: 10_000 });
  assert.equal(r.share, "shared");
  assert.match(r.frame.src, /\/draft\//);
  assert.equal(r.frame.editable, "true");
  assert.equal(u.inEdit, true, "settleLive reads the user as in edit");
  await sleep(300);
  assert.deepEqual(await pageState(u), { presses: 1, editing: true, src: "/draft/d-one/index.html" }, "one press: awaitEdit pressed nothing");
});

test("a press whose /draft/ frame is held (holdRequests, SYNC-H): awaitEdit is still waiting while the frame is held, never presses again, and resolves once it is let go", async () => {
  const u = await user("t2", { shareAfter: "off" });
  const hold = holdRequests([u.page], /\/draft\//, 1, { method: "GET", predicate: (req) => req.isNavigationRequest(), timeoutMs: 10_000 });
  let settled = null;
  try {
    await hold.installed;
    await u.page.locator('.viewer-toolbar [aria-label="Edit"]').first().click();
    await hold.held;
    const waiting = u.awaitEdit({ waitShared: false, timeout: 10_000 }).then(
      (r) => (settled = { ok: true, r }),
      (err) => (settled = { ok: false, err }),
    );
    await sleep(1_000);
    assert.equal(settled, null, `awaitEdit resolved while the draft frame was still held: ${JSON.stringify(settled?.r?.share ?? settled?.err?.message)}`);
    assert.equal(u.inEdit, true, "marked in edit at once: the press was made");
    assert.deepEqual(await pageState(u), { presses: 1, editing: true, src: "/draft/d-one/index.html" }, "still one press while it waits (a second would have left edit mode)");
    await hold.release();
    await waiting;
  } finally {
    await hold.unroute();
  }
  assert.equal(settled.ok, true, settled.err?.message);
  assert.equal(settled.r.share, "off", "without waitShared: anything but joining (here editing alone)");
  assert.match(settled.r.frame.src, /\/draft\//);
  assert.deepEqual(await pageState(u), { presses: 1, editing: true, src: "/draft/d-one/index.html" });
});

test("no press at all: awaitEdit runs out like enterEdit's waits do, with the user already marked in edit", async () => {
  const u = await user("t3");
  await assert.rejects(u.awaitEdit({ waitShared: true, timeout: 1_500 }), /Timeout|timeout|exceeded/);
  assert.equal(u.inEdit, true);
  assert.equal((await pageState(u)).presses, 0, "it pressed nothing");
});

test("enterEdit is the press plus awaitEdit's waits; done() clears inEdit, and a later press made elsewhere enters again", async () => {
  const u = await user("t4");
  const r = await u.enterEdit({ waitShared: true, timeout: 10_000 });
  assert.equal(r.share, "shared");
  assert.match(r.frame.src, /\/draft\//);
  assert.equal(u.inEdit, true);
  assert.equal((await pageState(u)).presses, 1);
  await u.done({ timeout: 10_000 });
  assert.equal(u.inEdit, false);
  await u.waitForFrame({ match: /\/content\//, timeout: 10_000 });
  await syncPages([u.page], pressEditInPage, { leadMs: 100 });
  const again = await u.awaitEdit({ waitShared: true, timeout: 10_000 });
  assert.equal(again.share, "shared");
  assert.equal(u.inEdit, true);
  assert.deepEqual(await pageState(u), { presses: 2, editing: true, src: "/draft/d-one/index.html" });
});

test("waitShared waits for Shared itself: an editor whose share state ends off (editing alone) runs out; without it, off is an answer", async () => {
  const u = await user("t5", { shareAfter: "off" });
  await syncPages([u.page], pressEditInPage, { leadMs: 100 });
  await assert.rejects(u.awaitEdit({ waitShared: true, timeout: 2_000 }), /share-state "shared"/, "off is not Shared");
  const r = await u.awaitEdit({ waitShared: false, timeout: 5_000 });
  assert.equal(r.share, "off");
  assert.equal((await pageState(u)).presses, 1, "two awaits, one press");
});
