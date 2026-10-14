// SPDX-License-Identifier: Apache-2.0
// Self-test: a browser user's network log holds every response, even one whose body never finishes, and waitForResponse finds it with its request body (SPEC §12).

/**
 * Hermetic: a local server stands in for the app. `POST /view` answers at
 * once and the page never reads the body, as the viewer's beat does. `POST
 * /hold` sends its headers and part of a body, then waits, so the page has a
 * response that has not finished: what Playwright shows for the viewer's
 * beats on the stack, where `requestfinished` never comes. `POST /cut` sends
 * its headers and then drops the connection. Needs Chrome.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { BrowserPool } from "../lib/browser.mjs";

const held = [];
let server;
let target;
before(async () => {
  server = http.createServer((req, res) => {
    if (req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        if (req.url === "/hold") {
          res.writeHead(200, { "content-type": "application/json" });
          res.write('{"held": ');
          held.push(res);
          return;
        }
        if (req.url === "/cut") {
          res.writeHead(200, { "content-type": "application/json" });
          res.write('{"cut": ');
          setTimeout(() => req.socket.destroy(), 300);
          return;
        }
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ms: 1234, got: body.length }));
      });
      return;
    }
    res.setHeader("content-type", "text/html");
    res.end("<!doctype html><title>app</title><p>app</p>");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  target = { kind: "local", runId: "selftest-responses", origin: `http://127.0.0.1:${port}`, stack: { ports: { hosting: port } }, capabilities: new Set(["local"]) };
});
after(async () => {
  for (const res of held) res.destroy();
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
});

const rowsFor = (u, path) => u.log.requests.filter((r) => new URL(r.url).pathname === path);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The viewer's beat, as app/src/stats.ts sends it: nobody reads the answer. */
const beat = (page, path, body) =>
  page.evaluate(({ path, body }) => {
    void fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), credentials: "same-origin" }).catch(() => {});
  }, { path, body });

test("a response whose body never finishes is in log.requests at its response, and its finish completes the same row", async () => {
  const pool = new BrowserPool({ target });
  try {
    const u = await pool.user();
    await u.goto("/");
    const mark = u.responseMark();
    await beat(u.page, "/hold", { docId: "d-hold", ms: 5 });
    const hit = await u.waitForResponse({ method: "POST", path: "/hold" }, { since: mark, timeout: 10_000 });
    assert.equal(hit.status, 200);
    assert.deepEqual(hit.postJson, { docId: "d-hold", ms: 5 }, "the request's JSON body, read from the request");
    assert.equal(hit.headers["content-type"], "application/json");
    assert.equal(hit.requestHeaders["content-type"], "application/json");
    await sleep(300);
    const open = rowsFor(u, "/hold");
    assert.equal(open.length, 1, `one row for the unfinished response: ${JSON.stringify(open)}`);
    assert.deepEqual([open[0].method, open[0].status, open[0].finished, open[0].failure], ["POST", 200, false, undefined]);

    for (const res of held.splice(0)) res.end("1}");
    await u.poll(() => rowsFor(u, "/hold")[0]?.finished === true, { timeout: 10_000, what: "the held response to finish" });
    const done = rowsFor(u, "/hold");
    assert.equal(done.length, 1, "the finish completes the row; it never adds a second");
    assert.ok(done[0].ms >= open[0].ms, "ms grows to the finish");
    assert.equal(u.findResponses("/hold", { since: mark }).length, 1, "one response, one entry");
  } finally {
    await pool.close();
  }
});

test("an unread beat is a response with its body; marks, predicates and waitForResponse's NEGATIVE", async () => {
  const pool = new BrowserPool({ target });
  try {
    const u = await pool.user();
    await u.goto("/");
    await beat(u.page, "/view", { docId: "d-old", ms: 1 });
    await u.waitForResponse("/view", { timeout: 10_000 });
    const mark = u.responseMark();
    await beat(u.page, "/view", { docId: "d-new", sessionId: "s1", ms: 2 });
    const hit = await u.waitForResponse((r) => r.method === "POST" && r.path === "/view" && r.postJson.docId === "d-new", { since: mark, timeout: 10_000 });
    assert.equal(hit.status, 200);
    assert.ok(hit.seq >= mark);
    assert.equal(hit.query.get("x"), null);
    await u.poll(() => u.findResponses("/view", { since: mark }).length === 1, { timeout: 10_000, what: "the beat to be recorded" });
    assert.equal((await u.waitForResponse("/view", { since: mark, timeout: 100 })).seq, hit.seq, "a response that arrived BEFORE the call is found, not waited for");
    assert.deepEqual(u.findResponses("/view", { since: mark }).map((r) => r.postJson.docId), ["d-new"], "the mark leaves the earlier beat out");
    assert.deepEqual(u.findResponses({ method: "post", path: /^\/vi/ }).map((r) => r.postJson.docId), ["d-old", "d-new"], "every beat without a mark, in order");
    assert.deepEqual(u.findResponses({ path: "/view", status: [404, 409] }), [], "a status list");
    assert.equal(u.findResponses((r) => r.postJson.nope.deeper).length, 0, "a predicate that throws is a non-match, not an error");
    assert.ok(rowsFor(u, "/view").every((r) => r.status === 200), "log.requests holds them too");
    await assert.rejects(u.waitForResponse({ path: "/view" }, { since: u.responseMark(), timeout: 400 }), /no matching response within 400 ms \(last seen: none\)/);
    await assert.rejects(u.waitForResponse("/never", { since: mark, timeout: 300 }), /last seen: POST \/view 200/);
    assert.throws(() => u.findResponses(42), /response predicate/);
  } finally {
    await pool.close();
  }
});

test("a response that fails after its headers keeps its status and gains the failure; JSON never holds a live object", async () => {
  const pool = new BrowserPool({ target });
  try {
    const u = await pool.user();
    await u.goto("/");
    const mark = u.responseMark();
    await u.page.evaluate(() => {
      void fetch("/cut", { method: "POST", body: "x" }).then((r) => r.text()).catch(() => {});
    });
    await u.waitForResponse("/cut", { since: mark, timeout: 10_000 });
    await u.poll(() => rowsFor(u, "/cut")[0]?.failure, { timeout: 10_000, what: "the cut response to fail" });
    const rows = rowsFor(u, "/cut");
    assert.equal(rows.length, 1, "the failure completes the row; it never adds a second");
    assert.equal(rows[0].status, 200);
    assert.equal(rows[0].finished, false);
    assert.ok(JSON.stringify(u.log.requests).length > 0, "log.requests stays plain data for evidence");
  } finally {
    await pool.close();
  }
});
