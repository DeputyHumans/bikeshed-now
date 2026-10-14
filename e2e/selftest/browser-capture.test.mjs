// SPDX-License-Identifier: Apache-2.0
// Self-test: User.capture keeps each request a page sends, with its JSON body, op and send/answer/finish times, in send order (SPEC §12).

/**
 * Hermetic: a local server stands in for the app's review endpoints. POST
 * /suggestion answers by its body's `op`: `claim` after 150 ms, `slow` after
 * 600 ms, `accept` at once, `refuse` with a 409, `early` drops the connection before any header,
 * `late` sends its headers and part of a body and then drops it, `hold`
 * sends its headers and part of a body and waits to be released. POST /draft
 * answers after 50 ms, POST /plain answers text, GET /page holds an image
 * and a frame whose script POSTs /other. The page sends them as the
 * review bar does: each after the previous one's body has been read, or all
 * at once. Needs Chrome.
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
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const json = (status, value, ms = 0) =>
        setTimeout(() => {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(value));
        }, ms);
      if (req.method === "GET" && req.url === "/") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<!doctype html><title>app</title><p>app</p>");
        return;
      }
      if (req.method === "GET" && req.url === "/page") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end('<!doctype html><title>page</title><img src="/pixel.png" alt=""><iframe src="/inner"></iframe>');
        return;
      }
      if (req.method === "GET" && req.url === "/inner") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end('<!doctype html><title>inner</title><script>fetch("/other", { method: "POST", body: "{\\"op\\": \\"framed\\"}" }).then((r) => r.text());</script>');
        return;
      }
      if (req.url === "/suggestion" && req.method === "POST") {
        let op = null;
        try {
          op = JSON.parse(body).op;
        } catch {}
        if (op === "early") return void req.socket.destroy();
        if (op === "late" || op === "hold") {
          res.writeHead(200, { "content-type": "application/json" });
          res.write(`{"${op}": `);
          if (op === "late") setTimeout(() => req.socket.destroy(), 200);
          else held.push(res);
          return;
        }
        const ms = op === "claim" ? 150 : op === "slow" ? 600 : 0;
        return json(op === "refuse" ? 409 : 200, { op, got: body.length }, ms);
      }
      if (req.url === "/suggestion") return json(200, { get: true });
      if (req.url === "/draft") return json(200, { saved: body.length }, 50);
      if (req.url === "/other") return json(200, { other: true });
      if (req.url === "/plain") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("not json");
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  target = { kind: "local", runId: "selftest-capture", origin: `http://127.0.0.1:${port}`, stack: { ports: { hosting: port } }, capabilities: new Set(["local"]) };
});
after(async () => {
  for (const res of held) res.destroy();
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const label = (r) => (r.op ? `${r.path}:${r.op}` : r.path);

/** In the page: POST each body in turn, each only once the previous answer's body has been read (as the review bar does). */
const inTurn = (page, steps) =>
  page.evaluate(async (steps) => {
    for (const [path, body] of steps) {
      const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      await r.text();
    }
  }, steps);

/** In the page: POST every body without waiting for any answer, `gapMs` apart, and resolve once all are sent. */
const atOnce = (page, steps, { raw = false, gapMs = 0 } = {}) =>
  page.evaluate(async ({ steps, raw, gapMs }) => {
    for (const [path, body] of steps) {
      void fetch(path, { method: "POST", headers: { "content-type": raw ? "text/plain" : "application/json" }, body: raw ? body : JSON.stringify(body) })
        .then((r) => r.text())
        .catch(() => {});
      if (gapMs) await new Promise((r) => setTimeout(r, gapMs));
    }
  }, { steps, raw, gapMs });

test("capture: claim, draft, accept in send order, each sent after the previous one finished, with bodies, ops, statuses and JSON", async () => {
  const pool = new BrowserPool({ target });
  try {
    const u = await pool.user();
    await u.goto("/");
    await inTurn(u.page, [["/suggestion", { op: "claim", annId: "before" }]]);
    const rows = u.capture({ paths: ["/suggestion", "/draft"] });
    assert.deepEqual([rows.length, rows.mark()], [0, 0], "a capture starts empty: what was sent before it is no row");
    const t0 = performance.now();
    await inTurn(u.page, [
      ["/suggestion", { op: "claim", annId: "s1", replacement: "R" }],
      ["/other", { op: "noise" }],
      ["/draft", { html: "<p>R</p>" }],
      ["/suggestion", { op: "accept", annId: "s1", replacement: "R" }],
    ]);
    await u.page.evaluate(() => fetch("/suggestion").then((r) => r.text()));
    const acc = await rows.waitFor({ path: "/suggestion", op: "accept" }, { timeout: 10_000 });
    assert.equal(acc.settled, true);
    assert.deepEqual(rows.map(label), ["/suggestion:claim", "/draft", "/suggestion:accept"], "POSTs on the paths only, in the order they were sent (not /other, not a GET)");
    assert.deepEqual(rows.map((r) => r.seq), [0, 1, 2]);
    assert.deepEqual(rows.map((r) => [r.method, r.status, r.state, r.failure]), [["POST", 200, "finished", null], ["POST", 200, "finished", null], ["POST", 200, "finished", null]]);
    assert.deepEqual(rows[0].postJson, { op: "claim", annId: "s1", replacement: "R" }, "the request's JSON body");
    assert.equal(rows[1].op, null, "a body without op has op null");
    assert.deepEqual(rows[1].postJson, { html: "<p>R</p>" });
    assert.deepEqual(rows.map((r) => r.json), [{ op: "claim", got: rows[0].request.postData().length }, { saved: rows[1].request.postData().length }, { op: "accept", got: rows[2].request.postData().length }], "each response's JSON");
    for (const r of rows) {
      assert.ok(r.sentAt >= t0 && r.sentAt <= r.respondedAt && r.respondedAt <= r.doneAt, `${label(r)}: sent ≤ answered ≤ done (${r.sentAt}, ${r.respondedAt}, ${r.doneAt})`);
      assert.ok(Math.abs(r.t - Date.now()) < 60_000, "t is the wall clock");
      assert.equal(r.url, `${target.origin}${r.path}`);
    }
    for (let i = 1; i < rows.length; i += 1) {
      assert.ok(rows[i - 1].doneAt <= rows[i].sentAt, `${label(rows[i])} was sent after ${label(rows[i - 1])} had finished`);
    }
    assert.ok(rows[0].doneAt - rows[0].sentAt >= 100, `the claim took its 150 ms (${rows[0].doneAt - rows[0].sentAt})`);
    const plain = JSON.parse(JSON.stringify(rows));
    assert.equal(plain.length, 3, "rows stringify as plain data");
    assert.equal("request" in plain[0], false, "the Playwright request is not serialised");
    assert.equal(Object.keys(rows[0]).includes("request"), false);
    assert.equal(rows[0].request.method(), "POST", "but it is there, non-enumerable");
    rows.stop();
  } finally {
    await pool.close();
  }
});

test("capture: requests sent together are rows in send order, and their times show they overlapped", async () => {
  const pool = new BrowserPool({ target });
  try {
    const u = await pool.user();
    await u.goto("/");
    const rows = u.capture({ paths: "/suggestion" });
    await atOnce(u.page, [["/suggestion", { op: "slow", annId: "a" }], ["/suggestion", { op: "accept", annId: "a" }]], { gapMs: 50 });
    await rows.waitFor({ op: "slow" }, { timeout: 10_000 });
    await rows.waitFor({ op: "accept" }, { timeout: 10_000 });
    assert.deepEqual(rows.map((r) => r.op), ["slow", "accept"], "send order, not answer order");
    const [slow, acc] = rows;
    assert.ok(acc.doneAt < slow.doneAt, "the accept finished first");
    assert.ok(slow.sentAt < acc.sentAt && acc.doneAt < slow.respondedAt, `the accept was sent and finished while the slow one waited (slow ${slow.sentAt}–${slow.respondedAt}, accept ${acc.sentAt}–${acc.doneAt})`);
    assert.ok(!(slow.doneAt <= acc.sentAt), "so an in-turn check over them fails, as it must");
  } finally {
    await pool.close();
  }
});

test("capture: a request that fails before or after its headers is a settled row with its failure", async () => {
  const pool = new BrowserPool({ target });
  try {
    const u = await pool.user();
    await u.goto("/");
    const rows = u.capture({ paths: "/suggestion" });
    await atOnce(u.page, [["/suggestion", { op: "early" }], ["/suggestion", { op: "late" }]]);
    const early = await rows.waitFor({ op: "early" }, { timeout: 10_000 });
    const late = await rows.waitFor({ op: "late" }, { timeout: 10_000 });
    assert.deepEqual([early.state, early.status, early.respondedAt, early.json], ["failed", null, null, null], "no response at all: no status");
    assert.ok(typeof early.failure === "string" && early.failure.length > 0, `early's failure: ${early.failure}`);
    assert.ok(early.doneAt >= early.sentAt);
    assert.deepEqual([late.state, late.status], ["failed", 200], "headers, then the cut: the status stays");
    assert.ok(late.failure && late.respondedAt != null && late.doneAt >= late.respondedAt, `late: ${JSON.stringify(late)}`);
  } finally {
    await pool.close();
  }
});

test("capture: an unfinished response is an answered row; stop() takes no new rows and still completes the one in flight", async () => {
  const pool = new BrowserPool({ target });
  try {
    const u = await pool.user();
    await u.goto("/");
    // In flight before the capture starts: never a row, even once it finishes.
    await atOnce(u.page, [["/suggestion", { op: "hold", n: 0 }]]);
    await u.poll(() => held.length === 1, { timeout: 10_000, what: "the first hold to reach the server" });
    const rows = u.capture({ paths: "/suggestion" });
    await atOnce(u.page, [["/suggestion", { op: "hold", n: 1 }]]);
    const open = await rows.waitFor({ op: "hold" }, { settled: false, timeout: 10_000 });
    await u.poll(() => open.state === "answered", { timeout: 10_000, what: "the hold to be answered" });
    assert.deepEqual([open.status, open.doneAt, open.settled, open.json], [200, null, false, null], "answered, not finished");
    await assert.rejects(rows.waitFor({ op: "hold" }, { timeout: 300 }), /no settled captured request within 300 ms: #0 matched but had not settled \(answered\) \(captured since 0: POST \/suggestion:hold 200\)/);
    assert.equal(rows.stop(), rows, "stop() returns the rows");
    await atOnce(u.page, [["/suggestion", { op: "accept", after: "stop" }]]);
    // Watch the row on every turn of the event loop while it finishes: it must never read settled before its body is in.
    const early = [];
    let watching = true;
    const watch = () => {
      if (open.settled && open.json === null) early.push(open.state);
      if (watching && !open.settled) setImmediate(watch);
    };
    setImmediate(watch);
    for (const res of held.splice(0)) res.end("1}");
    const done = await rows.waitFor({ op: "hold" }, { timeout: 10_000 }).finally(() => (watching = false));
    assert.deepEqual(early, [], "never settled before its response body was read");
    assert.equal(done, open, "the same row, completed in place");
    assert.deepEqual([done.state, done.json, done.settled], ["finished", { hold: 1 }, true], "the row in flight at stop() still completes");
    await sleep(500);
    assert.deepEqual(rows.map((r) => [r.op, r.postJson.n]), [["hold", 1]], "nothing sent after stop(), and nothing sent before the capture");
    assert.equal(rows.mark(), 1);
  } finally {
    await pool.close();
  }
});

test("capture: marks, predicates, method null, RegExp paths, max, non-JSON bodies, responseJson false", async () => {
  const pool = new BrowserPool({ target });
  try {
    const u = await pool.user();
    await u.goto("/");
    const all = u.capture({ paths: [/^\/sugg/, "/plain"], method: null });
    const trim = u.capture({ paths: "/suggestion", max: 2 });
    const noJson = u.capture({ paths: "/suggestion", responseJson: false });
    await inTurn(u.page, [["/suggestion", { op: "accept", n: 1 }]]);
    const m = all.mark();
    await inTurn(u.page, [["/suggestion", { op: "accept", n: 2 }], ["/suggestion", { op: "refuse" }]]);
    await u.page.evaluate(() => fetch("/suggestion").then((r) => r.text()));
    await atOnce(u.page, [["/plain", "op=claim"]], { raw: true });
    const second = await all.waitFor({ op: "accept" }, { since: m, timeout: 10_000 });
    assert.equal(second.postJson.n, 2, "since leaves out the earlier accept");
    const refused = await all.waitFor({ path: "/suggestion", op: ["refuse", "nope"], status: [409] }, { timeout: 10_000 });
    assert.deepEqual([refused.status, refused.json], [409, { op: "refuse", got: 15 }], "a refusal is a row like any other");
    const get = await all.waitFor({ method: "get" }, { timeout: 10_000 });
    assert.deepEqual([get.path, get.postJson, get.op, get.json], ["/suggestion", null, null, { get: true }], "method null takes a GET");
    const plain = await all.waitFor("/plain", { timeout: 10_000 });
    assert.deepEqual([plain.postJson, plain.op, plain.json, plain.status], [null, null, null, 200], "a body that is not JSON is null both ways");
    assert.equal((await all.waitFor((r) => r.path === "/plain" || r.postJson.nope.deeper, { timeout: 1_000 })).seq, plain.seq, "a predicate that throws is a non-match");
    assert.deepEqual([all.mark(), all.map((r) => r.seq)], [5, [0, 1, 2, 3, 4]], "five matched");
    await trim.waitFor({ op: "refuse" }, { timeout: 10_000 });
    assert.deepEqual([trim.mark(), trim.map((r) => [r.seq, r.op])], [3, [[1, "accept"], [2, "refuse"]]], "max keeps the last two; seq survives the trim");
    await noJson.waitFor({ op: "refuse" }, { timeout: 10_000 });
    assert.deepEqual(noJson.map((r) => [r.op, r.status, r.json, r.settled]), [["accept", 200, null, true], ["accept", 200, null, true], ["refuse", 409, null, true]], "responseJson false reads no body; POST only by default");
    await assert.rejects(all.waitFor({ op: "accept" }, { since: all.mark(), timeout: 200 }), /no settled captured request within 200 ms: none matched \(captured since 5: none\)/);
    assert.throws(() => all.waitFor(42), /capture predicate is a function, a path, a RegExp or \{method, path, op, status\}, got number/);
    assert.throws(() => all.waitFor({ op: "x" }, { since: -1 }), /capture waitFor since is a mark\(\) \(a seq\), got -1/);
    assert.throws(() => u.capture({ paths: "suggestion" }), /capture paths is a path \("\/…"\), a RegExp, a list of them, or null, got "suggestion"/);
    assert.throws(() => u.capture({ paths: [] }), /capture paths .* got \[\]/);
    assert.throws(() => u.capture({ paths: ["/a", 3] }), /capture paths .* got \["\/a", 3\]/);
    assert.throws(() => u.capture({ method: 5 }), /capture method is a method, a list of them, or null, got 5/);
    assert.throws(() => u.capture({ max: 0 }), /capture max is a positive integer, got 0/);
    for (const c of [all, trim, noJson]) c.stop();
  } finally {
    await pool.close();
  }
});

test("capture({method: null}) with no paths takes every request any page or frame of the context starts, each with its resource type", async () => {
  const pool = new BrowserPool({ target });
  try {
    const u = await pool.user();
    const every = u.capture({ method: null });
    await u.goto("/page");
    const framed = await every.waitFor({ path: "/other", op: "framed" }, { timeout: 10_000 });
    const second = await u.context.newPage();
    await second.goto(`${target.origin}/`);
    const show = (r) => `${r.method} ${r.path} ${r.type}`;
    const shown = every.map(show);
    for (const want of ["GET /page document", "GET /pixel.png image", "GET /inner document", "POST /other fetch"]) {
      assert.ok(shown.includes(want), `${want} is a row (rows: ${shown.join(" | ")})`);
    }
    assert.deepEqual([framed.type, framed.status], ["fetch", 200], "the frame's own fetch, answered");
    assert.equal(framed.request.frame().parentFrame(), u.page.mainFrame(), "sent from the child frame, not the page");
    const top = await every.waitFor((r) => r.path === "/" && r.request.frame().page() === second, { timeout: 10_000 });
    assert.deepEqual([top.method, top.type, top.status], ["GET", "document", 200], "a second page of the same context is captured too");
    every.stop();
  } finally {
    await pool.close();
  }
});
