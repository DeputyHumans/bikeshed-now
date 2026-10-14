// SPDX-License-Identifier: Apache-2.0
// Self-test: User.capture is the oracle for "this page sent nothing": an upload whose answer the page never reads is a row from its send, before any answer (SPEC §12).

/**
 * Hermetic: a local server stands in for the app's POST /thumb, which the page
 * sends as app/src/thumbs.ts uploadThumbs does: a Blob body, octet-stream, the
 * query naming the document, and `res.ok` only, so the page never reads the
 * answer's body. On a stack Playwright then emits neither `requestfinished`
 * nor `requestfailed` for it (measured on the shared stack, a16). Against a
 * plain local server Chrome does finish it (probed: `requestfinished` fired
 * for a whole answer sent at once and for one ended 200 ms after its
 * headers), so the server stands in for the stack by sending the headers and
 * part of a body and holding the rest. Before that it holds the request with
 * no answer at all: the moment an "X posted nothing" oracle must still see
 * the request. `log.requests` is written at the RESPONSE, so it has no row
 * for the upload then: an absence oracle read from it would pass while the
 * upload is in flight. Needs Chrome.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { BrowserPool } from "../lib/browser.mjs";

/** Each POST /thumb the server holds: {query, type, bytes, res, phase: "held"|"headers"|"done"}. */
const uploads = [];
let server;
let target;
before(async () => {
  server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      if (req.method === "POST" && req.url.startsWith("/thumb?")) {
        uploads.push({ query: new URL(req.url, "http://x").searchParams, type: req.headers["content-type"], bytes: Buffer.concat(chunks).length, res, phase: "held" });
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<!doctype html><title>app</title><p>app</p>");
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  target = { kind: "local", runId: "selftest-capture-upload", origin: `http://127.0.0.1:${port}`, stack: { ports: { hosting: port } }, capabilities: new Set(["local"]) };
});
after(async () => {
  for (const u of uploads) u.res.destroy();
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
});

/** Send the headers and part of a body, and keep the rest: an answer that never finishes. */
const answer = (u) => {
  u.res.writeHead(200, { "content-type": "application/json" });
  u.res.write('{"ok": ');
  u.phase = "headers";
};

/** In the page, as uploadThumbs sends it: resolves once sent; `window.__e2eUp[i]` is its `res.ok`. */
const upload = (page, { doc, kind, sizes }) =>
  page.evaluate(({ doc, kind, sizes }) => {
    const query = new URLSearchParams({ doc, v: "v1", kind, sizes: sizes.join(","), r: "3" });
    const body = new Blob(sizes.map((n) => new Uint8Array(n).fill(0xff)));
    window.__e2eUp ??= [];
    window.__e2eUp.push(
      fetch(`/thumb?${query}`, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body, credentials: "same-origin" })
        .then((res) => res.ok)
        .catch(() => false),
    );
  }, { doc, kind, sizes });

const thumbRows = (u) => u.log.requests.filter((r) => new URL(r.url).pathname === "/thumb");

test("capture: an upload is a row from its send, with no answer yet, where log.requests has none; then answered and never settled", async () => {
  const pool = new BrowserPool({ target });
  try {
    const u = await pool.user({ name: "editor" });
    await u.goto("/");
    const posts = u.capture({ paths: "/thumb" });
    await upload(u.page, { doc: "d-deck", kind: "cover", sizes: [3000] });
    await u.poll(() => uploads.length === 1, { timeout: 10_000, what: "the upload to reach the server" });

    // In flight: the server has it and has answered nothing.
    assert.equal(uploads[0].phase, "held");
    assert.deepEqual(
      posts.map(({ seq, method, path, op, postJson, status, respondedAt, doneAt, state, settled }) => ({ seq, method, path, op, postJson, status, respondedAt, doneAt, state, settled })),
      [{ seq: 0, method: "POST", path: "/thumb", op: null, postJson: null, status: null, respondedAt: null, doneAt: null, state: "sent", settled: false }],
      "the upload is a row as it is sent, before any answer; a binary body is postJson null",
    );
    const q = new URL(posts[0].url).searchParams;
    assert.deepEqual([q.get("doc"), q.get("kind"), q.get("sizes")], ["d-deck", "cover", "3000"], "the row's url carries the upload's query");
    assert.deepEqual([uploads[0].type, uploads[0].bytes], ["application/octet-stream", 3000], "the server got the Blob as sent");
    assert.deepEqual(thumbRows(u), [], "log.requests has no row for it yet: an absence oracle over log.requests passes here, blind");
    await assert.rejects(posts.waitFor({ path: "/thumb", status: 200 }, { settled: false, timeout: 300 }), /none matched \(captured since 0: POST \/thumb sent\)/, "a status predicate does not match a row with no answer");

    // Answered, with a body the page never reads and the server never finishes.
    answer(uploads[0]);
    const row = await posts.waitFor({ path: "/thumb", status: 200 }, { settled: false, timeout: 10_000 });
    assert.equal(row, posts[0], "the same row, completed in place");
    assert.equal(await u.page.evaluate(() => window.__e2eUp[0]), true, "the page took res.ok and read nothing more");
    assert.deepEqual([row.state, row.status, row.settled, row.doneAt, row.json], ["answered", 200, false, null, null], "answered, never finished: as POST /thumb stays on a stack");
    assert.ok(row.sentAt <= row.respondedAt, "sent before answered");
    await assert.rejects(posts.waitFor({ path: "/thumb" }, { timeout: 300 }), /#0 matched but had not settled \(answered\)/, "the default waitFor wants a settled row, which this never is");
    await u.poll(() => thumbRows(u).length === 1, { timeout: 10_000, what: "log.requests to get its row at the response" });
    assert.deepEqual(thumbRows(u).map((r) => [r.method, r.status, r.finished]), [["POST", 200, false]], "log.requests has it only from its answer, unfinished");

    // stop(): no new rows; the one in flight still completes.
    posts.stop();
    await upload(u.page, { doc: "d-deck", kind: "slides", sizes: [10, 20] });
    await u.poll(() => uploads.length === 2, { timeout: 10_000, what: "the second upload to reach the server" });
    answer(uploads[1]);
    for (const up of uploads) {
      up.res.end("true}");
      up.phase = "done";
    }
    await u.poll(() => posts[0].settled, { timeout: 10_000, what: "the first row to settle once its body ends" });
    assert.deepEqual([posts.length, posts.mark(), posts[0].state, posts[0].json], [1, 1, "finished", { ok: true }], "nothing after stop() is a row; the row in flight finished");
  } finally {
    await pool.close();
  }
});

test("capture: a page that sends nothing has no rows, next to one that sends; rows from both pages of one user count", async () => {
  const pool = new BrowserPool({ target });
  try {
    const [editor, viewer] = await pool.many(2, { names: ["editor", "viewer"] });
    await Promise.all([editor.goto("/"), viewer.goto("/")]);
    const eRows = editor.capture({ paths: "/thumb" });
    const vRows = viewer.capture({ paths: "/thumb" });
    const before = uploads.length;
    await upload(editor.page, { doc: "d-two", kind: "cover", sizes: [5] });
    const second = await editor.context.newPage();
    await second.goto(editor.url("/"));
    await upload(second, { doc: "d-two", kind: "slides", sizes: [6, 7] });
    await editor.poll(() => uploads.length === before + 2, { timeout: 10_000, what: "both uploads to reach the server" });
    assert.deepEqual(eRows.map((r) => [new URL(r.url).searchParams.get("kind"), r.state]), [["cover", "sent"], ["slides", "sent"]], "every page of the editor's context, in send order, before any answer");
    assert.deepEqual(vRows, [], "the viewer, who sent nothing, has no rows: the same watch that sees the editor's");
    for (const up of uploads.slice(before)) {
      answer(up);
      up.res.end("true}");
      up.phase = "done";
    }
    await eRows.waitFor((r) => r.seq === 1, { timeout: 10_000 });
    for (const c of [eRows, vRows]) c.stop();
  } finally {
    await pool.close();
  }
});
