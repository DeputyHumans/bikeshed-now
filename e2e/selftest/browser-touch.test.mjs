// SPDX-License-Identifier: Apache-2.0
// Self-test: BrowserPool.user({device}) is a phone or tablet the page believes, and User.tap is a finger, refused on a mouse user (SPEC §7, §12).

/**
 * A local server stands in for the app: one page with the app's own meta
 * viewport and one without, each recording the input events it sees and
 * their pointer type. A touch device must match the media queries the app's
 * coarse-pointer styles are written against, lay out at its own width, and
 * see a tap as a finger makes it; a long press must select the word under
 * it. The negative half pins why tap() refuses a mouse user: Chrome itself
 * would synthesize the gesture on that page, which never matched
 * `(pointer: coarse)`. Needs Chrome.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";
import { BrowserPool } from "../lib/browser.mjs";
import { OUT_DIR } from "../lib/paths.mjs";

const runId = `selftest-touch-${process.pid}`;
let runDir;
let server;
let target;

const PHONE = Object.freeze({ width: 400, height: 800, touch: true });
const EVENTS = ["pointerdown", "pointerup", "touchstart", "touchend", "mousedown", "mouseup", "click", "contextmenu"];

/** The page: a button at (100, 100) 120×60, a line of words at (20, 300), and every input event in `window.ev`. */
const PAGE = (meta) => `<!doctype html><html><head>${meta ? '<meta name="viewport" content="width=device-width, initial-scale=1.0">' : ""}<title>touch</title>
<style>body{margin:0;font:20px sans-serif} #b{position:absolute;left:100px;top:100px;width:120px;height:60px} #p{position:absolute;left:20px;top:300px;margin:0}</style></head>
<body><button id="b">B</button><p id="p">alpha lanterns omega</p>
<script>
window.ev = [];
for (const t of ${JSON.stringify(EVENTS)}) document.addEventListener(t, (e) => ev.push(t + (e.pointerType ? ":" + e.pointerType : "")), true);
</script></body></html>`;

before(async () => {
  runDir = join(OUT_DIR, runId);
  mkdirSync(runDir, { recursive: true });
  server = http.createServer((req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(PAGE(!req.url.startsWith("/nometa")));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  target = Object.freeze({ kind: "local", runId, runDir, origin: `http://127.0.0.1:${port}`, projectId: "demo-bikeshed", capabilities: new Set(["local"]), stack: { ports: { hosting: port } } });
});

after(async () => {
  server?.closeAllConnections?.();
  await new Promise((r) => (server ? server.close(r) : r()));
  rmSync(runDir, { recursive: true, force: true });
});

/** What the page believes about its pointer and its viewport. */
const pointer = (page) =>
  page.evaluate(() => ({
    coarse: matchMedia("(pointer: coarse)").matches,
    fine: matchMedia("(pointer: fine)").matches,
    anyCoarse: matchMedia("(any-pointer: coarse)").matches,
    noHover: matchMedia("(hover: none)").matches,
    width: innerWidth,
    height: innerHeight,
    touchEvents: "ontouchstart" in window,
    maxTouchPoints: navigator.maxTouchPoints,
  }));
const events = (u) => u.page.evaluate(() => window.ev.splice(0));
const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));
/** The centre of "lanterns" in the page. */
const lanterns = (u) =>
  u.page.evaluate(() => {
    const r = document.createRange();
    r.setStart(document.getElementById("p").firstChild, 6);
    r.setEnd(document.getElementById("p").firstChild, 14);
    const b = r.getBoundingClientRect();
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  });

test("a malformed device, or one with a key it does not take, throws a TypeError before a browser or a context is made", async () => {
  const pool = new BrowserPool({ target });
  try {
    const bad = [
      ["phone", /^user\(\): device is \{width, height, touch\} or null \(the desktop\), got "phone"$/],
      [[400, 800], /^user\(\): device is \{width, height, touch\} or null \(the desktop\), got \[400, 800\]$/],
      [{ width: 400 }, /^user\(\): device\.height is a whole number of CSS px, 1 or more, got undefined$/],
      [{ width: 0, height: 800 }, /^user\(\): device\.width is a whole number of CSS px, 1 or more, got 0$/],
      [{ width: 400.5, height: 800 }, /^user\(\): device\.width is a whole number of CSS px, 1 or more, got 400\.5$/],
      [{ width: "400", height: 800 }, /^user\(\): device\.width is a whole number of CSS px, 1 or more, got "400"$/],
      [{ width: 400, height: 800, touch: "yes" }, /^user\(\): device\.touch is true \(a phone or tablet\) or false \(a mouse\), got "yes"$/],
      [{ width: 400, height: 800, hasTouch: true }, /^user\(\): device takes width, height and touch, not "hasTouch"$/],
      [{ width: 400, height: 800, touch: true, isMobile: true, scale: 2 }, /^user\(\): device takes width, height and touch, not "isMobile", "scale"$/],
    ];
    for (const [device, want] of bad) {
      await assert.rejects(pool.user({ name: "bad", device }), (err) => err instanceof TypeError && want.test(err.message), JSON.stringify(device));
    }
    await assert.rejects(pool.many(2, { device: { width: 400, height: 800, touches: true } }), /^TypeError: many\(\): device takes width, height and touch, not "touches"$/);
    assert.deepEqual([pool.users.length, pool.browsers.length], [0, 0], "nothing was made");
  } finally {
    await pool.close();
  }
});

test("a touch device: (pointer: coarse) and (hover: none), its own viewport, touch events, and its meta viewport honoured; touch: false is that window with a mouse; no device is the desktop it always was", async () => {
  const pool = new BrowserPool({ target });
  try {
    const phone = await pool.user({ name: "phone", device: PHONE });
    const narrow = await pool.user({ name: "narrow", device: { width: 400, height: 800 } });
    const desk = await pool.user({ name: "desk" });
    for (const u of [phone, narrow, desk]) await u.goto("/page");

    assert.deepEqual(await pointer(phone.page), { coarse: true, fine: false, anyCoarse: true, noHover: true, width: 400, height: 800, touchEvents: true, maxTouchPoints: 1 });
    assert.deepEqual(await pointer(narrow.page), { coarse: false, fine: true, anyCoarse: false, noHover: false, width: 400, height: 800, touchEvents: false, maxTouchPoints: 0 });
    assert.deepEqual(await pointer(desk.page), { coarse: false, fine: true, anyCoarse: false, noHover: false, width: 1280, height: 800, touchEvents: false, maxTouchPoints: 0 });

    assert.deepEqual([phone.device, narrow.device, desk.device], [{ width: 400, height: 800, touch: true }, { width: 400, height: 800, touch: false }, { width: 1280, height: 800, touch: false }]);
    assert.ok([phone, narrow, desk].every((u) => Object.isFrozen(u.device)), "each user's device is frozen");

    // isMobile: a page without a meta viewport lays out as a phone lays it out, 980 px wide; a mouse window does not.
    await phone.goto("/nometa");
    await narrow.goto("/nometa");
    assert.deepEqual([(await pointer(phone.page)).width, (await pointer(narrow.page)).width], [980, 400]);
    pool.assertIsolation();
  } finally {
    await pool.close();
  }
});

test("many(): each user is the device; without one, the desktop", async () => {
  const pool = new BrowserPool({ target });
  try {
    const phones = await pool.many(2, { device: PHONE, names: ["p1", "p2"] });
    const [plain] = await pool.many(1, { names: ["d1"] });
    for (const u of [...phones, plain]) await u.goto("/page");
    const seen = await Promise.all([...phones, plain].map(async (u) => [u.name, (await pointer(u.page)).coarse, (await pointer(u.page)).width, u.device.touch]));
    assert.deepEqual(seen, [["p1", true, 400, true], ["p2", true, 400, true], ["d1", false, 1280, false]]);
  } finally {
    await pool.close();
  }
});

test("tap(): a finger — touch pointer events, touchstart, touchend, then a click; held 1,200 ms a long press selects the word and raises contextmenu, and resolves once the finger lifts; locator.tap() works on a touch user", async () => {
  const pool = new BrowserPool({ target });
  try {
    const phone = await pool.user({ name: "phone", device: PHONE });
    await phone.goto("/page");
    await events(phone);

    const t0 = Date.now();
    const tapped = await phone.tap({ x: 160, y: 130 });
    await settle();
    assert.deepEqual(await events(phone), ["pointerdown:touch", "touchstart", "pointerup:touch", "touchend", "mousedown", "mouseup", "click:touch"]);
    assert.deepEqual({ ...tapped, tappedAt: typeof tapped.tappedAt }, { x: 160, y: 130, durationMs: 50, tappedAt: "number" });
    assert.ok(tapped.tappedAt >= t0 && tapped.tappedAt <= Date.now(), "tappedAt is when it was sent");

    const at = await lanterns(phone);
    const started = Date.now();
    await phone.tap(at, { durationMs: 1_200 });
    const held = Date.now() - started;
    await settle(400);
    const pressed = await events(phone);
    assert.equal(await phone.page.evaluate(() => String(getSelection())), "lanterns", "the long press selected the word under the finger");
    assert.ok(pressed.includes("contextmenu:touch"), `a long press raises contextmenu: ${pressed.join(" ")}`);
    assert.ok(!pressed.some((e) => e.startsWith("click")), `and makes no click: ${pressed.join(" ")}`);
    assert.ok(held >= 1_100, `tap() resolved once the finger lifted (${held} ms for a 1,200 ms press)`);

    await phone.page.locator("#b").tap();
    await settle();
    assert.ok((await events(phone)).includes("click:touch"), "Playwright's own locator.tap() taps on a touch user");
    pool.assertIsolation();
  } finally {
    await pool.close();
  }
});

test("NEGATIVE: tap() refuses a mouse user, where Chrome itself would have tapped; a malformed point or duration throws; nothing reaches the page; a point outside the viewport is Chrome's refusal", async () => {
  const pool = new BrowserPool({ target });
  try {
    const desk = await pool.user({ name: "desk" });
    const narrow = await pool.user({ name: "narrow", device: { width: 400, height: 800 } });
    const phone = await pool.user({ name: "phone", device: PHONE });
    for (const u of [desk, narrow, phone]) {
      await u.goto("/page");
      await events(u);
    }

    for (const u of [desk, narrow]) {
      await assert.rejects(u.tap({ x: 160, y: 130 }), (err) => !(err instanceof TypeError) && err.message.startsWith(`${u.name}: tap() is a finger on a touch screen, and this user was made with a mouse (device {"width":`) && err.message.endsWith('"touch":false}); make it with device {width, height, touch: true}'), u.name);
    }
    await settle();
    assert.deepEqual([await events(desk), await events(narrow)], [[], []], "nothing reached either mouse page");

    // Why it must refuse: the gesture itself works on a mouse page, whose (pointer: coarse) styles never applied.
    const raw = await desk.context.newCDPSession(desk.page);
    await raw.send("Input.synthesizeTapGesture", { x: 160, y: 130, duration: 50, tapCount: 1, gestureSourceType: "touch" });
    await settle();
    assert.ok((await events(desk)).includes("click:touch"), "Chrome taps a mouse page when asked directly");
    assert.equal((await pointer(desk.page)).coarse, false, "on a page that never matched (pointer: coarse)");

    for (const point of [null, undefined, {}, { x: 10 }, { x: "10", y: 10 }, { x: Number.NaN, y: 10 }, { x: 10, y: Infinity }, [10, 10]]) {
      await assert.rejects(phone.tap(point), (err) => err instanceof TypeError && /^phone: tap\(point\) takes \{x, y\}, finite CSS px in the page's viewport, got /.test(err.message), String(JSON.stringify(point)));
    }
    for (const durationMs of [50.5, -1, "50", null, Number.NaN]) {
      await assert.rejects(phone.tap({ x: 160, y: 130 }, { durationMs }), (err) => err instanceof TypeError && /^phone: tap\(\): durationMs is a whole number of ms, 0 or more, got /.test(err.message), String(durationMs));
    }
    for (const point of [{ x: 200, y: 900 }, { x: 450, y: 100 }, { x: -1, y: 100 }]) {
      await assert.rejects(phone.tap(point), /Position out of bounds/, JSON.stringify(point));
    }
    await settle();
    assert.deepEqual(await events(phone), [], "nothing reached the touch page");
  } finally {
    await pool.close();
  }
});
