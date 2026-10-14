// SPDX-License-Identifier: Apache-2.0
// Self-test: User.delayRequests and failRequests `at: "firestore"` take a user's own requests to the stack's Firestore origin, and only there (SPEC §12).

/**
 * Hermetic: two local servers stand in for the stack's Hosting (the page's
 * origin) and its Firestore emulator (target.firestoreUrl, another stack
 * port). Each records every request as it ARRIVES, with the page's label for
 * it, so "held", "went on to Firestore" and "never reached it" are read from
 * the servers' side, not from the lib's rows. The page posts a form-encoded
 * body, as the Firestore SDK's channel does, to FIRESTORE_LISTEN_PATH on
 * either origin. A third server is a loopback port that is not the stack's,
 * where the tripwire refuses to go. Needs Chrome.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { BrowserPool, FIRESTORE_LISTEN_PATH } from "../lib/browser.mjs";

/** Every request each stand-in received: {label, method, path, at (Date.now())}. */
const arrivals = { hosting: [], firestore: [], other: [] };
const servers = {};
const ports = {};
let target;
let pool = null;

/** A stand-in that records each request (its `label` form field) and answers 200 to any origin. */
function standIn(name) {
  return http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (req.method === "OPTIONS") {
      res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST", "access-control-allow-headers": "content-type" });
      return res.end();
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (name === "hosting" && url.pathname === "/" && req.method === "GET") {
        res.setHeader("content-type", "text/html");
        return res.end("<!doctype html><title>stand-in</title><p>stand-in</p>");
      }
      const label = new URLSearchParams(body).get("label") ?? url.searchParams.get("label");
      arrivals[name].push({ label, method: req.method, path: url.pathname, at: Date.now() });
      res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
      res.end(JSON.stringify({ ok: true, from: name, label }));
    });
  });
}

before(async () => {
  for (const name of ["hosting", "firestore", "other"]) {
    servers[name] = standIn(name);
    await new Promise((r) => servers[name].listen(0, "127.0.0.1", r));
    ports[name] = servers[name].address().port;
  }
  target = {
    kind: "local",
    runId: "selftest-delay-firestore",
    origin: `http://127.0.0.1:${ports.hosting}`,
    firestoreUrl: `http://127.0.0.1:${ports.firestore}`,
    stack: { ports: { hosting: ports.hosting, firestore: ports.firestore } },
    capabilities: new Set(["local"]),
  };
});

after(async () => {
  await pool?.close();
  for (const s of Object.values(servers)) {
    s.closeAllConnections?.();
    await new Promise((r) => s.close(r));
  }
});

async function user(name) {
  pool ??= new BrowserPool({ target });
  const u = await pool.user({ name });
  await u.goto("/");
  return u;
}

/**
 * POST a form-encoded body (`label=<label>`, as a channel's) from the page to
 * FIRESTORE_LISTEN_PATH on `to` ("firestore", "hosting" or "other"), without
 * waiting; `window.__e2eSent[label]` becomes {status, json} or {error}.
 */
const post = (u, label, to = "firestore", { path = FIRESTORE_LISTEN_PATH, method = "POST" } = {}) =>
  u.page.evaluate(
    ({ label, url, method }) => {
      window.__e2eSent ??= {};
      window.__e2eSent[label] = null;
      const init = { method };
      if (method !== "GET") {
        init.headers = { "content-type": "application/x-www-form-urlencoded" };
        init.body = new URLSearchParams({ count: "1", label }).toString();
      }
      fetch(method === "GET" ? `${url}?label=${encodeURIComponent(label)}` : url, init)
        .then(async (r) => {
          let json = null;
          try {
            json = await r.json();
          } catch {}
          window.__e2eSent[label] = { status: r.status, json };
        })
        .catch((e) => {
          window.__e2eSent[label] = { error: String(e?.message ?? e) };
        });
    },
    { label, url: `http://127.0.0.1:${ports[to]}${path}`, method },
  );

const answer = (u, label, timeout = 10_000) => u.poll(() => u.page.evaluate((l) => window.__e2eSent?.[l] ?? null, label), { timeout, what: `the page's answer to ${label}` });
const arrived = (name, label) => arrivals[name].filter((a) => a.label === label);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("delayRequests at firestore: holds the page's POST to the stack's Firestore origin, then lets it go on to Firestore; the same path on the app's origin is not taken", { timeout: 60_000 }, async () => {
  const u = await user("listen");
  const d = await u.delayRequests(FIRESTORE_LISTEN_PATH, { at: "firestore", rules: [800] });
  try {
    await post(u, "fs-1", "firestore");
    await sleep(50);
    await post(u, "h-1", "hosting");
    await post(u, "fs-get", "firestore", { method: "GET" });
    const h1 = await answer(u, "h-1");
    assert.deepEqual([h1.status, h1.json?.from], [200, "hosting"], "the app's origin, same path: went at once");
    assert.equal((await answer(u, "fs-get")).status, 200, "a GET (the back channel) is not a POST rule's");
    assert.deepEqual(arrived("firestore", "fs-1"), [], "the Firestore POST is still held: Firestore has not seen it");
    const f1 = await answer(u, "fs-1");
    assert.deepEqual([f1.status, f1.json?.from], [200, "firestore"], "then it went on, to Firestore");
    const [a1] = arrived("firestore", "fs-1");
    const [h] = arrived("hosting", "h-1");
    assert.ok(a1.at - h.at >= 650, `the held one reached Firestore ${a1.at - h.at} ms after the one sent 50 ms later (held 800)`);
    assert.deepEqual(
      d.rows.map(({ seq, method, url, path, postJson, rule, ms, released }) => ({ seq, method, origin: new URL(url).origin, path, postJson, rule, ms, released })),
      [{ seq: 0, method: "POST", origin: target.firestoreUrl, path: FIRESTORE_LISTEN_PATH, postJson: null, rule: "ms", ms: 800, released: "rule" }],
      "one row, the Firestore origin's POST; a form-encoded body has no postJson",
    );
  } finally {
    await d.restore();
  }
  await post(u, "fs-after", "firestore");
  assert.equal((await answer(u, "fs-after")).status, 200);
  assert.equal(d.seen(), 1, "after restore() nothing more is taken");
});

test("delayRequests at firestore: one window for every POST (a gate made at the first, shared by every rule), and match reads the raw form body", { timeout: 60_000 }, async () => {
  const u = await user("window");
  let gate = null;
  let firstAt = null;
  const late = () => (gate ??= ((firstAt = Date.now()), sleep(1_200)));
  const seenBodies = [];
  const d = await u.delayRequests(FIRESTORE_LISTEN_PATH, {
    at: "firestore",
    rules: Array(20).fill(late),
    match: (r) => {
      seenBodies.push(r.postData);
      return !/label=w-skip/.test(r.postData ?? "");
    },
  });
  try {
    await post(u, "w-1");
    await sleep(400);
    await post(u, "w-2");
    await post(u, "w-skip");
    assert.equal((await answer(u, "w-skip")).status, 200, "a request match turns down goes at once");
    await answer(u, "w-1");
    await answer(u, "w-2");
    const [a1] = arrived("firestore", "w-1");
    const [a2] = arrived("firestore", "w-2");
    assert.ok(a1.at - firstAt >= 1_100 && a2.at - firstAt >= 1_100, `both held to the window's end: ${a1.at - firstAt} and ${a2.at - firstAt} ms after the first arrived`);
    assert.ok(Math.abs(a2.at - a1.at) < 300, `released together, ${Math.abs(a2.at - a1.at)} ms apart, though sent 400 ms apart`);
    assert.deepEqual(d.rows.map((r) => [r.rule, r.released]), [["until", "rule"], ["until", "rule"]]);
    assert.ok(seenBodies.some((b) => /(^|&)label=w-1(&|$)/.test(b ?? "")), "match saw the raw form body");
  } finally {
    await d.restore();
  }
  await post(u, "w-after");
  assert.equal((await answer(u, "w-after")).status, 200);
});

test("failRequests at firestore: answers the Firestore origin's requests here, so Firestore never sees them; the app's origin is not touched", { timeout: 60_000 }, async () => {
  const u = await user("fail");
  const f = await u.failRequests(FIRESTORE_LISTEN_PATH, { at: "firestore", status: 503, count: 1 });
  try {
    await post(u, "ff-1", "firestore");
    const r1 = await answer(u, "ff-1");
    assert.equal(r1.status, 503);
    await post(u, "fh-1", "hosting");
    assert.deepEqual((await answer(u, "fh-1")).json?.from, "hosting", "the app's origin, same path: answered by the app");
    await post(u, "ff-2", "firestore");
    assert.deepEqual((await answer(u, "ff-2")).json?.from, "firestore", "past count, Firestore answers");
    assert.deepEqual([arrived("firestore", "ff-1"), arrived("hosting", "fh-1").length, arrived("firestore", "ff-2").length], [[], 1, 1], "the failed one never reached Firestore");
    assert.deepEqual(f.failed.map(({ seq, method, url, path, status }) => ({ seq, method, origin: new URL(url).origin, path, status })), [
      { seq: 0, method: "POST", origin: target.firestoreUrl, path: FIRESTORE_LISTEN_PATH, status: 503 },
    ]);
  } finally {
    await f.restore();
  }
});

test("NEGATIVE: without `at` (the app's origin) neither takes the Firestore origin's requests, and with it neither takes another loopback port's: that stays a breach", { timeout: 60_000 }, async () => {
  const u = await user("origin");
  const plain = await u.delayRequests(FIRESTORE_LISTEN_PATH, { rules: [5_000] });
  try {
    await post(u, "n-fs", "firestore");
    const r = await answer(u, "n-fs", 3_000);
    assert.equal(r.json?.from, "firestore", "a hosting rule never held a Firestore request");
    assert.equal(plain.seen(), 0);
  } finally {
    await plain.restore();
  }
  const f = await u.failRequests(FIRESTORE_LISTEN_PATH, { at: "firestore", method: null });
  const d = await u.delayRequests(FIRESTORE_LISTEN_PATH, { at: "firestore", method: null, rules: [5_000, 5_000] });
  try {
    await post(u, "n-breach", "other");
    const b = await answer(u, "n-breach");
    assert.match(b.error ?? "", /Failed to fetch/, "aborted by the tripwire");
    assert.deepEqual(u.log.breaches.map((x) => [x.method, new URL(x.url).port, new URL(x.url).pathname]), [["POST", String(ports.other), FIRESTORE_LISTEN_PATH]], "recorded as a breach");
    assert.deepEqual([f.failed.length, d.seen(), arrivals.other.length], [0, 0, 0], "neither route took it; nothing reached the other server");
  } finally {
    await d.restore();
    await f.restore();
  }
});

test("at: anything but \"hosting\" or \"firestore\", or \"firestore\" on a target without a Firestore URL, throws before any route", { timeout: 60_000 }, async () => {
  const u = await user("bad");
  for (const at of ["auth", "Firestore", null, 1, ""]) {
    await assert.rejects(u.delayRequests(FIRESTORE_LISTEN_PATH, { at, rules: [1] }), /^Error: bad: delayRequests at is "hosting" \(the app's origin, the default\) or "firestore" \(the stack's Firestore\), got /, String(at));
    await assert.rejects(u.failRequests(FIRESTORE_LISTEN_PATH, { at }), /^Error: bad: failRequests at is "hosting"/, String(at));
  }
  const saved = target.firestoreUrl;
  delete target.firestoreUrl;
  try {
    assert.equal(u.target.firestoreUrl, undefined, "the user reads this target");
    await assert.rejects(u.delayRequests(FIRESTORE_LISTEN_PATH, { at: "firestore", rules: [1] }), /^Error: bad: delayRequests at "firestore": target selftest-delay-firestore names no firestoreUrl$/);
    await assert.rejects(u.failRequests(FIRESTORE_LISTEN_PATH, { at: "firestore" }), /^Error: bad: failRequests at "firestore": target selftest-delay-firestore names no firestoreUrl$/);
  } finally {
    target.firestoreUrl = saved;
  }
  await post(u, "bad-after", "firestore");
  assert.equal((await answer(u, "bad-after", 3_000)).json?.from, "firestore", "no route was left behind: nothing holds or fails the page's requests");
  assert.equal(arrived("firestore", "bad-after").length, 1);
});
