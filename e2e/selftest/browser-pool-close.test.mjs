// SPDX-License-Identifier: Apache-2.0
// Pool shutdown must finish before any caller can admit diagnostic maintenance (SPEC §12).
import { test } from "node:test";
import assert from "node:assert/strict";
import { BrowserPool } from "../lib/browser.mjs";

const deferred = () => Promise.withResolvers();
const tick = () => new Promise(resolve => setImmediate(resolve));
const poolFor = () => new BrowserPool({ target: { kind: "local" } });

test("concurrent close callers wait for users and browsers; admission closes immediately", async () => {
  const pool = poolFor(), user = deferred(), browser = deferred();
  let closes = 0, finished = 0;
  pool.users.push({ close: () => user.promise });
  pool.browsers.push({ promise: Promise.resolve({ close: () => { closes++; return browser.promise; } }) });
  const first = pool.close().then(() => finished++);
  const second = pool.close().then(() => finished++);
  try {
    await tick();
    assert.equal(finished, 0, "neither caller may return while a user remains open");
    assert.equal(pool.closed, false, "closed means completed, not requested");
    await assert.rejects(pool.user(), /pool is closed/);
    user.resolve();
    await tick();
    assert.equal(closes, 1, "the browser is closed once");
    assert.equal(finished, 0, "both callers must await the browser too");
    browser.resolve();
    await Promise.all([first, second]);
    assert.equal(pool.closed, true);
    await pool.close();
    assert.equal(closes, 1);
  } finally {
    user.resolve(); browser.resolve();
    await Promise.allSettled([first, second]);
  }
});

test("a rejected user close does not prevent any browser from closing", async () => {
  const pool = poolFor();
  let closed = 0;
  pool.users.push({ close: async () => { throw new Error("context failure"); } });
  for (let i = 0; i < 2; i++) pool.browsers.push({ promise: Promise.resolve({ close: async () => { closed++; } }) });
  await pool.close();
  assert.equal(closed, 2);
  assert.equal(pool.closed, true);
});

test("a failed browser close stays unclosed and rejects every caller", async () => {
  const pool = poolFor();
  pool.browsers.push({ promise: Promise.resolve({ close: async () => { throw new Error("browser remains alive"); } }) });
  const results = await Promise.allSettled([pool.close(), pool.close()]);
  assert.deepEqual(results.map(r => r.status), ["rejected", "rejected"]);
  assert.equal(pool.closed, false);
  await assert.rejects(pool.close(), /browser shutdown failed/);
});


test("a renderer waiting for memory cannot launch after pool shutdown", async () => {
  const pool = poolFor(), gate = deferred();
  let slots = 0;
  pool.admitContexts = () => gate.promise;
  pool.slot = () => { slots++; throw new Error("renderer launched after shutdown"); };
  const rendering = pool.printRenderer();
  const refused = assert.rejects(rendering, /pool is closed/);
  await pool.close();
  gate.resolve();
  await refused;
  assert.equal(slots, 0);
});
