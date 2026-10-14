// SPDX-License-Identifier: Apache-2.0
// Self-test: User.delayRequests holds a user's own requests to one path by rule and lets them go on; User.failRequests answers them as failures; neither touches another origin (SPEC §6a, §12).

/**
 * Hermetic: a local server stands in for the stack's POST /draft (and a GET
 * /draft/<doc>/<file>, the frame's own, which a POST rule must never take).
 * It records each request as it ARRIVES, with the page's label for it, so
 * "held", "delivered in this order" and "never reached the stack" are read
 * from the server's side, not from the lib's own rows. A second server on
 * another port is somewhere the tripwire refuses (a loopback port that is not
 * the stack's). Needs Chrome.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { BrowserPool, FAIL_BODY } from "../lib/browser.mjs";

/** Every request the stand-in stack received: {label, method, path, at (Date.now())}. */
const arrivals = [];
/** Every request the other server received (none should). */
const elsewhere = [];
let server;
let other;
let port;
let otherPort;
let target;
let pool = null;

before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (url.pathname === "/" && req.method === "GET") {
        res.setHeader("content-type", "text/html");
        return res.end("<!doctype html><title>stand-in</title><p>stand-in</p>");
      }
      let label = null;
      try {
        label = JSON.parse(body).label ?? null;
      } catch {
        label = body || null;
      }
      arrivals.push({ label, method: req.method, path: url.pathname, at: Date.now() });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, label }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  port = server.address().port;
  other = http.createServer((req, res) => {
    elsewhere.push({ method: req.method, path: req.url });
    res.end("{}");
  });
  await new Promise((r) => other.listen(0, "127.0.0.1", r));
  otherPort = other.address().port;
  target = { kind: "local", runId: "selftest-delay-fail", origin: `http://127.0.0.1:${port}`, stack: { ports: { hosting: port } }, capabilities: new Set(["local"]) };
});

after(async () => {
  await pool?.close();
  server.closeAllConnections?.();
  other.closeAllConnections?.();
  await new Promise((r) => server.close(r));
  await new Promise((r) => other.close(r));
});

async function user(name) {
  pool ??= new BrowserPool({ target });
  const u = await pool.user({ name });
  await u.goto("/");
  return u;
}

/**
 * Send a request from the page without waiting for it; `window.__e2eSent[label]`
 * becomes {status, json} or {error}. `url` is relative to the page, or absolute.
 */
const send = (u, label, { url = "/draft", method = "POST", body = { label }, mode = "cors", contentType = "application/json" } = {}) =>
  u.page.evaluate(
    ({ label, url, method, body, mode, contentType }) => {
      window.__e2eSent ??= {};
      window.__e2eSent[label] = null;
      const init = { method, mode, credentials: "same-origin" };
      if (method !== "GET") {
        init.headers = { "content-type": contentType };
        init.body = typeof body === "string" ? body : JSON.stringify(body);
      }
      fetch(url, init)
        .then(async (r) => {
          const text = await r.text();
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {}
          window.__e2eSent[label] = { status: r.status, json, text };
        })
        .catch((e) => {
          window.__e2eSent[label] = { error: String(e?.message ?? e) };
        });
    },
    { label, url, method, body, mode, contentType },
  );

const answered = (u, label, timeout = 10_000) => u.poll(() => u.page.evaluate((l) => window.__e2eSent?.[l] ?? null, label), { timeout, what: `the page's answer to ${label}` });
const arrived = (label) => arrivals.filter((a) => a.label === label);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("delayRequests: a number holds that request so many ms before the stack sees it, in order; past the list and other methods go at once", { timeout: 60_000 }, async () => {
  const u = await user("ms");
  const d = await u.delayRequests("/draft", { rules: [700] });
  try {
    await send(u, "ms-1");
    await sleep(50);
    await send(u, "ms-2");
    await send(u, "ms-get", { url: "/draft/doc/index.html", method: "GET" });
    const two = await answered(u, "ms-2");
    assert.equal(two.status, 200, "the second POST, past the list, went at once");
    await answered(u, "ms-get");
    assert.deepEqual(arrived("ms-1"), [], "the first is still held: the stack has not seen it");
    const one = await answered(u, "ms-1");
    assert.equal(one.status, 200);
    const [a1] = arrived("ms-1");
    const [a2] = arrived("ms-2");
    assert.ok(a1.at - a2.at >= 550, `the held one reached the stack ${a1.at - a2.at} ms after the one sent 50 ms later (held 700)`);
    assert.deepEqual(
      d.rows.map(({ seq, method, path, postJson, rule, ms, released, ruleError }) => ({ seq, method, path, postJson, rule, ms, released, ruleError })),
      [
        { seq: 0, method: "POST", path: "/draft", postJson: { label: "ms-1" }, rule: "ms", ms: 700, released: "rule", ruleError: null },
        { seq: 1, method: "POST", path: "/draft", postJson: { label: "ms-2" }, rule: "none", ms: null, released: "at-once", ruleError: null },
      ],
      "one row per matching POST, in arrival order; the GET of /draft/<doc>/<file> is not one",
    );
    assert.ok(d.rows[0].releasedAt - d.rows[0].heldAt >= 690, `held ${d.rows[0].releasedAt - d.rows[0].heldAt} ms on this process's clock`);
    assert.equal(d.seen(), 2);
  } finally {
    await d.restore();
  }
  await send(u, "ms-after");
  assert.equal((await answered(u, "ms-after")).status, 200);
  assert.equal(d.seen(), 2, "after restore() nothing more is taken");
});

test("delayRequests: a function holds until its promise settles, so two saves reach the stack in the order a slow network delivers them; restore() lets a held one go; maxMs caps", { timeout: 60_000 }, async () => {
  const u = await user("until");
  let release;
  const gate = new Promise((r) => (release = r));
  const d = await u.delayRequests("/draft", { rules: [() => gate, () => new Promise(() => {}), () => Promise.reject(new Error("no luck")), null] });
  try {
    await send(u, "until-1");
    await u.poll(() => d.seen() === 1, { timeout: 10_000, what: "the first request at the route" });
    await send(u, "until-2");
    await u.poll(() => d.seen() === 2, { timeout: 10_000, what: "the second request at the route" });
    await send(u, "until-3");
    assert.equal((await answered(u, "until-3")).status, 200, "a rejected rule releases its request");
    assert.equal(d.rows[2].ruleError, "no luck");
    await sleep(300);
    assert.deepEqual([arrived("until-1").length, arrived("until-2").length], [0, 0], "both still held");
    assert.deepEqual([d.rows[0].released, d.rows[1].released], [null, null]);
    release();
    assert.equal((await answered(u, "until-1")).status, 200);
    assert.ok(arrived("until-1")[0].at >= arrived("until-3")[0].at, "the first save reached the stack after the third");
    assert.equal(d.rows[0].released, "rule");
  } finally {
    await d.restore();
  }
  assert.equal((await answered(u, "until-2")).status, 200, "restore() let the never-settling one go");
  assert.equal(d.rows[1].released, "restore");

  const capped = await u.delayRequests("/draft", { rules: [10_000], maxMs: 400 });
  try {
    const t0 = Date.now();
    await send(u, "cap-1");
    assert.equal((await answered(u, "cap-1")).status, 200);
    assert.ok(Date.now() - t0 < 5_000, "released by maxMs, not by its 10 s rule");
    assert.equal(capped.rows[0].released, "cap");
  } finally {
    await capped.restore();
  }
});

test("delayRequests and failRequests: match narrows by body; method null takes any; bad arguments throw before any route", { timeout: 60_000 }, async () => {
  const u = await user("match");
  const f = await u.failRequests("/draft", { match: (r) => r.postJson?.op === "accept" });
  try {
    await send(u, "m-claim", { body: { label: "m-claim", op: "claim" } });
    await send(u, "m-accept", { body: { label: "m-accept", op: "accept" } });
    assert.equal((await answered(u, "m-claim")).status, 200);
    assert.equal((await answered(u, "m-accept")).status, 500);
    assert.deepEqual(f.failed.map((r) => r.postJson.op), ["accept"]);
  } finally {
    await f.restore();
  }
  const any = await u.delayRequests(/^\/dr/, { method: null, rules: [0, 0] });
  try {
    await send(u, "any-get", { url: "/draft/d/x.html", method: "GET" });
    await answered(u, "any-get");
    assert.deepEqual(any.rows.map((r) => [r.method, r.path, r.rule, r.released]), [["GET", "/draft/d/x.html", "ms", "rule"]]);
  } finally {
    await any.restore();
  }
  const bad = [
    () => u.delayRequests("draft", { rules: [] }),
    () => u.delayRequests("//draft", { rules: [] }),
    () => u.delayRequests("/draft", { rules: 500 }),
    () => u.delayRequests("/draft", { rules: [-1] }),
    () => u.delayRequests("/draft", { rules: ["500"] }),
    () => u.delayRequests("/draft", { rules: [1], maxMs: 0 }),
    () => u.delayRequests("/draft", { rules: [1], method: "" }),
    () => u.failRequests("/draft", { status: 200 }),
    () => u.failRequests("/draft", { status: "network" }),
    () => u.failRequests("/draft", { count: 0 }),
    () => u.failRequests("/draft", { status: "abort", body: "x" }),
    () => u.failRequests("/draft", { match: "accept" }),
  ];
  for (const b of bad) await assert.rejects(b(), /match: (delayRequests|failRequests) /, String(b));
});

test("failRequests: the next `count` are answered here with the status and body, and never reach the stack; then the rest go through", { timeout: 60_000 }, async () => {
  const u = await user("fail");
  const f = await u.failRequests("/draft", { count: 2 });
  try {
    await send(u, "f-1");
    await send(u, "f-2");
    const [r1, r2] = [await answered(u, "f-1"), await answered(u, "f-2")];
    assert.deepEqual([r1.status, r1.json, r2.status], [500, FAIL_BODY, 500], "the default: 500 with FAIL_BODY");
    await send(u, "f-3");
    assert.equal((await answered(u, "f-3")).status, 200, "past count, the stack answers");
    assert.deepEqual([arrived("f-1"), arrived("f-2"), arrived("f-3").length], [[], [], 1], "a failed request never reached the stack");
    assert.deepEqual(f.failed.map(({ seq, method, path, postJson, status }) => ({ seq, method, path, postJson, status })), [
      { seq: 0, method: "POST", path: "/draft", postJson: { label: "f-1" }, status: 500 },
      { seq: 1, method: "POST", path: "/draft", postJson: { label: "f-2" }, status: 500 },
    ]);
  } finally {
    await f.restore();
  }

  const conflict = await u.failRequests("/draft", { status: 409, body: { error: "stale" } });
  const text = await u.failRequests("/draft", { status: 503, body: "busy", match: (r) => r.postJson?.label === "f-text" });
  try {
    await send(u, "f-text");
    await send(u, "f-409");
    const [t, c] = [await answered(u, "f-text"), await answered(u, "f-409")];
    assert.deepEqual([t.status, t.text], [503, "busy"], "a string body is sent as given; the later route answers first");
    assert.deepEqual([c.status, c.json], [409, { error: "stale" }], "every one until restore() with count null");
  } finally {
    await text.restore();
    await conflict.restore();
  }

  const cut = await u.failRequests("/draft", { status: "abort", count: 1 });
  try {
    await send(u, "f-abort");
    const a = await answered(u, "f-abort");
    assert.match(a.error ?? "", /Failed to fetch/, "abort is the browser's own network failure: fetch rejects");
    assert.deepEqual(cut.failed.map((r) => r.status), ["abort"]);
    assert.deepEqual(arrived("f-abort"), []);
  } finally {
    await cut.restore();
  }
  await send(u, "f-after");
  assert.equal((await answered(u, "f-after")).status, 200, "restored: the stack answers again");
});

test("NEGATIVE: only the stack's origin — the same path on another origin is not taken, and a request the tripwire refuses stays a breach", { timeout: 60_000 }, async () => {
  const u = await user("origin");
  const f = await u.failRequests("/draft", { method: null });
  const d = await u.delayRequests("/draft", { method: null, rules: [5_000, 5_000] });
  try {
    // Another origin on the stack's own port (localhost, not 127.0.0.1): the tripwire allows it, these must not take it.
    await send(u, "o-localhost", { url: `http://localhost:${port}/draft`, mode: "no-cors", contentType: "text/plain", body: "o-localhost" });
    await answered(u, "o-localhost");
    assert.equal(arrived("o-localhost").length, 1, "it reached the stand-in stack, unheld and unfailed");
    // A loopback port that is not the stack's: a breach the tripwire aborts. Answering it here would hide it.
    await send(u, "o-breach", { url: `http://127.0.0.1:${otherPort}/draft`, mode: "no-cors", contentType: "text/plain", body: "o-breach" });
    const b = await answered(u, "o-breach");
    assert.match(b.error ?? "", /Failed to fetch/, "aborted by the tripwire");
    assert.deepEqual(u.log.breaches.map((x) => [x.method, new URL(x.url).pathname]), [["POST", "/draft"]], "recorded as a breach");
    assert.deepEqual([f.failed.length, d.seen(), elsewhere.length], [0, 0, 0], "neither route took either request; nothing reached the other server");
  } finally {
    await d.restore();
    await f.restore();
  }
});
