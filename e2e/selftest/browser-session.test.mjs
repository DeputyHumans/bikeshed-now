// SPDX-License-Identifier: Apache-2.0
// Self-test: browserSession(user) rides the session a browser user is signed in with — its own __session cookie, its own account — and opens none (SPEC §12, §14).

/**
 * A local server stands in for the stack: GET /set answers with the
 * `__session` cookie as POST /session sets it (HttpOnly, Secure, SameSite
 * Strict, Path=/, a Max-Age), holding a token shaped as the stack mints one
 * (built here from its claims, unsigned); GET /whoami answers with the
 * Cookie header it was sent. The client browserSession returns must send
 * the browser's own cookie, name the account the cookie names, and make no
 * request of its own. Needs Chrome.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";
import { BrowserPool } from "../lib/browser.mjs";
import { createHttp } from "../lib/http.mjs";
import { OUT_DIR } from "../lib/paths.mjs";
import { browserSession, mintToken } from "../lib/session.mjs";

const runId = `selftest-browser-session-${process.pid}`;
let runDir;
let server;
let target;
const hits = [];

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
/** A session token as the stack's Auth emulator mints one: unsigned, its claims naming the account. */
const token = (claims) => `${b64({ alg: "none", typ: "JWT" })}.${b64({ iss: "https://session.firebase.google.com/demo-bikeshed", aud: "demo-bikeshed", ...claims })}.`;
const COOKIE_A = token({ user_id: "uid-a", sub: "uid-a", email: "owner-a@example.com" });
const COOKIE_SUB = token({ sub: "uid-s" });
const COOKIES = { "/set": COOKIE_A, "/set-sub": COOKIE_SUB, "/set-opaque": "an-opaque-session-value", "/set-nameless": token({ email: "nobody@example.com" }) };

before(async () => {
  runDir = join(OUT_DIR, runId);
  mkdirSync(runDir, { recursive: true });
  server = http.createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    if (req.url === "/whoami") {
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ cookie: req.headers.cookie ?? null }));
    }
    if (req.method === "POST" && req.url === "/tokens") {
      res.setHeader("content-type", "application/json");
      const ok = (req.headers.cookie ?? "").includes(`__session=${COOKIE_A}`);
      res.statusCode = ok ? 200 : 401;
      return res.end(JSON.stringify(ok ? { tokenId: "t1", token: `bsk_${"0".repeat(32)}.stand-in` } : { error: "no session" }));
    }
    if (COOKIES[req.url]) res.setHeader("set-cookie", `__session=${COOKIES[req.url]}; Max-Age=3600; Path=/; HttpOnly; Secure; SameSite=Strict`);
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end("<!doctype html><title>stand-in</title><p>stand-in");
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

const client = () => createHttp(target, { actor: "selftest", evidence: false, guard: { check: () => ({ allow: true }) } });

test("the client sends the browser's own __session cookie; uid and account are the cookie's; no request is made to get it", async () => {
  const pool = new BrowserPool({ target });
  try {
    const u = await pool.user({ name: "owner" });
    await u.goto("/set");
    const before = hits.length;
    const s = await browserSession(u, { http: client() });
    assert.deepEqual(hits.slice(before), [], "nothing was sent: no POST /session, no sign-in");
    assert.deepEqual({ ...s, http: typeof s.http.get }, { account: { role: "owner", email: "owner-a@example.com", uid: "uid-a" }, http: "function", uid: "uid-a", idToken: null, refreshToken: null, via: "browser" });
    const r = await s.http.get("/whoami");
    assert.equal(r.json.cookie, `__session=${COOKIE_A}`, "the browser's own cookie, as it holds it");
    const jarred = [...s.http.jar.cookies.values()].find((c) => c.name === "__session");
    assert.ok(jarred.expires > Date.now() + 3_500_000 && jarred.expires <= Date.now() + 3_600_000, `it keeps the cookie's expiry (${jarred.expires - Date.now()} ms left)`);
    assert.deepEqual([jarred.path, jarred.secure, jarred.hostOnly], ["/", true, true], "its path, Secure, and its host alone");

    // A cast account is the session's when its uid is the cookie's; it works with the session helpers.
    const acct = { role: "writer", email: "owner-a@example.com", password: "unused", uid: "uid-a" };
    const mine = client();
    const w = await browserSession(u, { account: acct, http: mine });
    assert.equal(w.account, acct, "the account given, itself");
    assert.equal(w.http, mine, "the client given, its jar now holding the cookie");
    assert.equal(mine.jar.get("__session"), COOKIE_A);
    const minted = await mintToken(w, { name: "selftest" });
    assert.equal(minted.tokenId, "t1", "a session helper takes it: POST /tokens rode the browser's cookie");

    // Without a client, it makes one (evidence off here); a cookie naming only `sub` is read from `sub`.
    const v = await pool.user({ name: "viewer" });
    await v.goto("/set-sub");
    const own = await browserSession(v, { evidence: false });
    assert.equal(own.uid, "uid-s");
    assert.deepEqual(own.account, { role: "viewer", email: null, uid: "uid-s" });
    assert.equal((await own.http.get("/whoami")).json.cookie, `__session=${COOKIE_SUB}`);
  } finally {
    await pool.close();
  }
});

test("NEGATIVE: no cookie, a cookie for another host, a cookie that names no account, another account's uid, and a non-user all throw; nothing is sent", async () => {
  const pool = new BrowserPool({ target });
  try {
    const before = hits.length;
    await assert.rejects(browserSession(null), (err) => err instanceof TypeError && /^browserSession\(user\): user is a browser\.mjs User of a target, signed in \(signInUi\)$/.test(err.message));
    await assert.rejects(browserSession({ name: "plain", target }), TypeError);

    const fresh = await pool.user({ name: "fresh" });
    await fresh.goto("/page");
    const none = new RegExp(`^browserSession: fresh holds no __session cookie for ${target.origin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}; sign it in first \\(signInUi\\)$`);
    await assert.rejects(browserSession(fresh), (err) => err.code === "E2E_SESSION" && none.test(err.message));

    // The same port under the other loopback name is another host: its cookie is not the stack's.
    const elsewhere = await pool.user({ name: "elsewhere" });
    await elsewhere.goto(`http://localhost:${target.stack.ports.hosting}/set`);
    await assert.rejects(browserSession(elsewhere), (err) => err.code === "E2E_SESSION" && /holds no __session cookie/.test(err.message));

    for (const [path, name] of [["/set-opaque", "opaque"], ["/set-nameless", "nameless"]]) {
      const u = await pool.user({ name });
      await u.goto(path);
      await assert.rejects(browserSession(u), (err) => err.code === "E2E_SESSION" && err.message === `browserSession: ${name}'s __session cookie is not a token naming its account`, path);
    }

    const owner = await pool.user({ name: "owner" });
    await owner.goto("/set");
    const other = { role: "viewer", email: "viewer-b@example.com", password: "unused", uid: "uid-b" };
    await assert.rejects(browserSession(owner, { account: other, http: client() }), (err) => err.code === "E2E_SESSION" && err.message === "browserSession: owner is signed in as uid uid-a, not as viewer (uid uid-b)");
    assert.deepEqual(hits.slice(before).filter((h) => !/^GET \/(page|set|set-opaque|set-nameless)$/.test(h) && !h.startsWith("GET /favicon")), [], "only the pages the users opened");
  } finally {
    await pool.close();
  }
});
