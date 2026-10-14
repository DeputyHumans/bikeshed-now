// SPDX-License-Identifier: Apache-2.0
// Self-test: BrowserPool.user({consent}) is a visitor who already answered the analytics consent banner — the app's own key, on the stack's origin alone, before the first script, once (SPEC §12, §15).

/**
 * A local server stands in for the app: its page records what the consent
 * key held when its first script ran, as CookieConsent reads it during its
 * first render (app/src/components/CookieConsent.tsx). A second server, on
 * another port, is another origin, framed by the first. The answer must be
 * there for the first script of the first page, reach no server on the way
 * (Playwright fulfils its own storage page), stay on the stack's origin, and
 * never be written again. The key is read from the product's own
 * app/src/consent.ts, so a lib key that drifts from it fails here. Needs
 * Chrome.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";
import { BrowserPool, CONSENT_KEY } from "../lib/browser.mjs";
import { OUT_DIR, REPO_ROOT } from "../lib/paths.mjs";

const CONSENT_SRC = readFileSync(join(REPO_ROOT, "app", "src", "consent.ts"), "utf8");
/** The app's own key, as app/src/consent.ts declares it. */
const APP_KEY = /^const KEY = "([^"]+)";$/m.exec(CONSENT_SRC)?.[1];

const runId = `selftest-consent-${process.pid}`;
let runDir;
let app;
let other;
let target;

/** What the first script of a document saw: the key's value (or "threw") and how many keys there were. */
const FIRST = (key) => `<script>
window.__first = (() => { try { return localStorage.getItem(${JSON.stringify(key)}); } catch (e) { return "threw"; } })();
window.__len = (() => { try { return localStorage.length; } catch (e) { return -1; } })();
</script>`;

/** A server that records every request it is sent, and answers each with a page that records the key. */
function stand(body) {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(body(req.url));
  });
  return { server, hits };
}

before(async () => {
  runDir = join(OUT_DIR, runId);
  mkdirSync(runDir, { recursive: true });
  other = stand(() => `<!doctype html><title>other</title>${FIRST(APP_KEY)}<body>other</body>`);
  await new Promise((r) => other.server.listen(0, "127.0.0.1", r));
  const otherPort = other.server.address().port;
  app = stand((url) => `<!doctype html><title>app</title>${FIRST(APP_KEY)}<body>app${url.startsWith("/framed") ? `<iframe src="http://127.0.0.1:${otherPort}/inner"></iframe>` : ""}</body>`);
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const port = app.server.address().port;
  target = Object.freeze({ kind: "local", runId, runDir, origin: `http://127.0.0.1:${port}`, projectId: "demo-bikeshed", capabilities: new Set(["local"]), stack: { ports: { hosting: port, other: otherPort } } });
});

after(async () => {
  for (const s of [app, other]) {
    s?.server.closeAllConnections?.();
    await new Promise((r) => (s ? s.server.close(r) : r()));
  }
  rmSync(runDir, { recursive: true, force: true });
});

const first = (pageOrFrame) => pageOrFrame.evaluate(() => ({ first: window.__first, len: window.__len }));

test("CONSENT_KEY is the app's own key, and only the two answers it reads are taken; anything else throws before a browser or a context is made", async () => {
  assert.equal(typeof APP_KEY, "string", "app/src/consent.ts declares its key as `const KEY = \"…\";`");
  assert.equal(CONSENT_KEY, APP_KEY, "the lib's key is the app's");
  assert.match(CONSENT_SRC, /return value === "granted" \|\| value === "denied" \? value : "unset";/, "the app reads exactly these two answers");
  const pool = new BrowserPool({ target });
  try {
    for (const consent of ["yes", "Denied", "unset", "", true, 0, {}, ["denied"]]) {
      await assert.rejects(pool.user({ name: "bad", consent }), (err) => err instanceof TypeError && /^user\(\): consent is "denied", "granted" or null \(unanswered\), got /.test(err.message), JSON.stringify(consent));
    }
    await assert.rejects(pool.many(2, { consent: "accepted" }), /^TypeError: many\(\): consent is "denied", "granted" or null \(unanswered\), got "accepted"$/);
    assert.deepEqual([pool.users.length, pool.browsers.length], [0, 0], "nothing was made");
  } finally {
    await pool.close();
  }
});

test("answered before the first page: its first script reads the answer; no server sees the seeding, and the tripwire sees nothing; null or nothing leaves it unanswered", async () => {
  const pool = new BrowserPool({ target });
  try {
    for (const consent of ["denied", "granted", null, undefined]) {
      const before = app.hits.length;
      const u = await pool.user(consent === undefined ? { name: "omitted" } : { name: `c-${consent}`, consent });
      assert.deepEqual(app.hits.slice(before), [], `${consent}: making the user fetched nothing from the stack`);
      await u.goto("/app");
      assert.deepEqual(await first(u.page), consent ? { first: consent, len: 1 } : { first: null, len: 0 }, String(consent));
      assert.deepEqual(app.hits.slice(before).filter((h) => !h.startsWith("GET /favicon")), ["GET /app"], `${consent}: only the case's own page`);
    }
    assert.ok(!app.hits.includes("GET /"), "Playwright's storage page at the origin never reached the server");
    assert.deepEqual(pool.users.flatMap((u) => [...u.log.breaches, ...u.log.external]), [], "the tripwire saw nothing");
    pool.assertIsolation();
  } finally {
    await pool.close();
  }
});

test("the stack's origin alone: a frame from another origin sees no answer and no key", async () => {
  const pool = new BrowserPool({ target });
  try {
    const u = await pool.user({ name: "framed", consent: "denied" });
    await u.goto("/framed");
    const inner = await u.poll(() => u.page.frames().find((f) => f.url().endsWith("/inner")), { timeout: 10_000, what: "the other origin's frame" });
    await inner.waitForFunction(() => "__first" in window, null, { timeout: 10_000 });
    assert.deepEqual(await first(u.page), { first: "denied", len: 1 });
    assert.deepEqual(await first(inner), { first: null, len: 0 }, "another origin's storage is untouched");
    assert.ok(other.hits.includes("GET /inner"));
    pool.assertIsolation();
  } finally {
    await pool.close();
  }
});

test("once: a case that removes the answer sees it unanswered after a reload and in a new page; another user starts answered", async () => {
  const pool = new BrowserPool({ target });
  try {
    const u = await pool.user({ name: "once", consent: "denied" });
    await u.goto("/app");
    assert.equal((await first(u.page)).first, "denied");
    await u.page.evaluate((k) => localStorage.removeItem(k), CONSENT_KEY);
    await u.page.reload();
    assert.deepEqual(await first(u.page), { first: null, len: 0 }, "nothing answered it again on the next document");
    const second = await u.context.newPage();
    await second.goto("/app");
    assert.deepEqual(await first(second), { first: null, len: 0 }, "nor on a new page of the same visitor");
    const fresh = await pool.user({ name: "fresh", consent: "denied" });
    await fresh.goto("/app");
    assert.equal((await first(fresh.page)).first, "denied", "each user's own context");
  } finally {
    await pool.close();
  }
});

test("many(): each user brings the answer; without it, none does", async () => {
  const pool = new BrowserPool({ target });
  try {
    const answered = await pool.many(2, { consent: "granted", names: ["m1", "m2"] });
    const plain = await pool.many(1, { names: ["m3"] });
    for (const u of [...answered, ...plain]) await u.goto("/app");
    assert.deepEqual(await Promise.all([...answered, ...plain].map(async (u) => [u.name, (await first(u.page)).first])), [["m1", "granted"], ["m2", "granted"], ["m3", null]]);
  } finally {
    await pool.close();
  }
});
