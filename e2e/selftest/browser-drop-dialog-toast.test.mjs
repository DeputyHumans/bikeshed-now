// SPDX-License-Identifier: Apache-2.0
// Self-test: User.dropFiles drops real Files, answerDialog answers the prompt, confirm or alert an action raises, dismissToasts presses Dismiss and waits for each toast to go (SPEC §2, §12).

/**
 * Hermetic: a local server serves one page that stands in for the app's
 * pieces these drive. Its drop zone claims a drag only when it carries Files
 * (as app/src/hooks/useFileDrop.ts does) and reads each dropped File's name,
 * type and bytes back; its toast stack is Toast.tsx's markup, and a toast's
 * Dismiss removes it one render later; its buttons raise window.prompt,
 * confirm and alert and keep what each returned. Everything is read back from
 * the page's side, never from the lib's own return value alone. Needs Chrome.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { BrowserPool, DROP_EVENTS, DROP_EVENT_TYPES, TOAST_DISMISS_LABEL } from "../lib/browser.mjs";

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>stand-in</title><link rel="icon" href="data:,"></head><body>
<div id="zone" style="width:300px;height:120px;border:1px solid">drop here</div>
<div id="inert" style="width:300px;height:60px">not a drop zone</div>
<button id="ask">Ask</button><button id="confirm">Confirm</button><button id="alert">Alert</button><button id="twice">Twice</button>
<div class="toast-stack"></div>
<script>
  window.__dropped = [];
  window.__events = [];
  window.__answers = [];
  const zone = document.getElementById("zone");
  const files = (e) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
  for (const type of ["dragenter", "dragover", "dragleave"]) zone.addEventListener(type, (e) => { window.__events.push(type); if (files(e)) e.preventDefault(); });
  zone.addEventListener("drop", async (e) => {
    window.__events.push("drop");
    if (!files(e)) return;
    e.preventDefault();
    const list = Array.from(e.dataTransfer.files);
    const read = await Promise.all(list.map(async (f) => {
      const bytes = new Uint8Array(await f.arrayBuffer());
      let bin = "";
      for (const b of bytes) bin += String.fromCharCode(b);
      return { name: f.name, type: f.type, size: f.size, b64: btoa(bin), isFile: f instanceof File };
    }));
    window.__dropped.push(read);
  });
  document.getElementById("ask").onclick = () => window.__answers.push(["prompt", window.prompt("Folder name", "Untitled folder")]);
  document.getElementById("confirm").onclick = () => window.__answers.push(["confirm", window.confirm("Delete this folder?")]);
  document.getElementById("alert").onclick = () => window.__answers.push(["alert", window.alert("Saved") ?? null]);
  document.getElementById("twice").onclick = () => { window.__answers.push(["first", window.confirm("first?")]); window.__answers.push(["second", window.confirm("second?")]); };
  // Toast.tsx's markup: a span with the message, then Dismiss, an action, or nothing (busy).
  window.__toast = (kind, message, button, removes = true) => {
    const el = document.createElement("div");
    el.className = "toast" + (kind === "info" ? "" : " toast-" + kind);
    el.setAttribute("role", kind === "error" ? "alert" : "status");
    if (kind === "busy") { const s = document.createElement("span"); s.className = "spinner"; el.append(s); }
    const span = document.createElement("span");
    span.textContent = message;
    el.append(span);
    if (button) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "toast-action";
      b.textContent = button;
      // React removes it on its next render, not inside the click.
      b.onclick = () => { if (removes) setTimeout(() => el.remove(), 80); };
      el.append(b);
    }
    document.querySelector(".toast-stack").append(el);
  };
</script></body></html>`;

let server;
let target;
let pool;
let u;

before(async () => {
  server = http.createServer((req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(PAGE);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  target = { kind: "local", runId: "selftest-drop-dialog", origin: `http://127.0.0.1:${port}`, stack: { ports: { hosting: port } }, capabilities: new Set(["local"]) };
  pool = new BrowserPool({ target });
  u = await pool.user({ name: "dropper" });
  await u.goto("/");
});

after(async () => {
  await pool?.close();
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
});

const reset = () => u.page.evaluate(() => {
  window.__dropped = [];
  window.__events = [];
  window.__answers = [];
  document.querySelector(".toast-stack").replaceChildren();
});

test("dropFiles: real File objects with their names, types and exact bytes reach the drop handler; each event says whether the page claimed it", async () => {
  await reset();
  const binary = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
  const md = "# Café notes\n\nnaïve — ✓\n";
  const got = await u.dropFiles("#zone", [
    { name: "page.html", data: Buffer.from("<!doctype html><title>T</title>"), type: "text/html" },
    { name: "notes.md", data: md, type: "" },
    { name: "bytes.bin", buffer: binary, mimeType: "application/octet-stream" },
  ]);
  assert.deepEqual(DROP_EVENTS, ["dragenter", "dragover", "drop"]);
  assert.deepEqual(got, [{ type: "dragenter", claimed: true }, { type: "dragover", claimed: true }, { type: "drop", claimed: true }]);
  const dropped = await u.page.waitForFunction(() => window.__dropped.length === 1 && window.__dropped[0]).then((h) => h.jsonValue());
  assert.deepEqual(dropped.map((f) => [f.name, f.type, f.size, f.isFile]), [["page.html", "text/html", 31, true], ["notes.md", "", Buffer.byteLength(md), true], ["bytes.bin", "application/octet-stream", 256, true]]);
  assert.equal(Buffer.from(dropped[1].b64, "base64").toString("utf8"), md, "a string goes as UTF-8, byte for byte");
  assert.deepEqual(Buffer.from(dropped[2].b64, "base64"), binary, "every byte value survives");
  assert.deepEqual(await u.page.evaluate(() => window.__events), ["dragenter", "dragover", "drop"], "in the order given, on the element");
});

test("dropFiles: a Locator, a Uint8Array, and a drag that leaves without dropping", async () => {
  await reset();
  const got = await u.dropFiles(u.page.locator("#zone"), [{ name: "a.md", data: new Uint8Array([104, 105]) }], { events: ["dragenter", "dragleave"] });
  assert.deepEqual(got.map((e) => [e.type, e.claimed]), [["dragenter", true], ["dragleave", true]]);
  assert.deepEqual(await u.page.evaluate(() => [window.__events, window.__dropped]), [["dragenter", "dragleave"], []], "nothing dropped");
  assert.deepEqual(DROP_EVENT_TYPES, ["dragenter", "dragover", "dragleave", "drop"]);
});

test("NEGATIVE: an element with no drop handler claims nothing, and the drop handler sees nothing", async () => {
  await reset();
  const got = await u.dropFiles("#inert", [{ name: "x.html", data: "<p>x</p>", type: "text/html" }]);
  assert.deepEqual(got.map((e) => e.claimed), [false, false, false], "unclaimed: a real browser would navigate to the file");
  assert.deepEqual(await u.page.evaluate(() => window.__dropped), []);
});

test("dropFiles refuses what it cannot drop, before anything is dispatched", async () => {
  await reset();
  const one = [{ name: "a.md", data: "a" }];
  await assert.rejects(u.dropFiles("", one), /selector is a selector on the page or a Playwright Locator/);
  await assert.rejects(u.dropFiles("#zone", []), /files is a non-empty list/);
  await assert.rejects(u.dropFiles("#zone", [{ name: "", data: "a" }]), /files\[0\]\.name is the file's name/);
  await assert.rejects(u.dropFiles("#zone", [{ name: "a", data: 7 }]), /files\[0\]\.data is a Buffer, a Uint8Array or a string/);
  await assert.rejects(u.dropFiles("#zone", [{ name: "a", data: "a", type: 3 }]), /files\[0\]\.type is a MIME type string/);
  await assert.rejects(u.dropFiles("#zone", one, { events: ["click"] }), /events is a non-empty list of dragenter, dragover, dragleave, drop/);
  await assert.rejects(u.dropFiles("#no-such-zone", one, { timeout: 300 }), /Timeout 300ms exceeded/);
  assert.deepEqual(await u.page.evaluate(() => window.__events), [], "nothing dispatched");
});

test("answerDialog: a prompt answered with a value, one accepted with none (the page gets \"\", not its default), a confirm dismissed, an alert", async () => {
  await reset();
  const named = await u.answerDialog(() => u.page.click("#ask"), { value: "Quarterly plans" });
  assert.deepEqual(named, { type: "prompt", message: "Folder name", defaultValue: "Untitled folder", accepted: true, value: "Quarterly plans" });
  const plain = await u.answerDialog(() => u.page.click("#ask"));
  assert.deepEqual([plain.type, plain.accepted, plain.value], ["prompt", true, ""]);
  const no = await u.answerDialog(() => u.page.click("#confirm"), { accept: false });
  assert.deepEqual(no, { type: "confirm", message: "Delete this folder?", defaultValue: "", accepted: false, value: null });
  const yes = await u.answerDialog(() => u.page.click("#confirm"));
  assert.equal(yes.accepted, true);
  const told = await u.answerDialog(() => u.page.click("#alert"));
  assert.deepEqual([told.type, told.message], ["alert", "Saved"]);
  assert.deepEqual(await u.page.evaluate(() => window.__answers), [["prompt", "Quarterly plans"], ["prompt", ""], ["confirm", false], ["confirm", true], ["alert", null]], "what the page's own calls returned");
});

test("answerDialog: only the first dialog is answered; a second is dismissed by Playwright, and no listener is left behind", async () => {
  await reset();
  const first = await u.answerDialog(() => u.page.click("#twice"));
  assert.equal(first.message, "first?");
  assert.deepEqual(await u.page.evaluate(() => window.__answers), [["first", true], ["second", false]]);
  assert.equal(u.page.listenerCount("dialog"), 0);
});

test("NEGATIVE: answerDialog throws when no dialog comes, and when the action throws, and leaves no listener", async () => {
  await reset();
  await assert.rejects(u.answerDialog(() => u.page.evaluate(() => 1), { timeout: 400 }), /answerDialog: no dialog within 400 ms/);
  await assert.rejects(u.answerDialog(async () => { throw new Error("the click missed"); }, { timeout: 400 }), /the click missed/);
  assert.equal(u.page.listenerCount("dialog"), 0);
  await assert.rejects(u.answerDialog(() => u.page.click("#ask"), { accept: false, value: "x" }), /a value is typed only into a prompt that is accepted/);
  await assert.rejects(u.answerDialog("click"), /action is a function/);
  assert.deepEqual(await u.page.evaluate(() => window.__answers), [], "the refused calls raised nothing");
});

test("dismissToasts: Dismiss on every toast that has one, each gone before it returns; busy and action toasts are left", async () => {
  await reset();
  await u.page.evaluate(() => {
    window.__toast("error", "Upload failed (413).", "Dismiss");
    window.__toast("info", "Folder created", "Dismiss");
    window.__toast("busy", "Uploading 2 files", null);
    window.__toast("info", "Moved to Plans", "Undo");
    window.__toast("error", "That type is not supported.", "Dismiss");
  });
  const r = await u.dismissToasts();
  assert.equal(TOAST_DISMISS_LABEL, "Dismiss");
  assert.deepEqual(r.dismissed, [{ kind: "error", text: "Upload failed (413)." }, { kind: "info", text: "Folder created" }, { kind: "error", text: "That type is not supported." }]);
  assert.deepEqual(r.left, [{ kind: "busy", text: "Uploading 2 files" }, { kind: "info", text: "Moved to Plans" }]);
  const showing = await u.page.evaluate(() => Array.from(document.querySelectorAll(".toast-stack .toast span:not(.spinner)")).map((s) => s.textContent));
  assert.deepEqual(showing, ["Uploading 2 files", "Moved to Plans"], "gone from the page when it resolved, not a render later");
  assert.deepEqual(await u.dismissToasts(), { dismissed: [], left: r.left }, "a second call has nothing to press");
});

test("NEGATIVE: a toast whose Dismiss does not remove it makes dismissToasts throw", async () => {
  await reset();
  await u.page.evaluate(() => window.__toast("error", "Stuck", "Dismiss", false));
  await assert.rejects(u.dismissToasts({ timeout: 400 }), /dismissToasts: 1 of 1 pressed toast\(s\) still showing after 400 ms/);
});
