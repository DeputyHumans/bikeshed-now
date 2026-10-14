// SPDX-License-Identifier: Apache-2.0
// Self-test: inFrameDoc runs a probe on the document frame from the parent's realm, and parseAndRun runs the same probe on the stored bytes (SPEC §6a, §10.1, §12).

/**
 * Hermetic: a local server stands in for the viewer with three frames.
 *   /         `iframe.doc-frame` sandbox="allow-same-origin", no scripts (the edit frame)
 *   /trusted  no sandbox (a trusted document): its own script runs, and it
 *             replaces Array.from and Array.prototype.map in ITS realm, as a
 *             document's script may
 *   /opaque   sandbox="" (an untrusted reading frame: out of the page's reach)
 * The document's script marks <html data-ran> when it runs. Needs Chrome.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { BrowserPool } from "../lib/browser.mjs";
import { docFrame, inFrameDoc } from "../lib/frame.mjs";
import { parseAndRun, probeSource } from "../lib/bytes.mjs";

const DOC = `<!doctype html><html><head><title>probe</title><script>
document.documentElement.setAttribute("data-ran", "1");
Array.from = function () { return ["poisoned"]; };
Array.prototype.map = function () { return ["poisoned"]; };
</script></head><body><p id="p1">One <b>bold</b> and <i>italic</i></p><p id="p2" data-x="2">Two <b>more</b></p><div data-bshd="whatever">theirs</div></body></html>`;

const page = (sandbox) => `<!doctype html><html><body><div class="viewer-body"><iframe class="doc-frame"${sandbox === null ? "" : ` sandbox="${sandbox}"`} src="/doc" style="width:600px;height:300px"></iframe></div></body></html>`;

let server;
let target;
let pool = null;

before(async () => {
  server = http.createServer((req, res) => {
    const path = new URL(req.url, "http://x").pathname;
    res.setHeader("content-type", "text/html; charset=utf-8");
    if (path === "/doc") return res.end(DOC);
    if (path === "/trusted") return res.end(page(null));
    if (path === "/opaque") return res.end(page(""));
    if (path === "/none") return res.end("<!doctype html><body><div class=viewer-body>no frame</div></body>");
    res.end(page("allow-same-origin"));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  target = { kind: "local", runId: "selftest-in-frame-doc", origin: `http://127.0.0.1:${port}`, stack: { ports: { hosting: port } }, capabilities: new Set(["local"]) };
});

after(async () => {
  await pool?.close();
  await new Promise((r) => server.close(r));
});

async function user(path = "/", { wait = true } = {}) {
  pool ??= new BrowserPool({ target });
  const u = await pool.user();
  await u.goto(path);
  if (wait) await u.waitForFrame();
  return u;
}

/** A structural probe, as a spec writes one: plain data out, `arg` in. */
const probe = (doc, arg) => ({
  bold: Array.from(doc.querySelectorAll(arg.sel)).map((el) => el.textContent),
  attrs: Array.from(doc.querySelectorAll("[data-x], [data-bshd]")).map((el) => [el.tagName, el.getAttribute("data-x") ?? el.getAttribute("data-bshd")]),
  ran: doc.documentElement.getAttribute("data-ran"),
  title: doc.title,
});

test("the same probe on the scriptless edit frame and on the bytes, parsed: the same answer; a User or a Page; async and method-shorthand probes", { timeout: 60_000 }, async () => {
  const u = await user("/");
  const live = await inFrameDoc(u, probe, { sel: "b" });
  const want = { bold: ["bold", "more"], attrs: [["P", "2"], ["DIV", "whatever"]], ran: null, title: "probe" };
  assert.deepEqual(live, want, "the live frame; its script never ran");
  assert.deepEqual(await inFrameDoc(u.page, probe, { sel: "b" }), want, "a Page works as a User does");
  assert.deepEqual(await parseAndRun(await pool.parser(), DOC, probe, { sel: "b" }), want, "the bytes, parsed: no script ran there either");
  assert.deepEqual(await parseAndRun(pool, Buffer.from(DOC), probe, { sel: "b" }), want, "a Buffer, and the pool itself as the parser");
  assert.deepEqual(await parseAndRun(pool, DOC.replace("<b>more</b>", "more"), probe, { sel: "b" }), { ...want, bold: ["bold"] }, "other bytes, another answer");

  const shorthand = { count(doc, arg) { return doc.querySelectorAll(arg).length; } };
  assert.equal(await inFrameDoc(u, shorthand.count, "p"), 2, "method shorthand");
  assert.equal(await parseAndRun(pool, DOC, shorthand.count, "p"), 2);
  const later = async (doc) => {
    await new Promise((r) => setTimeout(r, 20));
    return doc.body.children.length;
  };
  assert.equal(await inFrameDoc(u, later), 3, "an async probe is awaited");
  assert.equal(await parseAndRun(pool, DOC, later), 3);
  assert.equal(await inFrameDoc(u, (doc) => doc.defaultView === window), false, "the frame's document, not the page's");
});

test("NEGATIVE: the parent's realm — a trusted document's script replaced Array.from and map in its own realm; inside the frame a probe gets its lies, inFrameDoc does not", { timeout: 60_000 }, async () => {
  const u = await user("/trusted");
  const f = await docFrame(u.page);
  assert.equal(await f.evaluate(() => document.documentElement.getAttribute("data-ran")), "1", "the trusted document's script ran");
  const inside = await f.evaluate(() => Array.from(document.querySelectorAll("b")).map((el) => el.textContent));
  assert.deepEqual(inside, ["poisoned"], "frame.evaluate runs in the document's realm, with its replaced built-ins");
  assert.deepEqual(await inFrameDoc(u, (doc) => Array.from(doc.querySelectorAll("b")).map((el) => el.textContent)), ["bold", "more"], "inFrameDoc: the page's own built-ins");
});

test("a listener inFrameDoc adds to the scriptless frame's document is called; the same listener added inside the frame (frame.evaluate) is not", { timeout: 60_000 }, async () => {
  const u = await user("/");
  const f = await docFrame(u.page);
  await f.evaluate(() => document.addEventListener("click", () => document.body.setAttribute("data-inside", "1")));
  await inFrameDoc(u, (doc) => {
    window.__e2eParentClicks = 0;
    doc.addEventListener("click", () => {
      window.__e2eParentClicks += 1;
    });
  });
  await u.clickInFrame("#p2");
  await u.poll(() => u.page.evaluate(() => window.__e2eParentClicks === 1), { timeout: 5_000, what: "the parent-realm listener" });
  assert.equal(await inFrameDoc(u, (doc) => doc.body.getAttribute("data-inside")), null, "the listener installed inside the scriptless frame never ran");
});

test("errors: no frame, a frame out of reach, a probe that throws or returns a node, a probe or arg the page cannot take", { timeout: 60_000 }, async () => {
  const opaque = await user("/opaque", { wait: false });
  await opaque.page.locator("iframe.doc-frame").waitFor({ state: "attached" });
  await assert.rejects(inFrameDoc(opaque, probe, { sel: "b" }), /^Error: inFrameDoc: iframe\.doc-frame has no document this page can reach \(not loaded yet, or sandboxed without allow-same-origin\)$/);
  const bare = await user("/none", { wait: false });
  await assert.rejects(inFrameDoc(bare, probe, { sel: "b" }), /inFrameDoc: no iframe\.doc-frame on the page/);
  const u = await user("/");
  await assert.rejects(inFrameDoc(u, () => {
    throw new Error("boom");
  }), /inFrameDoc: the probe threw: boom/);
  await assert.rejects(inFrameDoc(u, (doc) => doc.body), /inFrameDoc: the probe returned a DOM node: return plain data/);
  await assert.rejects(parseAndRun(pool, DOC, (doc) => doc.body), /parseAndRun: the probe returned a DOM node/);
  await assert.rejects(parseAndRun(pool, DOC, (doc) => doc.defaultView.getComputedStyle(doc.body)), /parseAndRun: the probe threw: .*null/, "a parsed document has no window");
  await assert.rejects(inFrameDoc(u, "doc => 1"), /inFrameDoc: fn is a function of \(doc, arg\), got string/);
  await assert.rejects(inFrameDoc(u, probe.bind(null)), /inFrameDoc: fn is a function written in the spec/);
  await assert.rejects(inFrameDoc(u, probe, { n: 1n }), /inFrameDoc: arg must be JSON/);
  await assert.rejects(parseAndRun(pool, 42, probe), /parseAndRun: html is a string or a Buffer, got number/);
  await assert.rejects(parseAndRun({}, DOC, probe), /parseAndRun: parser is a Playwright Page/);
  assert.equal(probeSource(async function named(d) { return d; }), "(async function named(d) { return d; })");
});
