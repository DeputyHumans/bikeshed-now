// SPDX-License-Identifier: Apache-2.0
// Self-test: inputClocks times every peer's own input on its document frame, on the page's clock, and inputSpan says when the records cannot prove a race (SPEC §6b, §12).

/**
 * Hermetic: a local server stands in for the viewer in edit mode, as in
 * frame-arrival.test.mjs: `iframe.doc-frame` with sandbox="allow-same-origin"
 * and a contenteditable body, so real keystrokes fire `input` in the frame's
 * document. The top page has `put(id, text)`, which appends text to the
 * frame's `#id` from script (what a remote merge does: no input event), and
 * `remount()`, which replaces the iframe element. Needs Chrome.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { BrowserPool } from "../lib/browser.mjs";
import { inputClocks, inputSpan } from "../lib/live.mjs";

const DOC = `<!doctype html><html><head><style>body{font:16px/1.5 sans-serif;margin:20px}</style></head>
<body contenteditable="true"><p id="p1">First paragraph.</p><p id="p2">Second paragraph.</p></body></html>`;

const APP = `<!doctype html><html><body style="margin:0">
<div class="viewer-body"><iframe class="doc-frame" sandbox="allow-same-origin" src="/doc" style="width:700px;height:300px"></iframe></div>
<script>
  const doc = () => document.querySelector("iframe.doc-frame").contentDocument;
  window.put = (id, text) => { doc().getElementById(id).append(text); return Date.now(); };
  window.remount = () => new Promise((resolve) => {
    const old = document.querySelector("iframe.doc-frame");
    const fresh = old.cloneNode(false);
    fresh.onload = () => resolve(true);
    old.replaceWith(fresh);
  });
</script></body></html>`;

let server;
let target;
let pool = null;

before(async () => {
  server = http.createServer((req, res) => {
    const path = new URL(req.url, "http://x").pathname;
    res.setHeader("content-type", "text/html; charset=utf-8");
    if (path === "/doc") return res.end(DOC);
    if (path === "/none") return res.end("<!doctype html><body><div class=viewer-body>no frame</div></body>");
    res.end(APP);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  target = { kind: "local", runId: "selftest-input-clocks", origin: `http://127.0.0.1:${port}`, stack: { ports: { hosting: port } }, capabilities: new Set(["local"]) };
});

after(async () => {
  await pool?.close();
  await new Promise((r) => server.close(r));
});

async function user(name) {
  pool ??= new BrowserPool({ target });
  const u = await pool.user({ name });
  await u.goto("/");
  await u.waitForFrame();
  return u;
}

/** The recorder keys this harness left on a page (none once read). */
const leftovers = (u) => u.page.evaluate(() => Object.keys(window).filter((k) => k.startsWith("__e2eInputs")));
const text = (u, id) => u.page.evaluate((id) => document.querySelector("iframe.doc-frame").contentDocument.getElementById(id).textContent, id);

// --- inputSpan (pure) ---------------------------------------------------------------------

test("inputSpan: the span runs from the earliest input of ANY peer to the latest of any, not the widest single peer", () => {
  const r = inputSpan([
    { name: "p1", n: 2, first: 1_000, last: 1_100 },
    { name: "p2", n: 3, first: 1_500, last: 1_700 },
  ]);
  assert.deepEqual(r, { first: 1_000, last: 1_700, spanMs: 700, silent: [], problems: [] }, "NEGATIVE CONTROL: per-peer spans (100, 200) would say 200");
});

test("inputSpan: a silent peer, a replaced frame, a lost page and a broken record each say why the race is unproven", () => {
  const r = inputSpan([
    { name: "p1", n: 1, first: 10, last: 10 },
    { name: "p2", n: 0, first: null, last: null },
    { name: "p3", n: 2, first: 20, last: 40, replaced: true },
    { name: "p4", n: null, first: null, last: null, lost: true, error: "Target page, context or browser has been closed" },
    { name: "p5", n: 1, first: 50, last: 30 },
  ]);
  assert.deepEqual([r.first, r.last, r.spanMs], [10, 40, 30], "only whole records count toward the span; p3's recorded input still does");
  assert.deepEqual(r.silent, ["p2"]);
  assert.equal(r.problems.length, 4, r.problems.join("\n"));
  assert.match(r.problems.join("\n"), /p2 fired no input event/);
  assert.match(r.problems.join("\n"), /p3's document frame was replaced after arming/);
  assert.match(r.problems.join("\n"), /p4's page lost its input recorder \(it navigated or closed: Target page/);
  assert.match(r.problems.join("\n"), /p5's record is not a time range/);
  assert.deepEqual(inputSpan([{ name: "p1", n: 0, first: null, last: null }]), { first: null, last: null, spanMs: null, silent: ["p1"], problems: ["p1 fired no input event"] }, "nobody typed: no span");
  assert.throws(() => inputSpan(null), TypeError);
});

// --- inputClocks (Chrome) -----------------------------------------------------------------

test("inputClocks: each peer's own keystrokes, timed on the page clock; a remote change, input before arming and input after read() are not counted", async () => {
  const [a, b] = [await user("p1"), await user("p2")];
  await a.typeInFrame("#p1", "z"); // before arming: not counted
  const t0 = Date.now();
  const clocks = await inputClocks([a, b]);
  assert.deepEqual(clocks.names, ["p1", "p2"]);
  assert.equal((await leftovers(a)).length, 1, "armed: one recorder on the page");
  await a.typeInFrame("#p1", "abc");
  await b.page.evaluate(() => put("p2", " REMOTE")); // what a merge does: the DOM changes, no input event
  await b.typeInFrame("#p2", "de");
  const t1 = Date.now();
  const r = await clocks.read();
  assert.equal(await text(b, "p2"), "Second paragraph. REMOTEde", "the remote text and the typing both landed");
  assert.deepEqual(r.inputs.map((x) => [x.name, x.n, x.replaced, x.lost]), [["p1", 3, false, false], ["p2", 2, false, false]], "NEGATIVE CONTROL: a recorder on the top document counts 0; p2's REMOTE text is not its input");
  for (const x of r.inputs) assert.ok(x.first >= t0 - 50 && x.last <= t1 + 50 && x.first <= x.last, `${x.name}'s times are within the typing (${x.first}–${x.last}, typed ${t0}–${t1})`);
  assert.ok(r.inputs[0].last <= r.inputs[1].first, "p1 typed before p2 did");
  assert.deepEqual([r.first, r.last, r.spanMs, r.silent, r.problems], [r.inputs[0].first, r.inputs[1].last, r.inputs[1].last - r.inputs[0].first, [], []]);
  assert.equal(await clocks.read(), r, "read() again resolves the same record");
  await a.typeInFrame("#p1", "q");
  assert.deepEqual([await leftovers(a), await leftovers(b)], [[], []], "read() took every recorder off: no listener, no global left");
  assert.equal((await clocks.read()).inputs[0].n, 3, "input after read() is not counted");
});

test("inputClocks: a frame replaced after arming and a page that navigated are named, and their peers' records still stand", async () => {
  const [a, b, c] = [await user("p1"), await user("p2"), await user("p3")];
  const clocks = await inputClocks([a, b, c]);
  await a.typeInFrame("#p1", "x");
  await a.page.evaluate(() => remount());
  await a.waitForFrame();
  await a.typeInFrame("#p1", "y"); // in the new frame: unrecorded
  await b.typeInFrame("#p2", "w");
  await b.goto("/");
  await b.waitForFrame();
  await c.typeInFrame("#p2", "v");
  const r = await clocks.read();
  const by = Object.fromEntries(r.inputs.map((x) => [x.name, x]));
  assert.deepEqual([by.p1.n, by.p1.replaced, by.p1.lost], [1, true, false], "NEGATIVE CONTROL: without the document check p1 looks whole with 1 input");
  assert.deepEqual([by.p2.n, by.p2.lost], [null, true], "the navigation took p2's recorder with it");
  assert.deepEqual([by.p3.n, by.p3.replaced, by.p3.lost], [1, false, false]);
  assert.deepEqual([r.first, r.last], [by.p1.first, by.p3.last]);
  assert.equal(r.problems.length, 2, r.problems.join("\n"));
  assert.match(r.problems[0], /p1's document frame was replaced after arming/);
  assert.match(r.problems[1], /p2's page lost its input recorder/);
});

test("inputClocks: a user with no document frame is refused, and the recorders already armed are taken off", async () => {
  const [a, b] = [await user("p1"), await user("p2")];
  await b.goto("/none");
  await assert.rejects(inputClocks([a, b]), /inputClocks: cannot record input on p2 \(no same-origin iframe\.doc-frame\)/);
  assert.deepEqual(await leftovers(a), [], "NEGATIVE CONTROL: p1's recorder, armed beside the failure, is not left behind");
  await assert.rejects(inputClocks([]), TypeError);
  await assert.rejects(inputClocks([a, a]), /a user is given twice/);
});
