// SPDX-License-Identifier: Apache-2.0
// Self-test: User.waitValue loads a page again only when that page saw the stack stall in its current load, and its failure names the last load's wait and the last value read, which pageStall then judges (SPEC §12).

/**
 * Hermetic: a local server counts the loads of each page (/p/<key>) and
 * serves one that logs the Firestore SDK's "Could not reach Cloud Firestore
 * backend" on the loads `lost` names, and whose `window.__v` (what the
 * case reads) is {state: "waiting", n} until, 150 ms in, the load `show`
 * names sets it to {state: "ready", n} (and shows #ready). pageStall is
 * asked about each failure with the user as the case's only page, as
 * inconclusiveOnPageStall asks it. Needs Chrome.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { BrowserPool } from "../lib/browser.mjs";
import { pageStall } from "../lib/test.mjs";

const LOST_LINE = "@firebase/firestore: Firestore (11.0.0): Could not reach Cloud Firestore backend. Backend didn't respond within 10 seconds.";
const LOST = 'reader: "Could not reach Cloud Firestore backend"';
const loads = new Map();
let server;
let target;

before(async () => {
  server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    const m = /^\/p\/([a-z0-9-]+)$/.exec(u.pathname);
    res.setHeader("content-type", "text/html; charset=utf-8");
    if (!m) return res.end("<!doctype html><title>app</title>");
    const n = (loads.get(m[1]) ?? 0) + 1;
    loads.set(m[1], n);
    const lost = (u.searchParams.get("lost") ?? "").split(",").filter(Boolean).map(Number);
    const show = Number(u.searchParams.get("show") ?? 0);
    res.end(`<!doctype html><title>load ${n}</title><body><main id="m"></main><script>
      window.__v = { state: "waiting", n: ${n} };
      ${lost.includes(n) ? `console.error(${JSON.stringify(LOST_LINE)});` : ""}
      ${show === n ? `setTimeout(() => { window.__v = { state: "ready", n: ${n} }; const p = document.createElement("p"); p.id = "ready"; p.textContent = "ready"; document.getElementById("m").appendChild(p); }, 150);` : ""}
    </script></body>`);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  target = { kind: "local", runId: "selftest-wait-value", origin: `http://127.0.0.1:${port}`, stack: { ports: { hosting: port } }, capabilities: new Set(["local"]) };
});
let pool = null;
after(async () => {
  await pool?.close();
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
});

/** A user on /p/<key>?<query>, and the path to load again. */
async function on(key, query) {
  pool ??= new BrowserPool({ target });
  const u = await pool.user({ name: "reader" });
  const path = `/p/${key}?${query}`;
  await u.goto(path);
  return { u, path };
}
const read = (page) => page.evaluate(() => window.__v ?? null);
const ready = (n) => ({ state: "ready", n });
const judged = (err, u) => pageStall(err, { usersSoFar: [u] });
const T = 1_500;

test("waitValue: a value the first load shows resolves {loads: 1, stall: null, value}, by value or by predicate", async () => {
  const { u } = await on("first", "show=1");
  try {
    assert.deepEqual(await u.waitValue(read, ready(1), { what: "the chip", timeout: T }), { loads: 1, stall: null, value: ready(1) });
    const r = await u.waitValue(read, function isReady(v) { return v?.state === "ready"; }, { timeout: T });
    assert.deepEqual(r, { loads: 1, stall: null, value: ready(1) });
    assert.equal(loads.get("first"), 1);
  } finally {
    await u.close();
  }
});

test("waitValue: a load that saw the Firestore client lose the emulator is loaded once more, and the value it shows then is taken", async () => {
  const { u, path } = await on("lost-once", "lost=1&show=2");
  try {
    assert.deepEqual(await u.waitValue(read, ready(2), { what: "the chip", path, timeout: T }), { loads: 2, stall: [LOST], value: ready(2) });
    assert.equal(loads.get("lost-once"), 2);
  } finally {
    await u.close();
  }
});

test("NEGATIVE: a page that saw no stall is never loaded again, though the next load would show it: E2E_NOT_SHOWN with the value it last read, which pageStall does not excuse", async () => {
  const { u, path } = await on("quiet", "show=2");
  try {
    const err = await u.waitValue(read, ready(2), { what: "the chip", path, timeout: T }).then(() => null, (e) => e);
    assert.equal(err?.code, "E2E_NOT_SHOWN");
    assert.equal(err.message, `reader: the chip not shown within ${T} ms of load 1 of ${path} (want {"state":"ready","n":2}, last read {"state":"waiting","n":1}): the page saw no stall of the stack in that load`);
    assert.deepEqual([err.loads, err.stall, err.value, err.want], [1, [], { state: "waiting", n: 1 }, ready(2)]);
    assert.equal(loads.get("quiet"), 1, "not loaded again");
    assert.equal(judged(err, u), null, "FAILS: nothing excuses it");
  } finally {
    await u.close();
  }
});

test("waitValue: stalled on both loads and never shown: E2E_NOT_SHOWN naming the last load's evidence, which pageStall judges the stack's", async () => {
  const { u, path } = await on("lost-twice", "lost=1,2");
  try {
    const err = await u.waitValue(read, ready(2), { path, timeout: T }).then(() => null, (e) => e);
    assert.equal(err?.code, "E2E_NOT_SHOWN");
    assert.equal(err.message, `reader: the value not shown within ${T} ms of load 2 of ${path} (want {"state":"ready","n":2}, last read {"state":"waiting","n":2}): the page saw the stack stall in that load (${LOST}); loaded again after the stack stalled (${LOST})`);
    assert.equal(loads.get("lost-twice"), 2);
    assert.match(judged(err, u) ?? "", /^a page's Firestore client lost the emulator \(reader: "Could not reach Cloud Firestore backend"\), in the 12 s before a wait ran out — the failure, at browser-wait-value\.test\.mjs:\d+ \(via User\.waitValue, browser\.mjs:\d+\): reader: the value not shown within 1500 ms of load 2/);
  } finally {
    await u.close();
  }
});

test("NEGATIVE: stalled on the first load only, loaded again, and still not shown on a stack that answered: the failure names the second load alone, and pageStall does NOT excuse it", async () => {
  const { u, path } = await on("lost-first-only", "lost=1");
  try {
    const err = await u.waitValue(read, ready(2), { path, timeout: T }).then(() => null, (e) => e);
    assert.equal(err?.code, "E2E_NOT_SHOWN");
    assert.match(err.message, new RegExp(`not shown within ${T} ms of load 2 of .*: the page saw no stall of the stack in that load; loaded again after the stack stalled \\(reader: "Could not reach Cloud Firestore backend"\\)$`));
    assert.equal(loads.get("lost-first-only"), 2);
    // As in browser-wait-shown: pageStall's 10 s margin would reach back into the first load of a 1.5 s wait; with none, its window is the second load's wait.
    assert.equal(pageStall(err, { usersSoFar: [u] }, { marginMs: 0 }), null, "the second load saw no stall: a FAIL");
  } finally {
    await u.close();
  }
});

test("waitValue reads the evidence of the page's CURRENT load: a stall logged once, more than 10 s before the wait, still loads it again (waitShown, reading 10 s back, does not)", async () => {
  const { u, path } = await on("old-stall", "lost=1&show=2");
  try {
    await new Promise((r) => setTimeout(r, 10_500));
    const shown = await u.waitShown("#ready", { path, timeout: T }).then(() => null, (e) => e);
    assert.match(shown?.message ?? "", /of load 1 of .*: the page saw no stall of the stack in that load$/, "the contrast: waitShown's window starts 10 s before its wait");
    assert.equal(loads.get("old-stall"), 1);
    assert.deepEqual(await u.waitValue(read, ready(2), { path, timeout: T }), { loads: 2, stall: [LOST], value: ready(2) }, "the listener this load lost delivers nothing now: loaded again");
    assert.equal(loads.get("old-stall"), 2);
  } finally {
    await u.close();
  }
});

test("waitValue: a read that throws, or never answers, or a predicate that throws, is 'not yet'; the error says nothing was read, with the read's error as its cause", { timeout: 20_000 }, async () => {
  const { u } = await on("reads", "");
  try {
    const boom = await u.waitValue(() => { throw new Error("boom"); }, 1, { timeout: 400 }).then(() => null, (e) => e);
    assert.equal(boom?.code, "E2E_NOT_SHOWN");
    assert.equal(boom.message, "reader: the value not shown within 400 ms of load 1 (want 1, nothing read (boom)): the page saw no stall of the stack in that load");
    assert.equal(boom.cause?.message, "boom");
    assert.equal(boom.value, undefined);

    const t0 = Date.now();
    const hung = await u.waitValue(() => new Promise(() => {}), 1, { timeout: 400 }).then(() => null, (e) => e);
    const took = Date.now() - t0;
    assert.equal(hung?.code, "E2E_NOT_SHOWN");
    assert.match(hung.message, /\(want 1, nothing read \(the read had not answered when the wait's time ran out\)\)/);
    assert.ok(took < 400 + 1_000 + 2_000, `a read that never answers holds the wait no longer than its time and one read's grace: ${took} ms`);

    const picky = await u.waitValue(read, () => { throw new Error("picky"); }, { timeout: 400 }).then(() => null, (e) => e);
    assert.match(picky?.message ?? "", /\(want a value the predicate passes, last read \{"state":"waiting","n":1\}\)/);
    assert.equal(picky.cause?.message, "picky");
  } finally {
    await u.close();
  }
});

test("waitValue: without a path nothing is loaded again, and the stall is named; reloads: 0 likewise; bad options throw before any wait; a closed page throws at once", async () => {
  const { u } = await on("no-path", "lost=1,2");
  try {
    const err = await u.waitValue(read, ready(1), { timeout: T }).then(() => null, (e) => e);
    assert.match(err?.message ?? "", /not shown within 1500 ms of load 1 \(want .*\): the page saw the stack stall in that load \(reader: "Could not reach Cloud Firestore backend"\)$/);
    assert.equal(loads.get("no-path"), 1);
    const e0 = await u.waitValue(read, ready(1), { path: "/p/no-path?lost=1,2", reloads: 0, timeout: T }).then(() => null, (e) => e);
    assert.equal(e0?.loads, 1);
    assert.equal(loads.get("no-path"), 1, "reloads: 0 loads nothing again");
    await assert.rejects(u.waitValue("#chip", 1), /waitValue reads the value with an async \(page\) => value/);
    await assert.rejects(u.waitValue(read, 1, { timeout: 0 }), /waitValue timeout is a number of ms above 0/);
    await assert.rejects(u.waitValue(read, 1, { interval: 0 }), /waitValue interval is a number of ms above 0/);
    await assert.rejects(u.waitValue(read, 1, { reloads: 1.5 }), /waitValue reloads is a whole number/);
    await assert.rejects(u.waitValue(read, 1, { path: "p/x" }), /waitValue path is the page to load again/);
    await assert.rejects(u.waitValue(read, 1, { what: " " }), /waitValue what names what is waited for/);
  } finally {
    await u.close();
  }
  const t0 = Date.now();
  await assert.rejects(u.waitValue(read, 1, { timeout: 30_000 }), /waitValue: the page is closed/);
  assert.ok(Date.now() - t0 < 5_000, "at once, not after its timeout");
});
