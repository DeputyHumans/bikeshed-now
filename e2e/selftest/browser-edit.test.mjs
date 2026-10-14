// SPDX-License-Identifier: Apache-2.0
// Self-test: the autosave that carries the last key is waited for even when an earlier save answers after it, the More menu is read and chosen from without toggling it shut, downloads are captured, and the Firestore listen gate holds only what it matches (SPEC §6a, §11, §12).

/**
 * Hermetic: a local server stands in for the viewer. Its page holds the
 * editing frame `iframe.doc-frame` (sandboxed `allow-same-origin`, no
 * scripts) whose `input` events the page debounces into POST /draft one
 * AUTOSAVE_MS later, with the save state in `.save-state[data-state]`, as
 * app/src/viewer/useInlineEditor.ts does: a save in flight when a key goes in
 * still ends on "saved". The server can hold a draft save until the test lets
 * it go, or refuse it. The page's More menu is a toggle with headed groups,
 * separators and a disabled item (app/src/components/Menu.tsx); its entries
 * download a blob, a server attachment, or fail with an error toast
 * (app/src/export/html.ts). `window.listen(body)` POSTs a WebChannel body to
 * the Firestore listen path, `window.backchannel()` GETs it. Needs Chrome.
 */

import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { BrowserPool } from "../lib/browser.mjs";
import { decodeListenBody, holdListen, LISTEN_CHANNEL } from "../lib/sync.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DOC = `<!doctype html><html><head><meta charset="utf-8"><style>body{font:16px/1.5 sans-serif;margin:16px}</style></head>
<body><p id="p1">The first paragraph ends here.</p>
<p id="p2">The second paragraph stays the same.</p></body></html>`;

const ZIP = Buffer.from("PK\u0003\u0004 a bundle the server assembled", "latin1");

const APP = `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;font:14px sans-serif}
.viewer-toolbar{position:absolute;left:0;top:0;width:1240px;height:44px}
.viewer-toolbar-actions{position:absolute;left:900px;top:8px}
.save-state{position:absolute;left:20px;top:12px}
.menu{position:absolute;left:900px;top:40px;width:240px;background:#fff;border:1px solid #888;z-index:30}
.menu-item{display:block;width:100%;text-align:left}
.toast-stack{position:absolute;left:400px;top:700px}
</style></head><body>
<div class="viewer">
<div class="viewer-toolbar"><span class="save-state" data-state="idle" role="status"></span>
<div class="viewer-toolbar-actions"><button type="button" class="icon-btn" id="more" aria-label="More actions" aria-haspopup="menu" aria-expanded="false">...</button></div></div>
<div class="viewer-body">
<iframe class="doc-frame" sandbox="allow-same-origin" src="/draft/d-one/index.html" style="position:absolute;left:40px;top:60px;width:800px;height:500px;border:0"></iframe>
</div></div>
<div class="toast-stack"></div>
<script>
  // --- toasts (app/src/components/Toast.tsx) ---
  window.showToast = (text, kind) => {
    const t = document.createElement("div");
    t.className = "toast" + (kind ? " " + kind : "");
    t.setAttribute("role", kind === "toast-error" ? "alert" : "status");
    t.innerHTML = "<span></span>";
    t.firstChild.textContent = text;
    document.querySelector(".toast-stack").appendChild(t);
    return t;
  };

  // --- the editor: input, a debounce, POST /draft (app/src/viewer/useInlineEditor.ts) ---
  const AUTOSAVE_MS = 1000;
  const stateEl = document.querySelector(".save-state");
  const setState = (s) => stateEl.setAttribute("data-state", s);
  const frame = document.querySelector("iframe.doc-frame");
  const doc = () => frame.contentDocument;
  let timer = null;
  async function flush() {
    setState("saving");
    try {
      const r = await fetch("/draft", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ docId: "d-one", baseVersion: "v1", html: doc().body.innerHTML }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Could not save");
      setState("saved");
    } catch (e) {
      setState("error");
    }
  }
  function onInput() {
    setState("dirty");
    clearTimeout(timer);
    timer = setTimeout(() => void flush(), AUTOSAVE_MS);
  }
  frame.addEventListener("load", () => {
    doc().body.setAttribute("contenteditable", "true");
    doc().addEventListener("input", onInput);
  });
  window.stopEditing = () => {
    doc().body.removeAttribute("contenteditable");
    doc().removeEventListener("input", onInput);
  };

  // --- downloads (app/src/export/html.ts) ---
  async function saveFrom(url, name) {
    const busy = window.showToast("Downloading…", "toast-busy");
    try {
      const r = await fetch(url, { credentials: "same-origin" });
      if (!r.ok) throw new Error("Could not fetch the document (" + r.status + ").");
      const href = URL.createObjectURL(await r.blob());
      const a = document.createElement("a");
      a.href = href;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(href), 1000);
    } catch (e) {
      window.showToast(e.message, "toast-error");
    } finally {
      busy.remove();
    }
  }
  window.zipLink = () => {
    const a = document.createElement("a");
    a.href = "/download/d-one/v1";
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  // --- the More menu: a toggle with headed groups (app/src/components/Menu.tsx) ---
  window.forks = 0;
  window.menuPresses = 0;
  const ENTRIES = [
    { heading: "Download" },
    { label: "Download the HTML", act: () => saveFrom("/content/d-one/v1/index.html", "Download-probe.html") },
    { label: "Download the Markdown source", act: () => saveFrom("/content/d-one/v1/index.md", "Download-probe.md") },
    { label: "Download everything as a .zip", act: () => window.zipLink() },
    { label: "Download a broken file", act: () => saveFrom("/content/d-one/v1/broken.html", "broken.html") },
    { label: "Export an image…", act: () => {} },
    { sep: true },
    { heading: "This document" },
    { label: "Fork", act: () => { window.forks += 1; } },
    { label: "Activity", disabled: true, reason: "Nothing to show yet" },
    { sep: true },
    { label: "Present full screen", act: () => {} },
    { sep: true },
    { heading: "Versions" },
    { label: "v2 — current", disabled: true },
    { label: "v1", act: () => {} },
  ];
  const more = document.getElementById("more");
  let menu = null;
  function closeMenu() {
    menu?.remove();
    menu = null;
    more.setAttribute("aria-expanded", "false");
  }
  function openMenu() {
    menu = document.createElement("div");
    menu.className = "menu";
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", "More actions");
    for (const e of ENTRIES) {
      const el = document.createElement(e.label ? "button" : "div");
      if (e.sep) el.className = "menu-sep";
      else if (e.heading) { el.className = "menu-label"; el.textContent = e.heading; }
      else {
        el.type = "button";
        el.className = "menu-item";
        el.setAttribute("role", "menuitem");
        el.innerHTML = '<svg aria-hidden="true" width="10" height="10"></svg>';
        el.append(e.label);
        if (e.disabled) { el.disabled = true; if (e.reason) el.title = e.reason; }
        el.addEventListener("click", () => { closeMenu(); e.act?.(); });
      }
      menu.appendChild(el);
    }
    more.after(menu);
    more.setAttribute("aria-expanded", "true");
    menu.querySelector(".menu-item:not(:disabled)")?.focus();
  }
  more.addEventListener("click", () => { window.menuPresses += 1; if (menu) closeMenu(); else openMenu(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && menu) { closeMenu(); more.focus(); } });
  document.addEventListener("mousedown", (e) => { if (menu && !menu.contains(e.target) && !more.contains(e.target)) closeMenu(); });
  window.menuOpen = () => menu !== null;

  // --- the Firestore listen channel: a forward POST, the back channel GET ---
  window.listen = (body, port) => {
    const base = port ? "http://127.0.0.1:" + port : "";
    const sentAt = Date.now();
    void fetch(base + ${JSON.stringify(LISTEN_CHANNEL)} + "?VER=8&database=projects%2Fdemo-bikeshed%2Fdatabases%2F(default)&RID=7&CVER=22&zx=a1&t=1", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body }).catch(() => {});
    return sentAt;
  };
  window.backchannel = () => {
    const sentAt = Date.now();
    void fetch(${JSON.stringify(LISTEN_CHANNEL)} + "?VER=8&RID=rpc&SID=s1&CI=0&TYPE=xmlhttp&zx=b2&t=1").catch(() => {});
    return sentAt;
  };
</script></body></html>`;

// --- the server: drafts it can hold or refuse, downloads, the listen channel ---
let drafts = [];
let holdDrafts = false;
let heldDrafts = [];
let nextDraftStatus = null;
let arrivals = [];
let strayHits = 0;
let server;
let stray;
let target;

function releaseDrafts() {
  holdDrafts = false;
  for (const answer of heldDrafts.splice(0)) answer();
}

before(async () => {
  server = http.createServer((req, res) => {
    const path = new URL(req.url, "http://x").pathname;
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (path === LISTEN_CHANNEL) {
        arrivals.push({ at: Date.now(), method: req.method, body });
        res.setHeader("content-type", "text/plain");
        return res.end("ok");
      }
      if (req.method === "POST" && path === "/draft") {
        const rec = { at: Date.now(), html: JSON.parse(body).html, status: nextDraftStatus ?? 200, answeredAt: null };
        nextDraftStatus = null;
        drafts.push(rec);
        const answer = () => {
          rec.answeredAt = Date.now();
          res.writeHead(rec.status, { "content-type": "application/json" });
          res.end(rec.status === 200 ? JSON.stringify({ draft: { baseVersion: "v1", bytes: rec.html.length } }) : JSON.stringify({ error: "stale" }));
        };
        if (holdDrafts) heldDrafts.push(answer);
        else answer();
        return;
      }
      if (path === "/download/d-one/v1") {
        res.writeHead(200, { "content-type": "application/zip", "content-disposition": 'attachment; filename="bundle.zip"' });
        return res.end(ZIP);
      }
      if (path === "/content/d-one/v1/broken.html") {
        res.statusCode = 500;
        return res.end("broken");
      }
      res.setHeader("content-type", "text/html; charset=utf-8");
      if (path === "/") return res.end(APP);
      if (path === "/draft/d-one/index.html" || path === "/content/d-one/v1/index.html") return res.end(DOC);
      if (path === "/content/d-one/v1/index.md") {
        res.setHeader("content-type", "text/markdown");
        return res.end("# The source\n");
      }
      res.statusCode = 404;
      res.end("no");
    });
  });
  // Not one of the stack's ports: the tripwire must stop anything sent here.
  stray = http.createServer((req, res) => {
    strayHits += 1;
    res.end("reached");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  await new Promise((r) => stray.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  target = { kind: "local", runId: "selftest-edit", origin: `http://127.0.0.1:${port}`, stack: { ports: { hosting: port } }, capabilities: new Set(["local"]) };
});

beforeEach(() => {
  releaseDrafts();
  drafts = [];
  nextDraftStatus = null;
  arrivals = [];
  strayHits = 0;
});

/** One Chrome and one page for the file, navigated afresh by every test (see browser-suggest.test.mjs). */
let pool = null;
let shared = null;
async function user() {
  pool ??= new BrowserPool({ target });
  shared ??= await pool.user({ name: "editor" });
  await shared.page.mouse.move(0, 0);
  return shared;
}
after(async () => {
  releaseDrafts();
  await pool?.close();
  for (const s of [server, stray]) {
    s.closeAllConnections?.();
    await new Promise((r) => s.close(r));
  }
});

async function openApp(u) {
  await u.goto("/");
  await u.waitForFrame();
  await u.poll(() => u.page.evaluate(() => document.querySelector("iframe.doc-frame").contentDocument.body.getAttribute("contenteditable") === "true"), { what: "the editor" });
}

const p1Text = (u) => u.page.evaluate(() => document.querySelector("iframe.doc-frame").contentDocument.getElementById("p1").textContent);

test("typeAndAutosave waits for the save that carries the last key while a save begun before it answers first; NEGATIVE: the save state alone says saved before that save has begun", async () => {
  const u = await user();
  await openApp(u);

  // A first edit, whose save the server holds: it is in flight when the last key goes in.
  holdDrafts = true;
  await u.typeInFrame("#p1", "A", { delay: 15 });
  await u.poll(() => drafts.length === 1, { timeout: 5_000, interval: 20, what: "the first save to reach the server" });

  const pending = u.typeAndAutosave("#p1", "B");
  await u.poll(async () => (await p1Text(u)).endsWith("AB"), { timeout: 5_000, interval: 10, what: "the last key in the document" });
  releaseDrafts();

  // NEGATIVE: the save that began before the last key ends on "saved" without it.
  await u.poll(async () => (await u.saveState()) === "saved", { timeout: 2_000, interval: 10, what: "the first save to end" });
  assert.equal(drafts.length, 1, "the save with the last key has not even begun");
  assert.ok(drafts[0].html.includes("here.A<") && !drafts[0].html.includes("AB"), `the draft the page calls saved lacks the last key: ${drafts[0].html}`);

  const r = await pending;
  assert.equal(drafts.length, 2, "the save that carries the last key was sent");
  assert.ok(drafts[0].answeredAt > r.after, "the earlier save answered after the last key: the race this waits through");
  assert.deepEqual({ status: r.status, saveState: r.saveState, clock: r.clock, inputs: r.inputs }, { status: 200, saveState: "saved", clock: "browser", inputs: 1 });
  assert.ok(r.startedAt >= r.after && r.startedAt - r.after >= 900, `started a debounce after the last key (+${Math.round(r.startedAt - r.after)} ms)`);
  assert.ok(r.entry.postJson.html.includes("here.AB<"), "the save waited for is the one with the last key");
  assert.deepEqual(r.body, { draft: { baseVersion: "v1", bytes: drafts[1].html.length } });
  assert.ok(drafts[1].html.includes("here.AB<"));
  assert.ok(r.typed && r.typed.focus.hasFocus, "typeInFrame's result rides along");
});

test("typeAndAutosave: a no-op edit's save, a refused save, and NEGATIVE: typing where no editor listens throws at once; waitForAutosave refuses a mark that is not a time and times out loudly", async () => {
  const u = await user();
  await openApp(u);
  const before = await u.page.evaluate(() => document.querySelector("iframe.doc-frame").contentDocument.getElementById("p2").textContent);

  const noop = await u.typeAndAutosave("#p2", "x", { thenBackspace: 1 });
  assert.deepEqual({ status: noop.status, inputs: noop.inputs, saveState: noop.saveState }, { status: 200, inputs: 2, saveState: "saved" });
  assert.ok(noop.entry.postJson.html.includes(`>${before}<`), "the save holds the paragraph as it was");
  assert.equal(drafts.length, 1, "one save for the two keys");

  nextDraftStatus = 409;
  await assert.rejects(u.typeAndAutosave("#p1", "C"), /editor: the autosave after the last edit was answered 409 \{"error":"stale"\} \(wanted 200\)/);
  nextDraftStatus = 409;
  const refused = await u.typeAndAutosave("#p1", "D", { expectStatus: null });
  assert.deepEqual([refused.status, refused.saveState, refused.body], [409, "error", { error: "stale" }]);
  nextDraftStatus = 409;
  const listed = await u.typeAndAutosave("#p1", "E", { expectStatus: [200, 409] });
  assert.equal(listed.status, 409);

  await assert.rejects(u.waitForAutosave({ after: u.responseMark() }), /waitForAutosave after is the time of the last edit, Date\.now\(\) taken once it was made, got \d+/);
  await assert.rejects(u.waitForAutosave({ after: Date.now(), expectStatus: "200" }), /expectStatus is a status, a list of them, or null, got "200"/);
  await assert.rejects(u.typeAndAutosave("#p1", ""), /has nothing to type/);
  await assert.rejects(u.typeAndAutosave("#p1", "z", { thenBackspace: -1 }), /thenBackspace is a count of presses, got -1/);

  // No save follows a moment with no edit, and the wait says what it saw.
  await assert.rejects(
    u.waitForAutosave({ after: Date.now(), timeout: 1_200 }),
    /editor: no POST \/draft started after the last edit was answered within 1200 ms \(save state "error"; POST \/draft seen, by start relative to the edit: -\d+ ms 200, .*-\d+ ms 409\)/,
  );

  // NEGATIVE: with no editor on the frame the keys fire no input event; that is said at once.
  await u.page.evaluate(() => window.stopEditing());
  const t0 = Date.now();
  await assert.rejects(u.typeAndAutosave("#p1", "y", { timeout: 15_000 }), /editor: typing "y" into #p1 fired no input event in the document, so no autosave follows/);
  assert.ok(Date.now() - t0 < 5_000, `at once, not after the 15 s timeout (${Date.now() - t0} ms)`);
});

test("moreMenu reads every group in one go and leaves the menu closed; menuGroup by heading (null when absent); chooseMenu refuses a missing or disabled item with what is there; NEGATIVE: the trigger is a toggle", async () => {
  const u = await user();
  await openApp(u);
  const menuOpen = () => u.page.evaluate(() => window.menuOpen());
  const item = (label, disabled = false, reason = null) => ({ label, disabled, reason });

  const m = await u.moreMenu();
  assert.deepEqual(m.groups, [
    { heading: "Download", items: [item("Download the HTML"), item("Download the Markdown source"), item("Download everything as a .zip"), item("Download a broken file"), item("Export an image…")] },
    { heading: "This document", items: [item("Fork"), item("Activity", true, "Nothing to show yet")] },
    { heading: null, items: [item("Present full screen")] },
    { heading: "Versions", items: [item("v2 — current", true), item("v1")] },
  ]);
  assert.deepEqual(m.labels, m.groups.flatMap((g) => g.items.map((i) => i.label)));
  assert.equal(await menuOpen(), false, "left closed");

  assert.deepEqual(await u.menuGroup("Download"), ["Download the HTML", "Download the Markdown source", "Download everything as a .zip", "Download a broken file", "Export an image…"]);
  assert.deepEqual(await u.menuGroup("Versions"), ["v2 — current", "v1"]);
  assert.equal(await u.menuGroup("Nope"), null, "no such heading");
  await assert.rejects(u.menuGroup(""), /menuGroup takes a heading/);

  await assert.rejects(u.chooseMenu("Nope"), /editor: the More menu has no "Nope" \(it offers "Download the HTML", .*"v1"\)/);
  assert.equal(await menuOpen(), false);
  await assert.rejects(u.chooseMenu("Activity", { timeout: 3_000 }), /editor: "Activity" in the More menu is disabled \("Nothing to show yet"\)/);
  await assert.rejects(u.chooseMenu("v2 — current", { timeout: 3_000 }), /"v2 — current" in the More menu is disabled$/);
  assert.equal(await menuOpen(), false);
  assert.equal(await u.page.evaluate(() => window.forks), 0, "nothing was chosen");
  assert.deepEqual(await u.chooseMenu("Fork"), { ...item("Fork"), heading: "This document" });
  assert.deepEqual([await u.page.evaluate(() => window.forks), await menuOpen()], [1, false]);

  // Already open: read where it is, never pressed shut first.
  await u.page.locator("#more").click();
  const presses = await u.page.evaluate(() => window.menuPresses);
  assert.deepEqual((await u.moreMenu()).labels, m.labels);
  assert.deepEqual([await menuOpen(), await u.page.evaluate(() => window.menuPresses)], [false, presses], "closed with Escape, not another press");
  await u.page.locator("#more").click();
  await u.chooseMenu("Fork");
  assert.equal(await u.page.evaluate(() => window.forks), 2, "chosen from a menu that was already open");

  // Focus in the frame: Escape goes to the document, and the trigger closes the menu instead.
  await u.page.locator("#more").click();
  await u.clickInFrame("#p2");
  assert.equal(await menuOpen(), true, "a click in the frame leaves the menu open");
  assert.deepEqual((await u.moreMenu()).labels, m.labels);
  assert.equal(await menuOpen(), false, "closed by its trigger");

  // NEGATIVE: one more press of the trigger on an open menu closes it.
  await u.page.locator("#more").click();
  await u.page.locator("#more").click();
  assert.equal(await menuOpen(), false);
});

test("download captures a blob the page saves and an attachment the server sends; NEGATIVE: an error toast fails it at once; a function starts one; none started times out", async () => {
  const u = await user();
  await openApp(u);

  const html = await u.download("Download the HTML");
  assert.deepEqual({ filename: html.filename, text: html.bytes.toString("utf8"), blob: html.url.startsWith("blob:") }, { filename: "Download-probe.html", text: DOC, blob: true });
  const md = await u.download("Download the Markdown source");
  assert.deepEqual({ filename: md.filename, text: md.bytes.toString("utf8") }, { filename: "Download-probe.md", text: "# The source\n" });
  const zip = await u.download("Download everything as a .zip");
  assert.deepEqual({ filename: zip.filename, equal: zip.bytes.equals(ZIP), url: new URL(zip.url).pathname }, { filename: "bundle.zip", equal: true, url: "/download/d-one/v1" });

  const t0 = Date.now();
  await assert.rejects(u.download("Download a broken file"), /editor: no download from "Download a broken file": the app said "Could not fetch the document \(500\)\."/);
  assert.ok(Date.now() - t0 < 5_000, `at once, not after the 30 s timeout (${Date.now() - t0} ms)`);

  const viaFn = await u.download(() => u.page.evaluate(() => window.zipLink()));
  assert.ok(viaFn.bytes.equals(ZIP));
  await assert.rejects(u.download(42), /download takes a More-menu label or a function that starts the download, got number/);
  await assert.rejects(u.download(async () => {}, { timeout: 1_000 }), /editor: no download from the action within 1000 ms \(toasts: none\)/);
  await assert.rejects(u.download("Activity", { timeout: 2_000 }), /"Activity" in the More menu is disabled/);
});

/** A WebChannel forward body, as the Firestore web SDK sends it. */
const channelBody = (addTarget) => `count=1&ofs=0&req0___data__=${encodeURIComponent(JSON.stringify({ database: "projects/demo-bikeshed/databases/(default)", addTarget }))}`;
const ROOT = "projects/demo-bikeshed/databases/(default)/documents";
const VERSIONS = channelBody({ query: { structuredQuery: { from: [{ collectionId: "versions" }] }, parent: `${ROOT}/docs/d-one` }, targetId: 4 });
const META = channelBody({ documents: { documents: [`${ROOT}/docs/d-one`] }, targetId: 2 });
const isVersions = (b) => b.includes("/docs/d-one") && b.includes('"collectionId":"versions"');

test("holdListen holds the matching listen POSTs for ms and lets the rest through at once; release() and stop() let them go; NEGATIVE: percent-encoded, the raw body says nothing a predicate looks for", async () => {
  const u = await user();
  await openApp(u);
  const send = (body) => u.page.evaluate((b) => window.listen(b), body);
  const arrived = (sentAt, method = "POST") => arrivals.find((a) => a.method === method && a.at >= sentAt - 5);

  // NEGATIVE: what the SDK sends hides both the path and the query from a match on the raw body.
  assert.equal(isVersions(VERSIONS), false, "the raw body does not show what the read asks for");
  assert.equal(isVersions(decodeListenBody(VERSIONS).decoded), true, "the decoded body does");
  assert.deepEqual(decodeListenBody(VERSIONS).messages[0].addTarget.query.structuredQuery.from, [{ collectionId: "versions" }]);

  const gate = await holdListen(u.page, isVersions, 1_200);
  let tMeta;
  let tGet;
  let tVer;
  try {
    tVer = await send(VERSIONS);
    tMeta = await send(META);
    tGet = await u.page.evaluate(() => window.backchannel());
    await u.poll(() => arrivals.length === 3, { timeout: 6_000, interval: 20, what: "all three to arrive" });
  } finally {
    await gate.stop();
  }
  const meta = arrived(tMeta);
  const get = arrived(tGet, "GET");
  const ver = arrivals.find((a) => a.body === VERSIONS);
  assert.ok(meta.at - tMeta < 600, `the meta read went straight through (${meta.at - tMeta} ms)`);
  assert.ok(get.at - tGet < 600, `the back channel went straight through (${get.at - tGet} ms)`);
  assert.ok(ver.at - tVer >= 1_150, `the versions read was held (${ver.at - tVer} ms)`);
  assert.equal(gate.heldAt.length, 1);
  assert.deepEqual(gate.records.map((r) => [r.i, r.messages[0].addTarget.targetId, r.releasedAt - r.at >= 1_190]), [[0, 4, true]]);
  assert.ok(gate.records[0].body.includes('"collectionId":"versions"'), "records keep the decoded body");

  // ms null: held until release(); a later match is held again; stop() lets it go and the gate is gone.
  const manual = await holdListen(u, () => true);
  try {
    const t1 = await send(META);
    await sleep(700);
    assert.equal(arrivals.filter((a) => a.at >= t1).length, 0, "held, with no timer");
    manual.release();
    await u.poll(() => arrivals.some((a) => a.at >= t1), { timeout: 3_000, interval: 20, what: "the released request" });
    const t2 = await send(META);
    await sleep(500);
    assert.equal(arrivals.filter((a) => a.at >= t2).length, 0, "a match after release() is held too");
    const stopped = await manual.stop();
    await u.poll(() => arrivals.some((a) => a.at >= t2), { timeout: 3_000, interval: 20, what: "the request stop() let go" });
    assert.equal(stopped.length, 2);
  } finally {
    await manual.stop();
  }
  const t3 = await send(VERSIONS);
  await u.poll(() => arrivals.some((a) => a.at >= t3), { timeout: 2_000, interval: 20, what: "a request after stop()" });

  // A predicate that throws holds nothing.
  const throwing = await holdListen(u.page, () => {
    throw new Error("bad predicate");
  }, 5_000);
  try {
    const t4 = await send(VERSIONS);
    await u.poll(() => arrivals.some((a) => a.at >= t4), { timeout: 2_000, interval: 20, what: "the request a throwing predicate let through" });
    assert.equal(throwing.heldAt.length, 0);
  } finally {
    await throwing.stop();
  }

  await assert.rejects(holdListen({}, () => true), /holdListen: host is a Playwright Page or BrowserContext, or a User/);
  await assert.rejects(holdListen(u.page, "versions"), /holdListen: match is a function of the decoded body, got string/);
  await assert.rejects(holdListen(u.page, () => true, -1), /holdListen: ms is how long to hold each request, or null for until release\(\), got -1/);
});

test("holdListen lets what it holds go on to the context's isolation tripwire: NEGATIVE: a held request to a port that is not the stack's is stopped and recorded, never sent", async () => {
  const u = await user();
  await openApp(u);
  const port = stray.address().port;
  const breachesBefore = u.log.breaches.length;
  const gate = await holdListen(u.page, () => true, 100);
  try {
    await u.page.evaluate(({ b, port }) => window.listen(b, port), { b: META, port });
    await u.poll(() => u.log.breaches.slice(breachesBefore).some((b) => b.url.includes(`:${port}${LISTEN_CHANNEL}`)), { timeout: 5_000, interval: 20, what: "the tripwire to record it" });
    await sleep(300);
  } finally {
    await gate.stop();
  }
  assert.equal(gate.heldAt.length, 1, "the gate held it first");
  assert.equal(strayHits, 0, "the request never left the browser");
  // Clear what this test made the tripwire record: it is the point of the test, not a breach of the suite's.
  u.log.breaches.splice(breachesBefore);
});
