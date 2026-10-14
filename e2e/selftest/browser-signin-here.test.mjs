// SPDX-License-Identifier: Apache-2.0
// Self-test: signInUi({here: true}) signs in on the sign-in page the app navigated to, without reloading it, so a Fork intent in ?next= survives (SPEC §3, §12, §21).

/**
 * Hermetic: a local server stands in for the app as app/src/viewer/useFork.ts
 * and app/src/pages/SignUp.tsx behave. A signed-out reader on /d/<id>?k=<key>
 * presses Fork; after `?navlag=<ms>` (default 400) the app pushes
 * /signup?next=<encoded /d/<id>?k=<key>&fork=1> with history.pushState (no
 * load) and renders the password form. "ok" replaces the URL with next; a
 * document page that carries fork=1 and a signed-in user drops the intent and
 * POSTs /fork {op: "create", docId, k} once. Every document load is counted
 * by the server and every page load mints `window.__load`, so a reload, which
 * a person never sees here, shows. The server answers /session by the
 * address's first word, as browser-signin's stand-in does. Needs Chrome.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { BrowserPool } from "../lib/browser.mjs";

const APP = `<!doctype html><html><head><title>fork stand-in</title></head><body><div id="root"></div>
<script>
window.__load = Math.random().toString(36).slice(2);
const root = document.getElementById("root");
const q = () => new URLSearchParams(location.search);
const NAVLAG = Number(new URLSearchParams(location.search).get("navlag") || 400);
function safeNext(raw) {
  if (typeof raw !== "string" || !raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\\\")) return "/";
  try { const u = new URL(raw, "https://origin.invalid"); return u.origin === "https://origin.invalid" ? u.pathname + u.search + u.hash : "/"; } catch { return "/"; }
}
function card(step, inner) {
  const steps = [1, 2, 3].map((n) => '<span class="auth-step"' + (n === step ? ' aria-current="step"' : "") + ">" + n + "</span>").join("");
  return '<div class="auth-card"><div class="auth-steps">' + steps + "</div>" + inner + "</div>";
}
function signInPage(error) {
  if (localStorage.getItem("user") && localStorage.getItem("gate") === "needs_verification") { root.innerHTML = card(3, "<p>Confirm your address.</p>"); return; }
  const banner = error ? '<div role="alert">' + error + "</div>" : "";
  root.innerHTML = card(1, banner + '<form id="f"><input id="auth-email" type="email"><input id="auth-password" type="password"><button type="submit">Sign in</button></form>');
  document.getElementById("f").onsubmit = async (e) => {
    e.preventDefault();
    const email = document.getElementById("auth-email").value;
    root.innerHTML = '<span role="status">Signing in</span>';
    const r = await fetch("/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, from: location.pathname + location.search, load: window.__load }) });
    const out = await r.json().catch(() => ({ status: "session_failed" }));
    if (out.status === "ok") { localStorage.setItem("user", email); history.replaceState(null, "", safeNext(q().get("next"))); return route(); }
    if (out.status === "unverified") { localStorage.setItem("user", email); localStorage.setItem("gate", "needs_verification"); return signInPage(); }
    signInPage("Could not establish a secure session.");
  };
}
function docPage(docId) {
  const signedIn = Boolean(localStorage.getItem("user")) && !localStorage.getItem("gate");
  const params = q();
  if (signedIn && params.get("fork") === "1") {
    params.delete("fork");
    history.replaceState(null, "", location.pathname + (params.toString() ? "?" + params.toString() : ""));
    fetch("/fork", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "create", docId, k: params.get("k"), load: window.__load }) })
      .then((r) => r.json())
      .then((made) => { history.pushState(null, "", "/d/" + made.docId); route(); });
  }
  root.innerHTML = '<p id="doc">' + docId + '</p><button type="button" id="fork">Fork</button>';
  document.getElementById("fork").onclick = () => {
    if (signedIn) return;
    const back = new URLSearchParams();
    if (params.get("k")) back.set("k", params.get("k"));
    back.set("fork", "1");
    const path = "/d/" + docId + "?" + back.toString();
    setTimeout(() => { history.pushState(null, "", "/signup?next=" + encodeURIComponent(path)); route(); }, NAVLAG);
  };
}
function route() {
  const p = location.pathname.toLowerCase();
  if (p === "/signup") return signInPage();
  const m = /^\\/d\\/([^/]+)$/.exec(location.pathname);
  if (m) return docPage(decodeURIComponent(m[1]));
  root.innerHTML = '<p id="landed">' + location.pathname + "</p>";
}
window.addEventListener("popstate", route);
route();
</script></body></html>`;

let server;
let origin;
let target;
const loads = []; // every document GET: {path}
const sessions = []; // every POST /session body
const forks = []; // every POST /fork body

before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (req.method === "POST" && (url.pathname === "/session" || url.pathname === "/fork")) {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const p = JSON.parse(body);
        res.setHeader("content-type", "application/json");
        if (url.pathname === "/fork") {
          forks.push(p);
          return res.end(JSON.stringify({ docId: `${p.docId}-copy`, versionId: "v1" }));
        }
        sessions.push(p);
        const kind = p.email.split("-")[0];
        if (kind === "unverified") return res.end(JSON.stringify({ status: "unverified" }));
        if (kind === "fail") return res.writeHead(401).end(JSON.stringify({ status: "session_failed" }));
        res.setHeader("set-cookie", "__session=s3ss10n; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=600");
        return res.end(JSON.stringify({ status: "ok" }));
      });
      return;
    }
    loads.push({ path: url.pathname + url.search });
    res.setHeader("content-type", "text/html");
    res.end(APP);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${server.address().port}`;
  target = { kind: "local", runId: "selftest-signin-here", origin, stack: { ports: { hosting: server.address().port } }, capabilities: new Set(["local"]) };
});
after(async () => {
  await new Promise((r) => server.close(r));
});

let shared = null;
const pool = () => (shared ??= new BrowserPool({ target }));
after(async () => shared?.close());

const KEY = "linkKey0123456789abcdefXY";

/** A signed-out reader on /d/<docId>?k=…, Fork pressed; returns the user and the page's load id. */
async function pressFork(name, docId, { navlag = 400 } = {}) {
  const u = await pool().user({ name });
  await u.goto(`/d/${docId}?k=${KEY}&navlag=${navlag}`);
  await u.page.locator("#fork").waitFor({ state: "visible" });
  const load = await u.page.evaluate(() => window.__load);
  await u.page.locator("#fork").click();
  return { u, load };
}

test("here: called straight after Fork, it waits for the app's /signup?next=…, signs in there with no reload, and the intent forks once", async () => {
  const docId = "src-here";
  const { u, load } = await pressFork("here", docId);
  const loadsBefore = loads.length;
  const r = await u.signInUi("ok-h@example.com", "pw-h", { here: true });
  const next = `/d/${docId}?k=${KEY}&fork=1`;

  assert.deepEqual([r.status, r.already, r.httpStatus, r.body, r.gate], ["ok", false, 200, { status: "ok" }, "ready"]);
  assert.equal(loads.length, loadsBefore, "no document was loaded: the app's own page was signed in on");
  assert.deepEqual(sessions.at(-1), { email: "ok-h@example.com", from: `/signup?next=${encodeURIComponent(next)}`, load }, "the form signed in was the one the app opened, in the same page load");
  assert.equal((await u.sessionCookie())?.value, "s3ss10n");
  assert.equal(u.email, "ok-h@example.com");

  await u.poll(() => forks.some((f) => f.docId === docId), { timeout: 10_000, what: "the intent's POST /fork" });
  assert.deepEqual(forks.filter((f) => f.docId === docId), [{ op: "create", docId, k: KEY, load }], "the intent survived, with its key, and forked once from that page");
  await u.poll(async () => new URL(u.page.url()).pathname === `/d/${docId}-copy`, { timeout: 10_000, what: "the fork opened" });
});

test("here on a page already at /signup with the form: no wait, no reload; an outcome other than ok is reported as usual", async () => {
  const { u, load } = await pressFork("here-unverified", "src-unv", { navlag: 0 });
  await u.poll(async () => new URL(u.page.url()).pathname === "/signup", { timeout: 10_000, what: "/signup" });
  const loadsBefore = loads.length;
  const r = await u.signInUi("unverified-x@example.com", "pw-x", { here: true, expectStatus: "unverified" });
  assert.deepEqual([r.status, r.already, r.gate], ["unverified", false, "needs_verification"]);
  assert.equal(loads.length, loadsBefore);
  assert.equal(await u.page.evaluate(() => window.__load), load, "the same page load throughout");
  assert.equal(await u.sessionCookie(), null);

  // A page already at a gate: `already`, answered by the last POST /session this user saw.
  const again = await u.signInUi("unverified-x@example.com", "pw-x", { here: true, expectStatus: "unverified", timeout: 10_000 });
  assert.deepEqual([again.status, again.already, again.httpStatus, again.body, again.gate], ["unverified", true, 200, { status: "unverified" }, "needs_verification"]);
  await assert.rejects(u.signInUi("unverified-x@example.com", "pw-x", { here: true, timeout: 10_000 }), /already signed in at the sign-in page the app opened: the page shows "unverified", POST \/session answered 200 \{"status":"unverified"\} \(wanted ok\)/);
});

test("NEGATIVE: without here, signInUi opens a bare /signup: a reload, and the Fork intent is gone", async () => {
  const docId = "src-bare";
  const { u, load } = await pressFork("bare", docId, { navlag: 0 });
  await u.poll(async () => new URL(u.page.url()).pathname === "/signup", { timeout: 10_000, what: "/signup" });
  const loadsBefore = loads.length;
  const r = await u.signInUi("ok-b@example.com", "pw-b");
  assert.equal(r.status, "ok");
  assert.deepEqual(loads.slice(loadsBefore), [{ path: "/signup" }], "a fresh load of the bare sign-in page");
  assert.equal(sessions.at(-1).from, "/signup");
  assert.notEqual(sessions.at(-1).load, load, "another page load");
  assert.equal(new URL(r.url).pathname, "/", "landed on /, not the document");
  assert.equal(forks.filter((f) => f.docId === docId).length, 0, "no fork: the intent was lost");
});

test("NEGATIVE: here never opens a page — one that does not reach the sign-in page throws naming its pathname, never its query; here with a path throws first", async () => {
  const u = await pool().user({ name: "here-nowhere" });
  await u.goto(`/d/stays-here?k=${KEY}`);
  const loadsBefore = loads.length;
  await assert.rejects(
    u.signInUi("ok-n@example.com", "pw-n", { here: true, timeout: 1_500 }),
    (e) => /here-nowhere: signInUi\(\{here: true\}\): the app did not show the sign-in page \(\/signup, its form or a gate\) within 1500 ms; the page is at \/d\/stays-here$/.test(e.message) && !e.message.includes(KEY),
  );
  assert.equal(loads.length, loadsBefore, "nothing was opened");
  assert.equal(new URL(u.page.url()).pathname, "/d/stays-here");

  for (const path of ["/signup", "/signup?next=/d/x", null]) {
    await assert.rejects(u.signInUi("ok-n@example.com", "pw-n", { here: true, path }), /signInUi: here signs in on the sign-in page the app already opened, and path names one to open: give one or the other/, JSON.stringify(path));
  }
  for (const here of ["yes", 1, null]) {
    await assert.rejects(u.signInUi("ok-n@example.com", "pw-n", { here }), /signInUi: here is true or false/, JSON.stringify(here));
  }
  assert.equal(loads.length, loadsBefore, "still nothing opened");
});
