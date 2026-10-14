// SPDX-License-Identifier: Apache-2.0
// Self-test: User.throttleCpu slows the user's own page as DevTools does, calls stack, and each restore takes only its own throttle away (SPEC §12).

/**
 * Hermetic: a local server answers a page with three child frames (one
 * same-origin with the sandbox the reading frame has, `allow-same-origin`;
 * one sandboxed without it, an opaque origin; one cross-site, the same port
 * under the other loopback name) and a second page. How slow a page is: a
 * busy loop timed in it, each time next to the same loop timed in a
 * reference page in a Chrome of its own that nothing throttles, so machine
 * load slows both alike. The median ratio is about 1 at full speed and about
 * the rate when throttled; every threshold sits a factor of about two from
 * what is expected on either side. Every restore is checked by speed before
 * its answer, so a restore that answers right and leaves the rate wrong is
 * caught by the speed. Two Chromes for the whole file (each case its own
 * users in them), so it adds little to a loaded self-test run. Needs Chrome.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { BrowserPool } from "../lib/browser.mjs";

let server;
let port;
let target;
let pool;
let refPool;
let ref;
before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://self.test");
    res.writeHead(200, { "content-type": "text/html" });
    if (url.pathname === "/") {
      res.end(`<!doctype html><title>top</title><p>top</p>
<iframe id="same" sandbox="allow-same-origin" src="/inner?w=same"></iframe>
<iframe id="opaque" sandbox="allow-scripts" src="/inner?w=opaque"></iframe>
<iframe id="cross" src="http://localhost:${port}/inner?w=cross"></iframe>`);
      return;
    }
    if (url.pathname === "/inner") return void res.end(`<!doctype html><title>inner</title><p id="w">${url.searchParams.get("w")}</p>`);
    res.end("<!doctype html><title>other</title><p>other</p>");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  port = server.address().port;
  target = { kind: "local", runId: "selftest-cpu", origin: `http://127.0.0.1:${port}`, stack: { ports: { hosting: port } }, capabilities: new Set(["local"]) };
  pool = new BrowserPool({ target, usersPerBrowser: 20 });
  refPool = new BrowserPool({ target });
  const r = await refPool.user({ name: "ref" });
  await r.goto("/");
  for (let i = 0; i < 2; i += 1) await r.page.evaluate(busy, LOOP);
  ref = r.page;
});
after(async () => {
  await Promise.all([pool?.close(), refPool?.close()]);
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
});

const LOOP = 10_000_000;
/** In a page or a frame: milliseconds a fixed busy loop takes. */
function busy(n) {
  const t = performance.now();
  let x = 0;
  for (let i = 0; i < n; i += 1) x += Math.sqrt(i);
  return performance.now() - t + (x < 0 ? 1 : 0);
}
const median = (a) => [...a].sort((p, q) => p - q)[Math.floor(a.length / 2)];

/** Median of `where`'s loop time over the reference's, measured in turn. */
async function slowness(where, ref, samples = 5) {
  const out = [];
  for (let i = 0; i < samples; i += 1) {
    const a = await where.evaluate(busy, LOOP);
    const b = await ref.evaluate(busy, LOOP);
    out.push(a / Math.max(b, 0.1));
  }
  return Math.round(median(out) * 100) / 100;
}

const FULL = 1.75; // between 1 (full speed) and 3
const fast = (r, what) => assert.ok(r < FULL, `${what} runs at full speed: ${r}x the reference (wanted < ${FULL})`);
const slowed = (r, at, what) => assert.ok(r >= at, `${what} is slowed: ${r}x the reference (wanted >= ${at})`);
const third = (r, what) => assert.ok(r >= FULL && r < 6, `${what} runs at about 3x: ${r}x the reference (wanted >= ${FULL} and < 6)`);

/**
 * A fresh user under test and another user, in one Chrome; the reference is
 * the file's, in a Chrome of its own. Every page loaded and warmed up.
 */
async function setup() {
  const [a, b] = [await pool.user({ name: "a" }), await pool.user({ name: "b" })];
  for (const u of [a, b]) await u.goto("/");
  const frame = async (w) => {
    let f = null;
    await a.poll(async () => {
      f = a.page.frames().find((x) => new URL(x.url()).searchParams.get("w") === w) ?? null;
      return f !== null && (await f.evaluate(() => document.getElementById("w")?.textContent).catch(() => null)) === w;
    }, { timeout: 15_000, what: `frame ${w} loaded` });
    return f;
  };
  const frames = { same: await frame("same"), opaque: await frame("opaque"), cross: await frame("cross") };
  for (const p of [a.page, b.page, ...Object.values(frames)]) for (let i = 0; i < 2; i += 1) await p.evaluate(busy, LOOP);
  const close = () => Promise.all([a.close(), b.close()]);
  return { close, a, b, ref, frames };
}

test("throttleCpu(6) slows the page and the frames in its process about six times, through a reload and a cross-site navigation, and its restore brings it back to full speed", async () => {
  const { close, a, b, ref, frames } = await setup();
  try {
    fast(await slowness(a.page, ref), "before any throttle, the page");
    const restore = await a.throttleCpu(6);
    assert.equal(typeof restore, "function");
    slowed(await slowness(a.page, ref), 3, "at 6x, the page");
    slowed(await slowness(frames.same, ref), 3, "at 6x, a same-origin frame sandboxed as the reading frame is (allow-same-origin)");
    fast(await slowness(frames.opaque, ref), "at 6x, a frame sandboxed without allow-same-origin (another process)");
    fast(await slowness(frames.cross, ref), "at 6x, a cross-site frame (another process)");
    fast(await slowness(b.page, ref), "at 6x, another user's page in the same Chrome");
    await a.page.reload();
    slowed(await slowness(a.page, ref), 3, "after a reload, the page");
    await a.page.goto(`http://localhost:${port}/other`);
    assert.equal(new URL(a.page.url()).hostname, "localhost", "the page went to another site");
    slowed(await slowness(a.page, ref), 3, "after a cross-site navigation, the page");
    await a.goto("/");
    const r = await restore();
    fast(await slowness(a.page, ref), "after the restore, the page");
    assert.equal(r, 1, "the restore resolves to the rate now in force");
    assert.equal(await restore(), 1, "a second restore is the first");
    fast(await slowness(a.page, ref), "after a second restore, the page");
  } finally {
    await close();
  }
});

test("throttles stack: the latest still in force sets the rate, each restore takes only its own away, in either order, twice is once, and one made together with another is not lost", async () => {
  const { close, a, ref } = await setup();
  try {
    const [p, q] = await Promise.all([a.throttleCpu(3), a.throttleCpu(12)]);
    slowed(await slowness(a.page, ref), 6, "two throttles made together: the later, 12x");
    let r = await q();
    third(await slowness(a.page, ref), "with the 12x taken away, the 3x made with it");
    assert.equal(r, 3);
    r = await p();
    fast(await slowness(a.page, ref), "with both taken away, the page");
    assert.equal(r, 1);

    const outer = await a.throttleCpu(3);
    third(await slowness(a.page, ref), "outer 3x");
    const inner = await a.throttleCpu(12);
    slowed(await slowness(a.page, ref), 6, "inner 12x over outer 3x");
    r = await inner();
    third(await slowness(a.page, ref), "after the inner restore, the outer 3x");
    assert.equal(r, 3, "the inner restore leaves the outer in force");
    r = await inner();
    third(await slowness(a.page, ref), "after a second inner restore, still the outer 3x");
    assert.equal(r, 3, "a second inner restore is the first");
    r = await outer();
    fast(await slowness(a.page, ref), "after the outer restore, the page");
    assert.equal(r, 1);

    const first = await a.throttleCpu(3);
    const second = await a.throttleCpu(12);
    r = await first();
    slowed(await slowness(a.page, ref), 6, "with the earlier 3x taken away first, the later 12x");
    assert.equal(r, 12, "restoring the EARLIER throttle first leaves the later in force");
    r = await second();
    fast(await slowness(a.page, ref), "with both taken away, the page");
    assert.equal(r, 1);

    const again = await a.throttleCpu(6);
    slowed(await slowness(a.page, ref), 3, "a throttle after every other was restored");
    await again();
    const full = await a.throttleCpu(1);
    fast(await slowness(a.page, ref), "throttleCpu(1)");
    assert.equal(await full(), 1);
  } finally {
    await close();
  }
});

test("a rate that is not a finite number of at least 1 throws a TypeError before anything is sent", async () => {
  const { close, a, ref } = await setup();
  const refused = async (bad) =>
    assert.rejects(a.throttleCpu(bad), (err) => err instanceof TypeError && /^a: throttleCpu rate is a finite number of at least 1 \(1 is full speed\), got /.test(err.message), `rate ${String(bad)} is refused`);
  try {
    const restore = await a.throttleCpu(6);
    // Chrome takes these three as full speed: had one been sent, or kept as the throttle in force, the page would be fast now.
    for (const bad of [0, 0.5, -1]) await refused(bad);
    slowed(await slowness(a.page, ref), 3, "after refusing 0, 0.5 and -1, the 6x");
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, "6", null, undefined, { rate: 6 }]) await refused(bad);
    slowed(await slowness(a.page, ref), 3, "after refusing the rest, the 6x");
    const r = await restore();
    fast(await slowness(a.page, ref), "after the restore, the page");
    assert.equal(r, 1, "a refused call left nothing in force");
  } finally {
    await close();
  }
});

test("a restore after the page has closed resolves 1 and throws nothing", async () => {
  const { close, a, b } = await setup();
  try {
    const restore = await a.throttleCpu(4);
    const other = await b.throttleCpu(4);
    await a.close();
    assert.equal(await restore(), 1, "after the user closed");
    await b.page.close();
    assert.equal(await other(), 1, "after the page alone closed");
  } finally {
    await close();
  }
});

test("Chrome: a page has one rate, the last any CDP session set, and detaching a session that set one ends every throttle on the page (why throttleCpu keeps one session and never detaches it)", async () => {
  const { close, a, ref } = await setup();
  try {
    const s1 = await a.context.newCDPSession(a.page);
    await s1.send("Emulation.setCPUThrottlingRate", { rate: 6 });
    slowed(await slowness(a.page, ref), 3, "one session's 6x");
    const s2 = await a.context.newCDPSession(a.page);
    await s2.send("Emulation.setCPUThrottlingRate", { rate: 3 });
    third(await slowness(a.page, ref), "a second session's 3x over the first's 6x (the last set wins, not the larger)");
    await s2.detach();
    fast(await slowness(a.page, ref), "with the second session detached, although the first is attached and set 6x, the page");
    await s1.detach();
    const restore = await a.throttleCpu(6);
    const s3 = await a.context.newCDPSession(a.page);
    await s3.send("Runtime.evaluate", { expression: "1" });
    await s3.detach();
    slowed(await slowness(a.page, ref), 3, "a session that never set a rate, detached: throttleCpu's 6x stays");
    await restore();
  } finally {
    await close();
  }
});
