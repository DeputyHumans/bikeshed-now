// SPDX-License-Identifier: Apache-2.0
// Self-test: armingProbe and readArming time the consent page's Approve on the page's own clock, and consent() reports them (SPEC §23).

/**
 * Hermetic: a local server stands in for /connect as app/src/pages/Connect.tsx
 * arms it (useArmed). The card renders `?render=` ms after load (the describe
 * round trip) with Approve disabled; the effect attaches its listeners
 * `?effect=` ms later; Approve then enables once the page has been visible and
 * focused for ARM_DELAY_MS AND a pointermove or keydown has reached the
 * window. `?bug=nodelay` arms at the first input with no second (a planted
 * product bug the probe must expose), `?bug=noinput` after the second with no
 * input. Approve and Cancel go to `?back=`. Needs Chrome.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { BrowserPool } from "../lib/browser.mjs";
import { ARMING_KEY, ARM_DELAY_MS, armingProbe, consent, readArming } from "../lib/oauth.mjs";

const CONNECT = `<!doctype html><html><head><title>connect stand-in</title></head><body><div id="root"></div>
<script>
const q = new URLSearchParams(location.search);
const ARM = ${ARM_DELAY_MS};
const bug = q.get("bug");
const root = document.getElementById("root");
setTimeout(() => {
  root.innerHTML = '<div class="connect-card"><h1>Connect a program?</h1><div class="connect-actions"><button type="button" id="cancel">Cancel</button> <button type="button" id="approve" disabled>Approve</button></div></div>';
  const approve = document.getElementById("approve");
  approve.onclick = () => location.assign(q.get("back") || "/done");
  document.getElementById("cancel").onclick = () => location.assign(q.get("back") || "/cancelled");
  setTimeout(() => {
    let touched = bug === "noinput";
    let settled = false;
    let timer;
    const update = () => { approve.disabled = !(touched && (settled || bug === "nodelay")); };
    const restart = () => {
      clearTimeout(timer);
      settled = false;
      update();
      if (document.visibilityState === "visible" && document.hasFocus()) timer = setTimeout(() => { settled = true; update(); }, ARM);
    };
    const touch = () => { touched = true; update(); };
    restart();
    document.addEventListener("visibilitychange", restart);
    window.addEventListener("focus", restart);
    window.addEventListener("blur", restart);
    window.addEventListener("pointermove", touch);
    window.addEventListener("keydown", touch);
  }, Number(q.get("effect") || 50));
}, Number(q.get("render") || 300));
</script></body></html>`;

const OTHER = `<!doctype html><title>other</title><p id="other">another page, with /connect in a frame</p><iframe id="f" src="/connect?render=0"></iframe>`;

let server;
let target;

before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    res.setHeader("content-type", "text/html; charset=utf-8");
    if (url.pathname === "/connect") return res.end(CONNECT);
    if (url.pathname === "/other") return res.end(OTHER);
    return res.end(`<!doctype html><title>${url.pathname}</title><p id="at">${url.pathname}</p>`);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  target = { kind: "local", runId: "selftest-oauth-arming", origin: `http://127.0.0.1:${port}`, stack: { ports: { hosting: port } }, capabilities: new Set(["local"]) };
});
after(async () => {
  await new Promise((r) => server.close(r));
});

let shared = null;
const pool = () => (shared ??= new BrowserPool({ target }));
after(async () => shared?.close());

const since = (list, at) => list.filter((x) => x >= at);

/** Poll the page's record until `pred` holds. */
async function until(u, pred, { timeout = 5_000, what = "the arming record" } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const r = await readArming(u);
    if (r && pred(r)) return r;
    if (Date.now() > end) throw new Error(`${what} within ${timeout} ms: ${JSON.stringify(r)}`);
    await new Promise((s) => setTimeout(s, 25));
  }
}

async function opened(name, query = "") {
  const u = await pool().user({ name });
  await armingProbe(u);
  await u.page.bringToFront();
  await u.goto(`/connect${query}`);
  await u.page.getByRole("button", { name: "Approve", exact: true }).waitFor({ state: "visible" });
  return u;
}

test("armingProbe: Approve's appearance, its second without input, and the key that arms it, on the page's clock", async () => {
  const u = await opened("keys", "?render=300");
  const a0 = await readArming(u);
  const pageNow = await u.page.evaluate(() => Date.now());
  assert.ok(a0, "the /connect document has a record");
  assert.deepEqual([a0.path, a0.label, a0.focusAtAppear, a0.visibleAtAppear], ["/connect", "Approve", true, "visible"]);
  assert.ok(Math.abs(a0.now - pageNow) < 2_000, `the page's clock is wall time (timeOrigin + now): ${a0.now} vs Date.now() ${pageNow}`);
  assert.ok(Math.abs(a0.appeared - pageNow) < 10_000 && a0.installedAt <= a0.appeared && a0.appeared <= a0.now, `the record is on that same clock: installed ${a0.installedAt}, appeared ${a0.appeared}, now ${a0.now}`);
  assert.ok(a0.appeared - a0.installedAt >= 250, `appeared when the card rendered, ~300 ms in: ${Math.round(a0.appeared - a0.installedAt)} ms`);
  assert.deepEqual(a0.states.map(({ present, disabled }) => ({ present, disabled })), [{ present: false, disabled: null }, { present: true, disabled: true }], "first the state at install, then Approve appearing disabled");
  assert.equal(a0.states[1].t, a0.appeared);

  // Wait out more than the second with no input at all: it stays disabled.
  await new Promise((s) => setTimeout(s, Math.max(0, a0.appeared + ARM_DELAY_MS + 600 - a0.now)));
  const a1 = await readArming(u);
  assert.ok(a1.now - a1.appeared >= ARM_DELAY_MS + 500, `waited ${Math.round(a1.now - a1.appeared)} ms`);
  assert.deepEqual([a1.enabled, since(a1.moves, a1.appeared), since(a1.keys, a1.appeared)], [null, [], []], "no input, so not armed");
  assert.equal(await u.page.getByRole("button", { name: "Approve", exact: true }).isDisabled(), true, "the DOM agrees");

  await u.page.keyboard.press("Shift");
  const a2 = await until(u, (r) => r.enabled !== null, { what: "Approve enabled after the key" });
  const [keyAt] = since(a2.keys, a2.appeared);
  assert.ok(keyAt !== undefined, "the key press was recorded");
  assert.ok(a2.enabled >= keyAt && a2.enabled - keyAt < 250, `armed by the key: ${Math.round(a2.enabled - keyAt)} ms after it`);
  const last = a2.states.at(-1);
  assert.deepEqual({ present: last.present, disabled: last.disabled, t: last.t }, { present: true, disabled: false, t: a2.enabled }, "the last change is Approve enabled");
  assert.equal(await u.page.getByRole("button", { name: "Approve", exact: true }).isEnabled(), true);
});

test("armingProbe: under pointer movement from the start, enabled is a second after the listeners, never before", async () => {
  const u = await opened("moves", "?render=200&effect=80");
  const box = await u.page.locator(".connect-card").boundingBox();
  for (let i = 0; i < 400; i++) {
    await u.page.mouse.move(box.x + 5 + (i % 2) * 40, box.y + 5, { steps: 1 });
    if ((await readArming(u)).enabled !== null) break;
    await new Promise((s) => setTimeout(s, 30));
  }
  const r = await readArming(u);
  assert.ok(r.enabled !== null, "armed");
  const first = since(r.moves, r.appeared)[0];
  assert.ok(first !== undefined && first < r.enabled, "moves were recorded from before it armed");
  const lag = r.enabled - r.appeared;
  assert.ok(lag >= 80 + ARM_DELAY_MS - 15 && lag < 80 + ARM_DELAY_MS + 600, `enabled ${Math.round(lag)} ms after Approve appeared (listeners at 80 ms, then the second)`);
});

test("armingProbe exposes a page that arms without its second (bug=nodelay), and one that arms without input (bug=noinput)", async () => {
  const fast = await opened("nodelay", "?render=100&bug=nodelay");
  const box = await fast.page.locator(".connect-card").boundingBox();
  for (let i = 0; i < 40 && (await readArming(fast)).enabled === null; i++) {
    await fast.page.mouse.move(box.x + 5 + (i % 2) * 40, box.y + 5, { steps: 1 });
    await new Promise((s) => setTimeout(s, 30));
  }
  const f = await readArming(fast);
  assert.ok(f.enabled !== null && f.enabled - f.appeared < ARM_DELAY_MS / 2, `the bug shows: enabled ${f.enabled === null ? "never" : `${Math.round(f.enabled - f.appeared)} ms`} after appearing`);

  const idle = await opened("noinput", "?render=100&bug=noinput");
  const n = await until(idle, (r) => r.enabled !== null, { timeout: 5_000, what: "the noinput page arming by itself" });
  assert.deepEqual([since(n.moves, n.appeared), since(n.keys, n.appeared)], [[], []], "armed with no input recorded: the bug shows");
});

test("readArming is null on another path, before the probe, and in a frame; one probe per page", async () => {
  const u = await pool().user({ name: "elsewhere" });
  await u.goto("/connect?render=0");
  await u.page.getByRole("button", { name: "Approve", exact: true }).waitFor();
  assert.equal(await readArming(u), null, "a document loaded before armingProbe has no record");
  const opts = await armingProbe(u.page);
  assert.deepEqual(opts, { path: "/connect", label: "Approve" });
  assert.deepEqual(await armingProbe(u), opts, "again with the same options: a no-op");
  await assert.rejects(armingProbe(u, { label: "Allow" }), /already records Approve on \/connect; one probe per page/);
  assert.equal(await readArming(u), null, "still none until the next load");

  await u.goto("/other");
  const frame = u.page.frameLocator("#f");
  await frame.getByRole("button", { name: "Approve", exact: true }).waitFor();
  assert.equal(await readArming(u), null, "another path has no record");
  const inFrame = await u.page.frames().find((f) => f !== u.page.mainFrame()).evaluate((key) => Boolean(window[Symbol.for(key)]), ARMING_KEY);
  assert.equal(inFrame, false, "a /connect inside a frame is not probed");

  await u.goto("/connect?render=0");
  await u.page.getByRole("button", { name: "Approve", exact: true }).waitFor();
  const r = await readArming(u);
  assert.ok(r && r.appeared !== null, "the next /connect load has one");
  // (The pool's own `__e2eToast` binding is a window key of every page; the probe adds none.)
  const leaks = await u.page.evaluate((key) => ({
    attrs: Array.from(document.querySelectorAll("*")).flatMap((el) => Array.from(el.attributes).map((a) => a.name)).filter((n) => /e2e|bshd/i.test(n)),
    keys: Object.keys(window).filter((k) => /arm/i.test(k)),
    symbol: Object.getOwnPropertySymbols(window).includes(Symbol.for(key)),
  }), ARMING_KEY);
  assert.deepEqual(leaks, { attrs: [], keys: [], symbol: true }, "no attribute, no enumerable global: only the symbol-keyed record");

  await assert.rejects(armingProbe(u, { path: "connect" }), /path is a pathname/);
  await assert.rejects(armingProbe({}), /a Playwright Page or a User/);
});

test("consent() reports the arming record it read just before the click, when the page is probed", async () => {
  const u = await opened("driven", "?render=200&back=/approved");
  const out = await consent(u.page, { approve: true, timeoutMs: 10_000, stepMs: 60 });
  assert.equal(out.clicked, "approve");
  assert.ok(out.arming, "the record");
  assert.ok(out.arming.enabled !== null && out.arming.enabled - out.arming.appeared >= ARM_DELAY_MS, `armed ${Math.round(out.arming.enabled - out.arming.appeared)} ms after appearing`);
  assert.ok(since(out.arming.moves, out.arming.appeared).length >= 1, "consent()'s own pointer moves");
  await u.page.waitForURL((url) => url.pathname === "/approved");

  const plain = await pool().user({ name: "unprobed" });
  await plain.goto("/connect?render=0&back=/cancelled-here");
  const c = await consent(plain.page, { approve: false, timeoutMs: 10_000 });
  assert.deepEqual([c.clicked, c.arming], ["cancel", null], "no probe, no record");
});
