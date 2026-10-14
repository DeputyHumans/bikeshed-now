// SPDX-License-Identifier: Apache-2.0
// Self-test: signInUi signs in at the sign-in URL it is given and reports each POST /session outcome once the page shows it (SPEC §2, §3, §12, §14).

/**
 * Hermetic: a local server stands in for the app's sign-in page as
 * app/src/pages/SignUp.tsx and app/src/auth.tsx render it. The page shows a
 * "Signing in" spinner while it decides, then the password form; "Sign in"
 * remembers the user (as Firebase persists one) and POSTs /session, and the
 * answer decides the page: "ok" moves the app to `safeNext(?next=)` with
 * history.replaceState, "unverified" shows the verification step,
 * "not_allowed" its notice, and anything else the form again with an error.
 * A remembered user posts /session again on the next load, so a context can
 * be signed in already. `?lag=<ms>` delays the page's answer to the response,
 * so a sign-in that returns at the response, not at the page, is caught;
 * `?keepform=1` leaves the form up, without its error, until the answer is
 * shown, so one that takes the bare form for a failed session is too. The
 * server answers by the address's first word: ok-, unverified-, notallowed-,
 * fail-, or nobody- (an "ok" with an empty body). Needs Chrome.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { BrowserPool } from "../lib/browser.mjs";

const APP = `<!doctype html><html><head><title>sign-in stand-in</title></head><body><div id="root"></div>
<script>
const q = new URLSearchParams(location.search);
const LAG = Number(q.get("lag") || 0);
const root = document.getElementById("root");
function safeNext(raw) {
  if (typeof raw !== "string" || !raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\\\")) return "/";
  try { const u = new URL(raw, "https://origin.invalid"); return u.origin === "https://origin.invalid" ? u.pathname + u.search + u.hash : "/"; } catch { return "/"; }
}
function card(step, title, inner) {
  const steps = [1, 2, 3].map((n) => '<span class="auth-step"' + (n === step ? ' aria-current="step"' : "") + ">" + n + ". step</span>").join("");
  return '<div class="auth-screen"><div class="auth-card"><h1 class="auth-title">' + title + '</h1><div class="auth-steps" aria-label="Progress">' + steps + "</div>" + inner + "</div></div>";
}
function render(gate, error) {
  if (location.pathname.toLowerCase() !== "/signup") { root.innerHTML = '<p id="landed">' + location.pathname + "</p>"; return; }
  if (gate === "loading") { root.innerHTML = '<div class="empty-state"><span class="spinner" role="status" aria-label="Signing in"></span><p>Signing in…</p></div>'; return; }
  if (gate === "ready") { history.replaceState(null, "", safeNext(q.get("next"))); root.innerHTML = '<p id="landed">' + location.pathname + "</p>"; return; }
  if (gate === "needs_verification") { root.innerHTML = card(3, "Almost there", '<p class="auth-lead">Confirm your address before continuing.</p><button type="button">Send me a code</button>'); return; }
  if (gate === "not_allowed") { root.innerHTML = card(1, "Almost there", '<div class="auth-notice" role="status"><strong>This deployment does not accept your address yet.</strong></div>'); return; }
  const banner = error ? '<div class="banner banner-error" role="alert">' + error + "</div>" : "";
  root.innerHTML = card(1, "Sign in to Bikeshed", banner + '<button type="button">Continue with Google</button><form id="f"><input id="auth-email" type="email"><input id="auth-password" type="password">' + (error ? '<p class="auth-notice" role="alert">' + error + "</p>" : "") + '<button type="submit">Sign in</button><button type="button">Create an account</button></form>');
  document.getElementById("f").onsubmit = (e) => { e.preventDefault(); const email = document.getElementById("auth-email").value; localStorage.setItem("user", email); sync(email, document.getElementById("auth-password").value); };
}
async function sync(email, password) {
  if (!q.get("keepform")) render("loading");
  const r = await fetch("/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password, from: location.pathname + location.search }) });
  let out;
  try { out = await r.json(); } catch { out = { status: r.ok ? "ok" : "session_failed" }; }
  if (LAG) await new Promise((res) => setTimeout(res, LAG));
  if (out.status === "ok") return render("ready");
  if (out.status === "unverified") return render("needs_verification");
  if (out.status === "not_allowed") return render("not_allowed");
  localStorage.removeItem("user");
  render("signed_out", "Could not establish a secure session. Try signing in again.");
}
render("loading");
const remembered = localStorage.getItem("user");
setTimeout(() => (remembered ? sync(remembered, null) : render("signed_out")), 150);
</script></body></html>`;

let server;
const posts = [];
let origin;
let target;
before(async () => {
  server = http.createServer((req, res) => {
    if (req.url === "/session" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const p = JSON.parse(body);
        posts.push(p);
        const kind = p.email.split("-")[0];
        res.setHeader("content-type", "application/json");
        if (kind === "unverified") return res.end(JSON.stringify({ status: "unverified" }));
        if (kind === "notallowed") return res.writeHead(403).end(JSON.stringify({ status: "not_allowed", message: "Ask an administrator." }));
        if (kind === "fail") return res.writeHead(401).end(JSON.stringify({ status: "session_failed" }));
        res.setHeader("set-cookie", "__session=s3ss10n; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=600");
        if (kind === "nobody") return res.writeHead(200, { "content-type": "text/plain" }).end("");
        res.end(JSON.stringify({ status: "ok" }));
      });
      return;
    }
    res.setHeader("content-type", "text/html");
    res.end(APP);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${server.address().port}`;
  target = { kind: "local", runId: "selftest-signin", origin, stack: { ports: { hosting: server.address().port } }, capabilities: new Set(["local"]) };
});
after(async () => {
  await new Promise((r) => server.close(r));
});

let shared = null;
const pool = () => (shared ??= new BrowserPool({ target }));
after(async () => shared?.close());

/** What the page shows right now: the current step, a notice, the form. */
const pageNow = (u) =>
  u.page.evaluate(() => ({
    path: location.pathname,
    step: Array.from(document.querySelectorAll(".auth-step")).findIndex((el) => el.getAttribute("aria-current") === "step") + 1,
    form: Boolean(document.querySelector("#auth-password")),
    notice: document.querySelector('.auth-notice[role="status"]')?.textContent ?? null,
    error: document.querySelector('.auth-card [role="alert"]')?.textContent ?? null,
  }));

test("ok at /signup?next=…: the form at that very URL, the cookie, the app landed on next; signed in again it is `already`", async () => {
  const u = await pool().user({ name: "ok" });
  const next = "/d/doc-1";
  const r = await u.signInUi("ok-a@example.com", "pw-1", { path: `/signup?next=${encodeURIComponent(next)}` });
  assert.deepEqual(
    { ...r, url: new URL(r.url).pathname },
    { status: "ok", already: false, httpStatus: 200, body: { status: "ok" }, gate: "ready", url: next },
  );
  assert.deepEqual(posts.at(-1), { email: "ok-a@example.com", password: "pw-1", from: `/signup?next=${encodeURIComponent(next)}` }, "the form signed in was the one at the given URL");
  assert.equal((await u.sessionCookie())?.value, "s3ss10n");
  assert.equal(u.email, "ok-a@example.com");

  const again = await u.signInUi("ok-a@example.com", "pw-1", { path: "/signup?next=/d/doc-2" });
  assert.deepEqual(
    { ...again, url: new URL(again.url).pathname },
    { status: "ok", already: true, httpStatus: 200, body: { status: "ok" }, gate: "ready", url: "/d/doc-2" },
    "a remembered user: no form, the page's own POST /session is the answer",
  );
  assert.equal(posts.at(-1).password, null, "that POST was the page's, not a filled form's");
});

test("a hostile next is the app's to judge: signInUi signs in at the URL as given, unaltered, and reports where the app went", async () => {
  for (const hostile of ["https://evil.example/", "//evil.example", "/\\evil.example"]) {
    const u = await pool().user({ name: "hostile" });
    const path = `/signup?next=${encodeURIComponent(hostile)}`;
    const r = await u.signInUi("ok-h@example.com", "pw-h", { path });
    assert.equal(posts.at(-1).from, path, hostile);
    assert.equal(new URL(r.url).pathname, "/", `${hostile}: the stand-in's safeNext sends it to /`);
  }
  const raw = await pool().user({ name: "raw" });
  const r = await raw.signInUi("ok-r@example.com", "pw-r", { path: "/signup?next=/\\evil.example" });
  assert.equal(posts.at(-1).from, "/signup?next=/\\evil.example", "an unencoded query reaches the page as given, and is not refused");
  assert.equal(r.status, "ok");
});

test("unverified: resolves once the verification step SHOWS (not at the response), with no cookie; the default expectation refuses it", async () => {
  const u = await pool().user({ name: "unverified" });
  const r = await u.signInUi("unverified-u@example.com", "pw-u", { path: "/signup?lag=900", expectStatus: "unverified" });
  const shown = await pageNow(u);
  assert.deepEqual({ ...r, url: new URL(r.url).pathname }, { status: "unverified", already: false, httpStatus: 200, body: { status: "unverified" }, gate: "needs_verification", url: "/signup" });
  assert.deepEqual(shown, { path: "/signup", step: 3, form: false, notice: null, error: null }, "the gate is on screen when signInUi returns");
  assert.equal(await u.sessionCookie(), null);

  const again = await u.signInUi("unverified-u@example.com", "pw-u", { expectStatus: "unverified" });
  assert.deepEqual([again.status, again.already, again.httpStatus, again.body, again.gate], ["unverified", true, 200, { status: "unverified" }, "needs_verification"], "a remembered unverified user stops at the gate on load");
  await assert.rejects(u.signInUi("unverified-u@example.com", "pw-u", { timeout: 10_000 }), /already signed in at \/signup: the page shows "unverified", POST \/session answered 200 \{"status":"unverified"\} \(wanted ok\)/);

  const fresh = await pool().user({ name: "unverified-default" });
  await assert.rejects(fresh.signInUi("unverified-v@example.com", "pw-v", { timeout: 10_000 }), /POST \/session answered 200 \{"status":"unverified"\} \(wanted ok\)/, "NEGATIVE: a 200 that is not {status: ok} is a failed sign-in");
});

test("not_allowed and session_failed: named, a list, or null for whatever comes; a mismatch throws with the answer", async () => {
  const na = await pool().user({ name: "notallowed" });
  const r1 = await na.signInUi("notallowed-n@example.com", "pw-n", { expectStatus: "not_allowed" });
  assert.deepEqual([r1.status, r1.httpStatus, r1.body, r1.gate], ["not_allowed", 403, { status: "not_allowed", message: "Ask an administrator." }, "not_allowed"]);
  assert.match((await pageNow(na)).notice, /does not accept your address/);

  const f1 = await pool().user({ name: "fail-null" });
  const r2 = await f1.signInUi("fail-a@example.com", "pw-f", { expectStatus: null, path: "/signup?lag=600&keepform=1" });
  const back = await pageNow(f1);
  assert.deepEqual([r2.status, r2.httpStatus, r2.gate, r2.already], ["session_failed", 401, "signed_out", false]);
  assert.deepEqual([back.form, back.error], [true, "Could not establish a secure session. Try signing in again."], "the form is back WITH its error when signInUi returns");

  const f2 = await pool().user({ name: "fail-list" });
  assert.equal((await f2.signInUi("fail-b@example.com", "pw-f", { expectStatus: ["ok", "session_failed"] })).status, "session_failed");

  const ok = await pool().user({ name: "ok-unexpected" });
  await assert.rejects(ok.signInUi("ok-x@example.com", "pw-x", { expectStatus: "unverified", timeout: 10_000 }), /POST \/session answered 200 \{"status":"ok"\} \(wanted unverified\)/);
  const nn = await pool().user({ name: "null-ok" });
  assert.equal((await nn.signInUi("ok-y@example.com", "pw-y", { expectStatus: null })).status, "ok");
});

test("an ok whose body cannot be read: the page decides, and says so", async () => {
  const u = await pool().user({ name: "nobody" });
  const r = await u.signInUi("nobody-z@example.com", "pw-z");
  assert.deepEqual([r.status, r.already, r.httpStatus, r.body, r.bodyUnread, r.gate], ["ok", false, 200, null, true, "ready"]);
  assert.equal((await u.sessionCookie())?.value, "s3ss10n");
});

test("NEGATIVE: a path that is not the sign-in page, or an unknown expectation, throws before anything is opened", async () => {
  const u = await pool().user({ name: "args" });
  for (const path of ["/account", "/d/x?next=/signup", "//evil.example/signup", "https://evil.example/signup", "signup", "", null]) {
    await assert.rejects(u.signInUi("ok-q@example.com", "pw", { path }), /signInUi: path is the sign-in page on this origin/, JSON.stringify(path));
  }
  for (const expectStatus of ["unverifed", "OK", [], ["ok", "nope"], 200]) {
    await assert.rejects(u.signInUi("ok-q@example.com", "pw", { expectStatus }), /signInUi: expectStatus is "ok", "unverified", "not_allowed", "session_failed", a list of them, or null/, JSON.stringify(expectStatus));
  }
  assert.equal(u.page.url(), "about:blank", "nothing was opened");
  assert.equal(u.email, null);
  const upper = await u.signInUi("ok-q@example.com", "pw", { path: "/SIGNUP?next=/d/upper" });
  assert.equal(new URL(upper.url).pathname, "/d/upper", "the router's case-insensitive /SIGNUP is the same page");
});
