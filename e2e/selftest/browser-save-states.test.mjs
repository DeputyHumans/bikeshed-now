// SPDX-License-Identifier: Apache-2.0
// Self-test: User.recordSaveStates times the editor's save state and the frame's input events on the page's own clock, across an edit-mode remount (SPEC §6a, §12).

/**
 * Hermetic: a local server stands in for the viewer. The reading frame is
 * `iframe.doc-frame` with `sandbox=""` (out of the page's reach, as an
 * untrusted document's is). `enterEdit()` replaces it with a new iframe
 * element, `sandbox="allow-same-origin"` and no scripts, as edit mode does,
 * shows the toolbar's `.save-state` ("idle"), and once the frame has loaded
 * adds the editor's own `input` listener to its document from the TOP page,
 * in the bubbling phase, as app/src/viewer/useInlineEditor.ts does: "dirty"
 * at each input, "saving" one debounce (DEBOUNCE ms) after the last, then
 * POST /draft and "saved". The editor's listener also notes how many inputs
 * every recorder had already counted when it ran (`window.editorSaw`), which
 * is how the capture-phase ordering is seen. `exitEdit()` puts the reading
 * frame back. Needs Chrome.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { BrowserPool, SAVE_STATES_KEY } from "../lib/browser.mjs";

const DEBOUNCE = 400;

const DOC = `<!doctype html><html><head><script>document.documentElement.setAttribute("data-ran", "1")</script></head><body><p id="p1">First paragraph.</p><p id="p2">Second.</p></body></html>`;

const APP = `<!doctype html><html><body>
<div class="viewer-toolbar"><span id="bar"></span></div>
<div class="viewer-body"><iframe class="doc-frame" sandbox="" src="/doc" style="width:600px;height:300px"></iframe></div>
<script>
  const KEY = ${JSON.stringify(SAVE_STATES_KEY)};
  const DEBOUNCE = ${DEBOUNCE};
  window.editorSaw = [];
  window.drafts = 0;
  let timer = null;
  const setState = (s, text) => {
    let el = document.querySelector(".save-state");
    if (!el) { el = document.createElement("span"); el.className = "save-state"; document.getElementById("bar").append(el); }
    el.setAttribute("data-state", s);
    el.textContent = text ?? ({ idle: "", dirty: "Unsaved changes", saving: "Saving…", saved: "Saved", error: "Could not save" })[s];
  };
  window.setState = setState;
  const frameEl = (sandbox) => {
    const f = document.createElement("iframe");
    f.className = "doc-frame";
    f.setAttribute("sandbox", sandbox);
    f.style.cssText = "width:600px;height:300px";
    return f;
  };
  window.enterEdit = () => new Promise((resolve) => {
    const fresh = frameEl("allow-same-origin");
    fresh.addEventListener("load", () => {
      const d = fresh.contentDocument;
      d.body.setAttribute("contenteditable", "true");
      d.addEventListener("input", () => {
        const recs = window[Symbol.for(KEY)];
        window.editorSaw.push(recs ? [...recs.values()].filter((r) => !r.stopped).map((r) => r.inputs.length) : []);
        setState("dirty");
        clearTimeout(timer);
        timer = setTimeout(async () => {
          setState("saving");
          const r = await fetch("/draft", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ html: d.body.innerHTML }) });
          window.drafts += 1;
          setState(r.ok ? "saved" : "error");
        }, DEBOUNCE);
      });
      resolve(true);
    }, { once: true });
    fresh.src = "/doc?edit=" + Math.random().toString(36).slice(2);
    document.querySelector("iframe.doc-frame").replaceWith(fresh);
    setState("idle");
  });
  window.exitEdit = () => {
    document.querySelector(".save-state")?.remove();
    const f = frameEl("");
    f.src = "/doc";
    document.querySelector("iframe.doc-frame").replaceWith(f);
  };
</script></body></html>`;

let server;
let target;
let pool = null;

before(async () => {
  server = http.createServer((req, res) => {
    const path = new URL(req.url, "http://x").pathname;
    if (req.method === "POST" && path === "/draft") {
      req.resume();
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        res.end('{"draft":true}');
      });
      return;
    }
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(path === "/doc" ? DOC : APP);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  target = { kind: "local", runId: "selftest-save-states", origin: `http://127.0.0.1:${port}`, stack: { ports: { hosting: port } }, capabilities: new Set(["local"]) };
});

after(async () => {
  await pool?.close();
  await new Promise((r) => server.close(r));
});

async function user(name) {
  pool ??= new BrowserPool({ target });
  const u = await pool.user({ name });
  await u.goto("/");
  return u;
}

const editable = (u) =>
  u.poll(() => u.page.evaluate(() => document.querySelector("iframe.doc-frame")?.contentDocument?.body?.getAttribute("contenteditable") === "true").catch(() => false), { timeout: 10_000, what: "the edit frame" });

const savedAfter = (rec, n) => rec.states.filter(Boolean).filter((r) => r.s === "saved").length >= n;

test("armed before Edit: the toolbar appears, then dirty → saving → saved, the save a whole debounce after the last input on the page's clock; each input is counted before the editor's own listener runs", { timeout: 60_000 }, async () => {
  const u = await user("debounce");
  const rec = await u.recordSaveStates();
  assert.ok(Number.isFinite(rec.armedAt) && Math.abs(rec.armedAt - Date.now()) < 5_000, "armedAt is a page time near this process's Date.now()");
  await u.page.evaluate(() => window.enterEdit());
  await editable(u);
  await u.typeInFrame("#p1", "abc", { delay: 60 });
  await u.poll(() => savedAfter(rec, 1), { timeout: 10_000, what: "saved" });
  const r = await rec.read();
  assert.equal(r.armed, true);
  assert.deepEqual(r.states.map((x) => x.s), [null, "idle", "dirty", "saving", "saved"], "one row per transition: nothing shown, the toolbar, then the save");
  assert.deepEqual(r.states.map((x) => x.text), [null, "", "Unsaved changes", "Saving…", "Saved"]);
  assert.deepEqual(r.states.map((x) => x.i), [0, 1, 2, 3, 4]);
  assert.equal(r.inputs.length, 3, "three keys, three input events");
  assert.equal(r.docs, 1, "only the edit frame's document: the reading frame was out of reach, and an iframe's initial about:blank is not one");
  const saving = r.states.find((x) => x.s === "saving");
  const gap = saving.t - r.inputs.at(-1);
  assert.ok(gap >= DEBOUNCE - 1, `saving began ${gap.toFixed(1)} ms after the last input (debounce ${DEBOUNCE})`);
  assert.ok(gap < DEBOUNCE + 1_500, `and not long after (${gap.toFixed(1)} ms)`);
  for (let i = 1; i < r.states.length; i += 1) assert.ok(r.states[i].t >= r.states[i - 1].t, "times only grow");
  assert.ok(r.inputs[0] >= r.states[1].t, "the inputs came after the toolbar appeared");
  const saw = await u.page.evaluate(() => window.editorSaw);
  assert.deepEqual(saw, [[1], [2], [3]], "when the editor's listener ran, the recorder had already counted that input: capture phase, before the debounce began");
  assert.deepEqual([rec.states, rec.inputs], [r.states, r.inputs], "the live arrays hold the same rows");
  await rec.stop();
});

test("a remount is listened to as its iframe loads; stop() ends the recording; a navigation keeps every row that reached Node", { timeout: 60_000 }, async () => {
  const u = await user("remount");
  await u.page.evaluate(() => window.enterEdit());
  await editable(u);
  const rec = await u.recordSaveStates();
  await u.typeInFrame("#p2", "x", { delay: 20 });
  await u.poll(() => savedAfter(rec, 1), { timeout: 10_000, what: "the first save" });
  assert.deepEqual(await u.page.evaluate(() => window.editorSaw), [[1]], "armed AFTER the editor's listener, the recorder still counted the input first: the capture phase, not the order of registration");
  await u.page.evaluate(() => window.exitEdit());
  await u.page.evaluate(() => window.enterEdit());
  await editable(u);
  await u.typeInFrame("#p2", "yz", { delay: 20 });
  await u.poll(() => savedAfter(rec, 2), { timeout: 10_000, what: "the second save" });
  const r = await rec.read();
  assert.equal(r.inputs.length, 3, "inputs in both edit frames");
  assert.equal(r.docs, 2, "two frame documents listened to");
  assert.deepEqual(r.states.map((x) => x.s), ["idle", "dirty", "saving", "saved", null, "idle", "dirty", "saving", "saved"], "the toolbar going is a row (null), and coming back");

  const fin = await rec.stop();
  await u.typeInFrame("#p1", "q", { delay: 20 });
  await u.poll(() => u.page.evaluate(() => window.drafts >= 3), { timeout: 10_000, what: "a third save" });
  assert.deepEqual([(await rec.read()).inputs.length, (await rec.read()).states.length], [fin.inputs.length, fin.states.length], "nothing after stop()");
  assert.deepEqual([rec.inputs.length, rec.states.length], [3, 9], "the live arrays froze too");

  const nav = await u.recordSaveStates();
  await u.typeInFrame("#p1", "w", { delay: 20 });
  await u.poll(() => nav.states.filter(Boolean).some((x) => x.s === "saving"), { timeout: 10_000, what: "saving, as it reached Node" });
  await u.goto("/");
  const after = await nav.read();
  assert.equal(after.armed, false, "the page navigated: the recorder went with it");
  assert.equal(after.inputs.length, 1, "the input that reached Node before the navigation is kept");
  assert.ok(after.states.some((x) => x.s === "saving"), "and the states");
});

test("a row only when the state or its text changes: an error with a new message is a row, the same state set again is not", { timeout: 60_000 }, async () => {
  const u = await user("dedupe");
  await u.page.evaluate(() => window.enterEdit());
  await editable(u);
  const rec = await u.recordSaveStates();
  await u.page.evaluate(async () => {
    const tick = () => new Promise((r) => setTimeout(r, 30));
    window.setState("error", "Somebody published a newer version.");
    await tick();
    window.setState("error", "Somebody published a newer version.");
    await tick();
    window.setState("error", "Could not save");
    await tick();
    window.setState("saved");
    await tick();
    window.setState("saved");
    await tick();
  });
  const r = await rec.stop();
  assert.deepEqual(
    r.states.map((x) => [x.s, x.text]),
    [["idle", ""], ["error", "Somebody published a newer version."], ["error", "Could not save"], ["saved", "Saved"]],
  );
});
