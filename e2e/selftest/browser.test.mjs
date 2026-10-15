// SPDX-License-Identifier: Apache-2.0
// Self-test: real input lands through a CSS-scaled frame, toasts are captured, and the isolation tripwire fires (SPEC §12).

/**
 * Hermetic: a local HTTP server stands in for the app, with an iframe scaled
 * to 0.5 by an ancestor (as the editor scales a deck), a paragraph whose id
 * starts with a digit, and a toast stack. Needs Chrome.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { BrowserPool, classifyUrl, isGoogleHost } from "../lib/browser.mjs";
import { bodyHash, elementPoint, frameGeometry, frameText, idSelector } from "../lib/frame.mjs";

const DOC = `<!doctype html><html><head><style>body{font:16px/1.5 sans-serif;margin:20px}p{margin:0 0 12px}</style></head>
<body contenteditable="true"><p id="p1">First paragraph here.</p><p id="2">Second paragraph, digit id.</p><p id="p3">Third one.</p></body></html>`;

const APP = `<!doctype html><html><body style="margin:0">
<div class="viewer"><div class="viewer-body" data-comments="closed">
<div style="position:absolute;left:100px;top:60px;transform:scale(0.5);transform-origin:0 0">
<iframe class="doc-frame" sandbox="allow-same-origin" src="/doc" style="width:900px;height:600px;border:4px solid #888;padding:6px"></iframe>
</div></div></div>
<button id="toast" style="position:absolute;left:700px;top:10px" onclick="
  const t=document.createElement('div');t.className='toast toast-error';t.setAttribute('role','alert');
  t.innerHTML='<span>Somebody published a newer version. Reload to continue.</span><button class=toast-action>Dismiss</button>';
  document.querySelector('.toast-stack').appendChild(t)">toast</button>
<div class="toast-stack"></div>
</body></html>`;

/** /signup as the app renders it: the two fields and a "Sign in" button that POSTs /session. */
const SIGNUP = `<!doctype html><body><form id="f"><input id="auth-email" type="email"><input id="auth-password" type="password">
<button type="submit">Sign in</button><button type="button">Sign in with Google</button></form>
<script>document.getElementById("f").onsubmit = async (e) => { e.preventDefault();
  const r = await fetch("/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ idToken: document.getElementById("auth-email").value + ":" + document.getElementById("auth-password").value }) });
  if ((await r.json()).status === "ok") location.replace("/"); };</script></body>`;

let server;
let other;
const sessions = [];
let origin;
let target;
before(async () => {
  server = http.createServer((req, res) => {
    const signedIn = /(^|; )__session=/.test(req.headers.cookie ?? "");
    if (req.url === "/session" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const parsed = JSON.parse(body);
        sessions.push(parsed);
        res.setHeader("content-type", "application/json");
        // The product's typed outcome for an address that is not verified yet: 200, no cookie.
        if (parsed.idToken.startsWith("unverified")) return res.end(JSON.stringify({ status: "unverified" }));
        // As the product sets it: HttpOnly, Secure, SameSite=Strict — on plain http to 127.0.0.1.
        res.setHeader("set-cookie", "__session=s3ss10n; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=600");
        res.end(JSON.stringify({ status: "ok" }));
      });
      return;
    }
    res.setHeader("content-type", "text/html");
    if (req.url === "/signup") return res.end(signedIn ? "<!doctype html><script>location.replace('/')</script>" : SIGNUP);
    res.end(req.url === "/doc" ? DOC : APP);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  other = http.createServer((req, res) => res.end("should never be reached"));
  await new Promise((r) => other.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${server.address().port}`;
  target = { kind: "local", runId: "selftest-browser", origin, stack: { ports: { hosting: server.address().port } }, capabilities: new Set(["local"]) };
});
after(async () => {
  await new Promise((r) => server.close(r));
  await new Promise((r) => other.close(r));
});

test("classifyUrl: stack ports allowed; other loopback ports and real Google hosts are breaches", () => {
  const t = { kind: "local", runId: "r", stack: { ports: { hosting: 36650, auth: 36643 } } };
  assert.equal(classifyUrl("http://127.0.0.1:36650/d/x", t).verdict, "allow");
  assert.equal(classifyUrl("http://localhost:36643/identitytoolkit.googleapis.com/v1/accounts:signUp", t).verdict, "allow", "the Auth emulator's googleapis PATH on a stack port is fine");
  assert.equal(classifyUrl("ws://127.0.0.1:36650/.ws", t).verdict, "allow");
  assert.equal(classifyUrl("data:text/plain,x", t).verdict, "allow");
  assert.equal(classifyUrl("http://127.0.0.1:9099/x", t).verdict, "breach", "NEGATIVE: the default Auth emulator port");
  assert.equal(classifyUrl("http://[::1]:5050/", t).verdict, "breach", "NEGATIVE: the default Hosting port over IPv6");
  assert.equal(classifyUrl("https://identitytoolkit.googleapis.com/v1/accounts:lookup", t).verdict, "breach", "NEGATIVE: real Identity Toolkit");
  assert.equal(classifyUrl("https://www.googletagmanager.com/gtag/js", t).verdict, "breach");
  assert.equal(classifyUrl("https://demo-bikeshed.firebaseio.com/.json", t).verdict, "breach");
  assert.equal(classifyUrl("https://example.com/", t).verdict, "external");
  assert.equal(isGoogleHost("notgoogle.com"), false, "a suffix match is on a label boundary");
});

test("typeInFrame clicks through a 0.5 CSS scale into the right paragraph (digit id), and selectText drags an exact range", async () => {
  const pool = new BrowserPool({ target });
  try {
    const u = await pool.user();
    await u.goto("/");
    await u.waitForFrame();
    const geom = await frameGeometry(u.page);
    assert.ok(Math.abs(geom.scaleX - 0.5) < 1e-6, `scale ${geom.scaleX}`);
    assert.equal(geom.transform, "none", "the scale is on an ancestor, so only the rect ratio can see it");
    const before = await bodyHash(await u.frame());
    const sel = idSelector("2");
    assert.equal(sel, '[id="2"]');
    const r = await u.typeInFrame(sel, " TOKEN-42", { delay: 5 });
    assert.equal(r.focus.hasFocus, true);
    const f = await u.frame();
    assert.equal(await f.locator(sel).textContent(), "Second paragraph, digit id. TOKEN-42");
    assert.equal(await f.locator("#p1").textContent(), "First paragraph here.", "no keystroke went elsewhere");
    assert.equal(await f.locator("#p3").textContent(), "Third one.");
    assert.notEqual((await bodyHash(f)).hash, before.hash);
    assert.match(await frameText(f), /TOKEN-42/);

    const s = await u.selectText("#p1", "paragraph here", { fab: false });
    assert.equal(s.via, "drag", "a real drag selected exactly the text, no Range fallback needed");
    assert.equal(s.text, "paragraph here");
  } finally {
    await pool.close();
  }
});

for (const at of ["start", "end"]) test(`typeInFrame reaches the ${at} of a paragraph taller than its scaled frame`, async () => {
  const pool = new BrowserPool({ target });
  try {
    const u = await pool.user();
    await u.goto("/");
    await u.waitForFrame();
    const frame = await u.frame();
    const original = "A long paragraph with many visible lines. ".repeat(400).trimEnd();
    await frame.evaluate((text) => { document.querySelector("#p1").textContent = text; }, original);
    const point = await elementPoint(frame, "#p1", at);
    const height = await frame.evaluate(() => innerHeight);
    assert.ok(point.y > 0 && point.y < height, `${at} line of an oversized paragraph must be in the frame viewport; y=${point.y}, height=${height}`);
    await u.typeInFrame("#p1", "MARKER", { at });
    assert.equal(await frame.locator("#p1").textContent(), at === "start" ? `MARKER${original}` : `${original}MARKER`, "real keystrokes reach the requested text boundary");
  } finally { await pool.close(); }
});

test("toasts are captured by the init script; NEGATIVE: waiting for one that never shows times out", async () => {
  const pool = new BrowserPool({ target });
  try {
    const u = await pool.user();
    await u.goto("/");
    const mark = u.toastMark();
    await u.page.click("#toast");
    const t = await u.waitForToast(/newer version/, { since: mark, timeout: 5000 });
    assert.equal(t.kind, "error");
    assert.equal(t.role, "alert");
    assert.equal(t.text, "Somebody published a newer version. Reload to continue.", "the Dismiss button's text is not part of it");
    await assert.rejects(u.waitForToast("Published v2.", { since: mark, timeout: 300 }), /no matching toast/);
  } finally {
    await pool.close();
  }
});

test("NEGATIVE: the tripwire aborts and records a request to a foreign loopback port and to a Google host", async () => {
  const pool = new BrowserPool({ target });
  try {
    const u = await pool.user();
    await u.goto("/");
    const otherUrl = `http://127.0.0.1:${other.address().port}/leak`;
    const out = await u.page.evaluate(async (urls) => Promise.all(urls.map((x) => fetch(x, { mode: "no-cors" }).then(() => "reached", (e) => `blocked: ${e.message}`))), [otherUrl, "https://www.googleapis.com/x", "https://example.com/", `${origin}/doc`]);
    assert.deepEqual(out.map((o) => o.startsWith("blocked")), [true, true, true, false]);
    const breaches = pool.breaches();
    assert.deepEqual(breaches.map((b) => b.url).sort(), [otherUrl, "https://www.googleapis.com/x"].sort());
    assert.deepEqual(u.log.external.map((e) => e.url), ["https://example.com/"]);
    assert.throws(() => pool.assertIsolation(), (e) => e.code === "E2E_ISOLATION_BREACH" && /isolation breach: 2 request/.test(e.message));
  } finally {
    await pool.close();
  }
});

test("signInUi fills the form, waits for POST /session ok and the redirect, and finds the Secure cookie on 127.0.0.1", async () => {
  const pool = new BrowserPool({ target });
  try {
    const u = await pool.user();
    const first = await u.signInUi("someone@example.com", "pw-1");
    assert.equal(first.status, "ok");
    assert.equal(first.already, false);
    assert.deepEqual(sessions.at(-1), { idToken: "someone@example.com:pw-1" }, "the Sign in button (not Sign in with Google) submitted the two fields");
    const c = await u.sessionCookie();
    assert.equal(c?.value, "s3ss10n");
    assert.equal(c.secure, true, "Chrome kept a Secure cookie for http://127.0.0.1");
    assert.deepEqual(await u.context.cookies(origin), [], "…which Playwright's URL-filtered cookies() hides — the reason sessionCookie() reads the whole jar");
    const again = await u.signInUi("someone@example.com", "pw-1");
    assert.deepEqual([again.status, again.already, again.gate], ["ok", true, "ready"], "a signed-in context is redirected away from /signup");
    const fresh = await pool.user();
    await assert.rejects(fresh.signInUi("unverified@example.com", "pw-2", { timeout: 5000 }), /POST \/session answered 200 \{"status":"unverified"\}/, "NEGATIVE: a 200 that is not {status: ok} is a failed sign-in");
  } finally {
    await pool.close();
  }
});

test("the pool puts at most usersPerBrowser contexts in one Chrome: 3 users at 2 per browser is 2 processes", async () => {
  const pool = new BrowserPool({ target, usersPerBrowser: 2 });
  try {
    const users = await pool.many(3);
    assert.deepEqual(users.map((u) => u.name), ["u1", "u2", "u3"]);
    assert.equal(pool.stats().browsers, 2);
    assert.match(pool.stats().via, /^(channel:chrome|E2E_CHROME|ms-playwright-cache)$/);
    const c1 = await users[0].context.cookies();
    assert.deepEqual(c1, [], "every user starts from an empty temp profile");
    pool.assertIsolation();
  } finally {
    await pool.close();
  }
});
