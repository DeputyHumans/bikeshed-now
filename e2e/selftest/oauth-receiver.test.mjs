// SPDX-License-Identifier: Apache-2.0
// Self-test: startReceiver with the page that follows the redirect — received() waits for that page to load it, and a route receiver answers inside the browser with no socket (SPEC §23).

/**
 * Hermetic, with a real browser: a 24-port block is claimed through the
 * machine-wide lock directory, as spare.test.mjs does, and a fake local
 * target is built on it (its own run directory, so spare claims work), with a
 * stand-in consent page on its Hosting port. `/consent?back=<url>` has an
 * Approve button that does `location.assign(back)` 250 ms after the press, as
 * app/src/pages/Connect.tsx `decide` calls app/src/oauth.ts `leave` only once
 * its POST /oauth/consent has answered (so the click has returned before the
 * navigation starts, and Playwright's click does not wait for it);
 * `?fetch=<url>` has one that only fetches it. A second pool
 * uses a production-shaped target (kind "prod", origin `http://localhost:<the
 * same port>`), on which the tripwire calls any 127.0.0.1 request a breach.
 * Needs Chrome.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { E2E_TMP, ensureDir } from "../lib/paths.mjs";
import { allocateBlock } from "../lib/ports.mjs";
import { spareClaims, sparePorts } from "../lib/spare.mjs";
import { BrowserPool } from "../lib/browser.mjs";
import { ROUTE_RECEIVER_PORTS, startReceiver } from "../lib/oauth.mjs";

const PAGE = (q) => {
  const back = q.get("back");
  const fetchUrl = q.get("fetch");
  const go = back ? `setTimeout(() => location.assign(${JSON.stringify(back)}), 250)` : `fetch(${JSON.stringify(fetchUrl)}, { mode: "no-cors" }).catch(() => {})`;
  return `<!doctype html><title>consent stand-in</title><link rel="icon" href="data:,"><p>Connect?</p><button type="button" onclick='${go}'>Approve</button>`;
};

let dir;
let block;
let server;
let target;
let prodLike;
const hits = []; // every request the stand-in's server saw: {path}

before(async () => {
  dir = mkdtempSync(join(ensureDir(E2E_TMP, "E2E_TMP"), "selftest-receiver-"));
  block = await allocateBlock({ runId: `selftest-receiver-${process.pid}` });
  server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    hits.push({ path: url.pathname });
    res.setHeader("content-type", "text/html; charset=utf-8");
    if (url.pathname === "/consent") return res.end(PAGE(url.searchParams));
    return res.end(`<!doctype html><title>${url.pathname}</title><p id="at">${url.pathname}</p>`);
  });
  await new Promise((r) => server.listen(block.named.hosting, "127.0.0.1", r));
  target = { kind: "local", runId: `selftest-receiver-${process.pid}`, runDir: dir, origin: `http://127.0.0.1:${block.named.hosting}`, stack: { ports: block.named }, capabilities: new Set(["local"]) };
  prodLike = { kind: "prod", runId: `selftest-receiver-prod-${process.pid}`, origin: `http://localhost:${block.named.hosting}`, capabilities: new Set() };
});

const pools = [];
const pool = (t) => {
  const p = new BrowserPool({ target: t });
  pools.push(p);
  return p;
};
after(async () => {
  await Promise.all(pools.map((p) => p.close()));
  if (server) await new Promise((r) => server.close(r));
  block?.release();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const at = (page) => {
  const u = new URL(page.url());
  return `${u.origin}${u.pathname}`;
};

test("socket receiver with a page: wait() resolves before the browser is there; received() once the page has loaded it, so the next goto is not interrupted", async () => {
  const p = pool(target);
  const u = await p.user({ name: "socket" });
  const r = await startReceiver({ target, page: u });
  try {
    assert.equal(r.via, "socket");
    assert.ok(r.claim && sparePorts(target).includes(r.port), "a claimed spare port of the stack");
    assert.equal(r.redirectUri, `http://127.0.0.1:${r.port}/callback`);
    await u.goto(`/consent?back=${encodeURIComponent(`${r.redirectUri}?code=c1&state=s1&iss=i1`)}`);
    assert.equal(r.heard(), false, "nothing yet");
    await u.page.getByRole("button", { name: "Approve" }).click();

    const early = await r.wait(10_000);
    // Read in the same microtask run as the delivery: no CDP event can have been handled since.
    const whereAtWait = at(u.page);
    assert.equal(whereAtWait, `${target.origin}/consent`, "wait() resolves while the page is still on the consent page (the race received() closes)");
    assert.equal(r.heard(), true);

    const got = await r.received(10_000);
    assert.equal(at(u.page), `${r.redirectUri}`, "received() resolves with the page on the receiver");
    assert.equal(await u.page.evaluate(() => document.readyState), "complete", "and loaded");
    assert.match(await u.page.textContent("body"), /Received\./);
    assert.equal(got, early, "the same delivery as wait()");
    assert.deepEqual([got.code, got.state, got.iss, got.error, got.query], ["c1", "s1", "i1", null, { code: "c1", state: "s1", iss: "i1" }]);
    assert.equal(got.url, `${r.redirectUri}?code=c1&state=s1&iss=i1`, "url is the address the browser asked for, port included");
    await u.goto("/after");
    assert.equal(await u.page.textContent("#at"), "/after", "a goto straight after received() is not interrupted");
    assert.ok(r.requests.some((x) => x.method === "GET" && x.path === "/callback"), JSON.stringify(r.requests));
    assert.ok(r.requests.every((x) => !("query" in x) && !x.path.includes("?")), "rows never hold the query");
    assert.deepEqual(p.breaches(), []);
  } finally {
    await r.close();
  }
  assert.deepEqual(spareClaims(target), [], "close() released the claim");
});

test("route receiver on a local stack: answered inside the browser, with no socket and no breach; once closed, the same address is a breach", async () => {
  const p = pool(target);
  const u = await p.user({ name: "route" });
  const r = await startReceiver({ target, page: u, via: "route" });
  const hitsBefore = hits.length;
  try {
    assert.deepEqual([r.via, r.claim], ["route", null]);
    assert.ok(r.port >= ROUTE_RECEIVER_PORTS.min && r.port <= ROUTE_RECEIVER_PORTS.max, `port ${r.port} from ROUTE_RECEIVER_PORTS`);
    assert.ok(!sparePorts(target).includes(r.port) && !Object.values(block.named).includes(r.port), "never a stack port");
    assert.deepEqual(spareClaims(target), [], "no spare port claimed");
    await u.goto(`/consent?back=${encodeURIComponent(`${r.redirectUri}?code=c2&state=s2`)}`);
    // Another path on the receiver's origin is answered 404 here, never left to the tripwire: asked from the stack's
    // page, and below from the receiver's own. (Not /favicon.ico: Chrome under Playwright never issued a page's
    // request for that path to a routed origin at all, measured.)
    assert.equal(await u.page.evaluate((o) => fetch(`${o}/elsewhere`, { mode: "no-cors" }).then((x) => x.type), `http://127.0.0.1:${r.port}`), "opaque", "answered (a refusal would reject)");
    await u.page.getByRole("button", { name: "Approve" }).click();
    const got = await r.received(10_000);
    assert.deepEqual([got.code, got.state, at(u.page)], ["c2", "s2", r.redirectUri]);
    assert.match(await u.page.textContent("body"), /Received\./);
    assert.equal(await u.page.evaluate(() => fetch("/elsewhere").then((x) => x.status)), 404, "same-origin, from the receiver's page");
    assert.deepEqual(r.requests.map((x) => [x.method, x.path]), [["GET", "/elsewhere"], ["GET", "/callback"], ["GET", "/elsewhere"]], "one row per request the receiver answered, any path");
    assert.deepEqual([u.log.breaches, u.log.external], [[], []], "nothing reached the tripwire");
    assert.equal(hits.slice(hitsBefore).filter((h) => h.path === "/callback" || h.path === "/elsewhere").length, 0, "the stack's server saw none of it");
  } finally {
    await r.close();
  }
  await u.page.goto(`${r.redirectUri}?code=late`).catch(() => undefined);
  assert.equal(u.log.breaches.length, 1, `a closed route receiver's address goes to the tripwire: ${JSON.stringify(u.log.breaches)}`);
  assert.match(u.log.breaches[0].reason, new RegExp(`loopback port ${r.port} is not one of stack`));
});

test("two route receivers on one page get their own ports and their own redirects", async () => {
  const p = pool(target);
  const u = await p.user({ name: "two" });
  const [a, b] = [await startReceiver({ target, page: u, via: "route" }), await startReceiver({ target, page: u, via: "route" })];
  try {
    assert.notEqual(a.port, b.port);
    await u.goto(`/consent?back=${encodeURIComponent(`${b.redirectUri}?state=for-b`)}`);
    await u.page.getByRole("button", { name: "Approve" }).click();
    assert.equal((await b.received(10_000)).state, "for-b");
    assert.deepEqual([a.heard(), a.requests], [false, []], "the other one heard nothing");
  } finally {
    await a.close();
    await b.close();
  }
});

test("on a production-shaped target a page's receiver is a route by default, and the redirect never touches loopback", async () => {
  const p = pool(prodLike);
  const u = await p.user({ name: "prod" });
  const r = await startReceiver({ target: prodLike, page: u });
  try {
    assert.deepEqual([r.via, r.claim], ["route", null]);
    await u.goto(`/consent?back=${encodeURIComponent(`${r.redirectUri}?code=c3`)}`);
    await u.page.getByRole("button", { name: "Approve" }).click();
    assert.equal((await r.received(10_000)).code, "c3");
    assert.deepEqual(u.log.breaches, [], "the tripwire, which calls any 127.0.0.1 request from this target a breach, saw nothing");
  } finally {
    await r.close();
  }
  await assert.rejects(startReceiver({ target: prodLike, page: u, via: "socket" }), /a browser on a prod target may not navigate to loopback \(an isolation breach\): use via "route"/);
});

test("received() names where the page is (never the query) when the redirect arrived but the page did not follow it", async () => {
  const p = pool(target);
  const u = await p.user({ name: "fetched" });
  const r = await startReceiver({ target, page: u, via: "route" });
  try {
    await u.goto(`/consent?fetch=${encodeURIComponent(`${r.redirectUri}?code=secret-code`)}`);
    await u.page.getByRole("button", { name: "Approve" }).click();
    await assert.rejects(r.received(1_500), (e) => e.code === "E2E_OAUTH_TIMEOUT" && e.message === `the redirect reached the receiver, but the page did not load ${r.redirectUri} within 1500 ms; the page is at ${target.origin}/consent` && !e.message.includes("secret-code"));
    assert.equal(r.heard(), true);
  } finally {
    await r.close();
  }
});

test("startReceiver refuses a route without a page and an unknown via; without a page it is the socket receiver it always was", async () => {
  await assert.rejects(startReceiver({ target, via: "route" }), /via "route" answers the redirect inside the browser, so it needs the page that follows it/);
  await assert.rejects(startReceiver({ port: 0, via: "pipe" }), /via is "socket" or "route"/);
  const r = await startReceiver({ port: 0 });
  try {
    assert.deepEqual([r.via, r.claim, typeof r.received, r.heard()], ["socket", null, "function", false]);
    await fetch(`${r.redirectUri}?code=n1`);
    assert.equal((await r.received(2_000)).code, "n1", "without a page, received() is wait()");
  } finally {
    await r.close();
  }
});
