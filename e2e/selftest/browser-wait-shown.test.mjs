// SPDX-License-Identifier: Apache-2.0
// Self-test: User.waitShown loads a page again only when that page saw the stack stall, and its failure names the last load's wait alone, which pageStall then judges (SPEC §12).

/**
 * Hermetic: a local server counts the loads of each page (/p/<key>) and
 * serves one that logs the Firestore SDK's "Could not reach Cloud Firestore
 * backend" on the loads `lost` names, and shows #ready 150 ms in on the load
 * `show` names. pageStall is asked about each failure with the user as the
 * case's only page, as inconclusiveOnPageStall asks it. Needs Chrome.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { BrowserPool } from "../lib/browser.mjs";
import { pageStall, stallEvidence } from "../lib/test.mjs";

const LOST_LINE = "@firebase/firestore: Firestore (11.0.0): Could not reach Cloud Firestore backend. Backend didn't respond within 10 seconds.";
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
      ${lost.includes(n) ? `console.error(${JSON.stringify(LOST_LINE)});` : ""}
      ${show === n ? `setTimeout(() => { const p = document.createElement("p"); p.id = "ready"; p.textContent = "ready"; document.getElementById("m").appendChild(p); }, 150);` : ""}
    </script></body>`);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  target = { kind: "local", runId: "selftest-wait-shown", origin: `http://127.0.0.1:${port}`, stack: { ports: { hosting: port } }, capabilities: new Set(["local"]) };
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
const judged = (err, u) => pageStall(err, { usersSoFar: [u] });
const T = 1_500;

test("waitShown: what shows on the first load resolves {loads: 1, stall: null}, by locator or by selector", async () => {
  const { u } = await on("first", "show=1");
  try {
    assert.deepEqual(await u.waitShown(u.page.locator("#ready"), { what: "the ready line", timeout: T }), { loads: 1, stall: null });
    assert.deepEqual(await u.waitShown("#ready", { timeout: T }), { loads: 1, stall: null });
    assert.equal(loads.get("first"), 1);
  } finally {
    await u.close();
  }
});

test("waitShown: a load that saw the Firestore client lose the emulator is loaded once more, and what it shows then is taken", async () => {
  const { u, path } = await on("lost-once", "lost=1&show=2");
  try {
    const r = await u.waitShown("#ready", { what: "the ready line", path, timeout: T });
    assert.deepEqual(r, { loads: 2, stall: ['reader: "Could not reach Cloud Firestore backend"'] });
    assert.equal(loads.get("lost-once"), 2);
    assert.deepEqual(stallEvidence([u], 0).lost, ['reader: "Could not reach Cloud Firestore backend"'], "the evidence it read is stallEvidence's");
  } finally {
    await u.close();
  }
});

test("NEGATIVE: a page that saw no stall is never loaded again, though the next load would show it: its wait fails, and pageStall does not excuse it", async () => {
  const { u, path } = await on("quiet", "show=2");
  try {
    const err = await u.waitShown("#ready", { what: "the ready line", path, timeout: T }).then(() => null, (e) => e);
    assert.equal(err?.code, "E2E_NOT_SHOWN");
    assert.equal(err.message, `reader: the ready line not shown within ${T} ms of load 1 of ${path}: the page saw no stall of the stack in that load`);
    assert.deepEqual([err.loads, err.stall, err.cause?.name], [1, [], "TimeoutError"]);
    assert.equal(loads.get("quiet"), 1, "not loaded again");
    assert.equal(judged(err, u), null, "FAILS: nothing excuses it");
  } finally {
    await u.close();
  }
});

test("waitShown: stalled on both loads and never shown: E2E_NOT_SHOWN naming the last load's evidence, which pageStall judges the stack's", async () => {
  const { u, path } = await on("lost-twice", "lost=1,2");
  try {
    const err = await u.waitShown("#ready", { path, timeout: T }).then(() => null, (e) => e);
    assert.equal(err?.code, "E2E_NOT_SHOWN");
    assert.match(err.message, new RegExp(`^reader: #ready not shown within ${T} ms of load 2 of /p/lost-twice\\?lost=1,2: the page saw the stack stall in that load \\(reader: "Could not reach Cloud Firestore backend"\\); loaded again after the stack stalled`));
    assert.equal(loads.get("lost-twice"), 2);
    assert.match(judged(err, u) ?? "", /^a page's Firestore client lost the emulator \(reader: "Could not reach Cloud Firestore backend"\), in the 12 s before a wait ran out — the failure, at browser-wait-shown\.test\.mjs:\d+ \(via User\.waitShown, browser\.mjs:\d+\): reader: #ready not shown within 1500 ms of load 2/);
  } finally {
    await u.close();
  }
});

test("NEGATIVE: stalled on the first load only, loaded again, and still not shown on a stack that answered: the failure names the second load alone, and pageStall does NOT excuse it", async () => {
  const { u, path } = await on("lost-first-only", "lost=1");
  try {
    const err = await u.waitShown("#ready", { path, timeout: T }).then(() => null, (e) => e);
    assert.equal(err?.code, "E2E_NOT_SHOWN");
    assert.match(err.message, /not shown within \d+ ms of load 2 of .*: the page saw no stall of the stack in that load; loaded again after the stack stalled \(reader: "Could not reach Cloud Firestore backend"\)$/);
    assert.equal(loads.get("lost-first-only"), 2);
    // pageStall's window is the wait the message names plus a 10 s margin: with a 1.5 s wait that margin
    // would reach back into the first load, which a real wait (30 s and more) leaves behind. So ask it
    // with no margin: its window is then the second load's wait, as the message names it.
    assert.equal(pageStall(err, { usersSoFar: [u] }, { marginMs: 0 }), null, "the second load saw no stall: a FAIL");
  } finally {
    await u.close();
  }
});

test("waitShown: without a path nothing is loaded again, and the stall is named; reloads: 0 likewise; bad options throw before any wait", async () => {
  const { u } = await on("no-path", "lost=1,2");
  try {
    const err = await u.waitShown("#ready", { timeout: T }).then(() => null, (e) => e);
    assert.match(err?.message ?? "", /not shown within 1500 ms of load 1: the page saw the stack stall in that load \(reader: "Could not reach Cloud Firestore backend"\)$/);
    assert.equal(loads.get("no-path"), 1);
    const e0 = await u.waitShown("#ready", { path: "/p/no-path?lost=1,2", reloads: 0, timeout: T }).then(() => null, (e) => e);
    assert.equal(e0?.loads, 1);
    assert.equal(loads.get("no-path"), 1, "reloads: 0 loads nothing again");
    await assert.rejects(u.waitShown(42), /waitShown takes a Playwright locator or a selector/);
    await assert.rejects(u.waitShown("#ready", { timeout: 0 }), /timeout is a number of ms above 0/);
    await assert.rejects(u.waitShown("#ready", { reloads: -1 }), /reloads is a whole number/);
    await assert.rejects(u.waitShown("#ready", { path: "p/x" }), /path is the page to load again/);
    await assert.rejects(u.waitShown("#ready", { what: "" }), /what names what is waited for/);
  } finally {
    await u.close();
  }
});
