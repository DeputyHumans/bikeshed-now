// SPDX-License-Identifier: Apache-2.0
// Self-test: openCrossSitePage puts a user's page on an origin cross-site to the target, so the browser itself labels its requests Sec-Fetch-Site: cross-site (SPEC §12, §23).

/**
 * Hermetic: a local server stands in for the stack's Hosting on 127.0.0.1 and
 * records the `Sec-Fetch-Site` and `Origin` of every request, as the
 * product's site check reads them (functions/src/oauth/consent.ts). A second
 * pool uses a production-shaped target (kind "prod", an `.example` origin no
 * request ever reaches). Needs Chrome.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { BrowserPool, CROSS_SITE_PATH, openCrossSitePage } from "../lib/browser.mjs";

let server;
let port;
let target;
const seen = []; // {method, path, site, origin}

before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    seen.push({ method: req.method, path: url.pathname, site: req.headers["sec-fetch-site"] ?? null, origin: req.headers.origin ?? null });
    if (url.pathname === CROSS_SITE_PATH) {
      res.setHeader("content-type", "text/plain; charset=utf-8");
      return res.end("# a static file of the app\n");
    }
    res.setHeader("content-type", "text/html; charset=utf-8");
    return res.end(`<!doctype html><title>${url.pathname}</title><p id="at">${url.pathname}</p>`);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  port = server.address().port;
  target = { kind: "local", runId: "selftest-cross-site", origin: `http://127.0.0.1:${port}`, stack: { ports: { hosting: port } }, capabilities: new Set(["local"]) };
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
});

/** POST from the page to the target's /probe as a cross-site attacker can (no preflight); the server's row for it. */
async function probeFrom(u, tag) {
  await u.page.evaluate(({ to, tag: t }) => fetch(`${to}/probe-${t}`, { method: "POST", mode: "no-cors", credentials: "include", headers: { "content-type": "text/plain" }, body: "{}" }).then(() => undefined, () => undefined), { to: target.origin, tag });
  const row = seen.find((s) => s.path === `/probe-${tag}`);
  assert.ok(row, `the request reached the server: ${JSON.stringify(seen.slice(-3))}`);
  return row;
}

test("on a local stack: the stack's own Hosting under localhost, from which the browser labels a request to the stack cross-site", async () => {
  const p = pool(target);
  const u = await p.user({ name: "local" });
  const before = seen.length;
  const origin = await openCrossSitePage(u);
  assert.equal(origin, `http://localhost:${port}`);
  assert.equal(u.page.url(), `http://localhost:${port}${CROSS_SITE_PATH}`);
  assert.deepEqual(seen.slice(before).map((s) => s.path), [CROSS_SITE_PATH], "the page itself came from the stack, a static file (nothing booted)");
  const cross = await probeFrom(u, "cross");
  assert.deepEqual({ site: cross.site, origin: cross.origin }, { site: "cross-site", origin: `http://localhost:${port}` }, "labelled by the browser itself");

  await u.goto("/same");
  const same = await probeFrom(u, "same");
  assert.deepEqual({ site: same.site, origin: same.origin }, { site: "same-origin", origin: target.origin }, "positive control: from the stack's own origin the same request is same-origin");
  assert.deepEqual([u.log.breaches, u.log.external], [[], []], "a stack port under either name is the stack's");

  const other = await openCrossSitePage(u, { path: "/somewhere?x=1" });
  assert.equal(u.page.url(), `${other}/somewhere?x=1`, "path is any path of Hosting, sent as given");
});

test("via route: a reserved .example origin answered by the page's own route; nothing reaches any server or the tripwire", async () => {
  const p = pool(target);
  const u = await p.user({ name: "route" });
  const before = seen.length;
  const origin = await openCrossSitePage(u, { via: "route" });
  assert.match(origin, /^https:\/\/e2e-[0-9a-f]{8}\.example$/);
  assert.equal(u.page.url(), `${origin}${CROSS_SITE_PATH}`);
  assert.match(await u.page.textContent("body"), /A page on another site, made by the e2e harness/);
  assert.equal(await u.page.evaluate(() => fetch("/not-the-page").then((x) => x.status)), 404, "anything but a navigation there is a 404, answered by the route");
  assert.deepEqual(seen.slice(before), [], "the stack's server saw nothing");
  assert.deepEqual([u.log.breaches, u.log.external], [[], []], "nothing went to the tripwire (which aborts any .example request as external)");
  const second = await openCrossSitePage(u, { via: "route" });
  assert.notEqual(second, origin, "each call is a fresh origin");
});

test("on a production-shaped target the default is the route page, and via stack is refused", async () => {
  const prodLike = { kind: "prod", runId: "selftest-cross-site-prod", origin: "https://bikeshed.example", capabilities: new Set() };
  const p = pool(prodLike);
  const u = await p.user({ name: "prod" });
  const origin = await openCrossSitePage(u);
  assert.match(origin, /^https:\/\/e2e-[0-9a-f]{8}\.example$/);
  assert.deepEqual([u.log.breaches, u.log.external], [[], []]);
  await assert.rejects(openCrossSitePage(u, { via: "stack" }), /via "stack" opens the stack's own Hosting under its other loopback name, and a prod target has none: use via "route"/);
});

test("openCrossSitePage refuses a non-path, an unknown via, and anything that is not a pool's user", async () => {
  const p = pool(target);
  const u = await p.user({ name: "refusals" });
  await assert.rejects(openCrossSitePage(u, { path: "llms.txt" }), /path is a pathname/);
  await assert.rejects(openCrossSitePage(u, { path: "//evil.example/x" }), /path is a pathname/);
  await assert.rejects(openCrossSitePage(u, { via: "proxy" }), /via is "stack" or "route"/);
  await assert.rejects(openCrossSitePage(u.page), /a User of a BrowserPool/);
  const elsewhere = { ...target, origin: `http://10.0.0.1:${port}` };
  await assert.rejects(openCrossSitePage({ page: u.page, target: elsewhere }), /is on neither 127\.0\.0\.1 nor localhost/);
});
