// SPDX-License-Identifier: Apache-2.0
// Self-test: signInUi({next}) opens /signup?next=<path> once and resolves only when the app has landed there (SPEC §3, §12, §21).

/**
 * Hermetic: a local server stands in for app/src/pages/SignUp.tsx and
 * app/src/next.ts. The sign-in page shows the password form; once POST
 * /session answers "ok" the app goes to safeNext(?next=) with
 * history.replaceState, as `<Navigate to={next} replace />` does. The server
 * answers /session by the address's first word: "ok", "unverified", "slow"
 * (ok, but the app shows /loading for 700 ms before going on), "home" (ok,
 * but the app goes to "/" whatever next says). Every document load is counted,
 * so "the app booted once" is the server's count. Needs Chrome.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { BrowserPool } from "../lib/browser.mjs";

const APP = `<!doctype html><html><head><title>next stand-in</title></head><body><div id="root"></div>
<script>
const root = document.getElementById("root");
function safeNext(raw) {
  if (typeof raw !== "string" || !raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\\\")) return "/";
  try { const u = new URL(raw, "https://origin.invalid"); return u.origin === "https://origin.invalid" ? u.pathname + u.search + u.hash : "/"; } catch { return "/"; }
}
function go(path) { history.replaceState(null, "", path); route(); }
function signInPage() {
  if (localStorage.getItem("user") && !localStorage.getItem("gate")) return go(safeNext(new URLSearchParams(location.search).get("next")));
  if (localStorage.getItem("gate")) { root.innerHTML = '<div class="auth-card"><span class="auth-step">1</span><span class="auth-step">2</span><span class="auth-step" aria-current="step">3</span></div>'; return; }
  root.innerHTML = '<div class="auth-card"><span class="auth-step" aria-current="step">1</span><form id="f"><input id="auth-email" type="email"><input id="auth-password" type="password"><button type="submit">Sign in</button></form></div>';
  document.getElementById("f").onsubmit = async (e) => {
    e.preventDefault();
    const email = document.getElementById("auth-email").value;
    const r = await fetch("/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, from: location.pathname + location.search }) });
    const out = await r.json();
    const next = safeNext(new URLSearchParams(location.search).get("next"));
    if (out.status === "unverified") { localStorage.setItem("user", email); localStorage.setItem("gate", "needs_verification"); return signInPage(); }
    localStorage.setItem("user", email);
    const kind = email.split("-")[0];
    if (kind === "home") return go("/");
    if (kind === "slow") { go("/loading"); return setTimeout(() => go(next), 700); }
    go(next);
  };
}
function route() {
  if (location.pathname.toLowerCase() === "/signup") return signInPage();
  root.innerHTML = '<p id="at">' + location.pathname + "</p>";
}
route();
</script></body></html>`;

let server;
let target;
const loads = []; // every document GET: path + query
const sessions = []; // every POST /session body

before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (req.method === "POST" && url.pathname === "/session") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const p = JSON.parse(body);
        sessions.push(p);
        res.setHeader("content-type", "application/json");
        if (p.email.startsWith("unverified-")) return res.end(JSON.stringify({ status: "unverified" }));
        res.setHeader("set-cookie", "__session=s3ss10n; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=600");
        return res.end(JSON.stringify({ status: "ok" }));
      });
      return;
    }
    loads.push(url.pathname + url.search);
    res.setHeader("content-type", "text/html");
    res.end(APP);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  target = { kind: "local", runId: "selftest-signin-next", origin: `http://127.0.0.1:${server.address().port}`, stack: { ports: { hosting: server.address().port } }, capabilities: new Set(["local"]) };
});

let shared = null;
const pool = () => (shared ??= new BrowserPool({ target }));
after(async () => {
  await shared?.close();
  await new Promise((r) => server.close(r));
});

test("next: one load of /signup?next=<encoded>, signed in there, and resolved on the page the app landed on; a second call on a signed-in context lands too", { timeout: 90_000 }, async () => {
  const u = await pool().user({ name: "next" });
  const before = loads.length;
  const r = await u.signInUi("ok-n@example.com", "pw", { next: "/d/doc-1" });
  assert.deepEqual([r.status, r.already, r.httpStatus, r.gate], ["ok", false, 200, "ready"]);
  assert.equal(new URL(r.url).pathname, "/d/doc-1");
  assert.deepEqual(loads.slice(before), ["/signup?next=%2Fd%2Fdoc-1"], "the app booted once, on the sign-in page");
  assert.equal(sessions.at(-1).from, "/signup?next=%2Fd%2Fdoc-1");
  assert.equal((await u.sessionCookie())?.value, "s3ss10n");

  const again = await u.signInUi("ok-n@example.com", "pw", { next: "/d/doc-1/v2?pin=1" });
  assert.deepEqual([again.status, again.already], ["ok", true]);
  assert.equal(new URL(again.url).pathname + new URL(again.url).search, "/d/doc-1/v2?pin=1", "already signed in: the app went straight on, and the query counts");
});

test("next: a landing that takes a while is waited for, not taken at the first page that is not the sign-in page", { timeout: 90_000 }, async () => {
  const u = await pool().user({ name: "slow" });
  const r = await u.signInUi("slow-s@example.com", "pw", { next: "/d/doc-2" });
  assert.equal(new URL(r.url).pathname, "/d/doc-2", "resolved at next, never at /loading");
  assert.equal(await u.page.locator("#at").textContent(), "/d/doc-2");
});

test("NEGATIVE: next: an app that lands elsewhere throws naming both pathnames and never the query; a non-ok outcome does not wait to land", { timeout: 90_000 }, async () => {
  const u = await pool().user({ name: "home" });
  await assert.rejects(
    u.signInUi("home-h@example.com", "pw", { next: "/d/doc-3?k=SECRETlinkKEY0123", timeout: 1_500 }),
    (e) => /home: signInUi\(\{next\}\): signed in, but the app did not land on \/d\/doc-3 within 1500 ms; the page is at \/$/.test(e.message) && !e.message.includes("SECRET"),
  );
  const v = await pool().user({ name: "unverified" });
  const r = await v.signInUi("unverified-v@example.com", "pw", { next: "/d/doc-4", expectStatus: "unverified", timeout: 5_000 });
  assert.deepEqual([r.status, r.gate], ["unverified", "needs_verification"]);
  assert.equal(new URL(r.url).pathname, "/signup", "still on the sign-in page, at its gate");
});

test("NEGATIVE: next refuses what the app would not honour, and next beside path or here, before anything opens", { timeout: 90_000 }, async () => {
  const u = await pool().user({ name: "refused" });
  const before = loads.length;
  for (const next of ["d/x", "//evil.example/d/x", "https://evil.example/d/x", "/d\\x", "/d/x\n", "", null, 7]) {
    await assert.rejects(u.signInUi("ok-r@example.com", "pw", { next }), /signInUi: next is a path on this origin that the app honours \(app\/src\/next\.ts safeNext\)/, JSON.stringify(next));
  }
  await assert.rejects(u.signInUi("ok-r@example.com", "pw", { next: "/d/x", path: "/signup" }), /signInUi: next builds the sign-in page's path \(\/signup\?next=…\): give next or path, not both/);
  await assert.rejects(u.signInUi("ok-r@example.com", "pw", { next: "/d/x", here: true }), /signInUi: next names a sign-in page to open, and here signs in on the one the app already opened/);
  assert.equal(loads.length, before, "nothing was opened");
});
