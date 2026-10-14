// SPDX-License-Identifier: Apache-2.0
// Self-test: withVisibility opens a window for the length of a block and makes the document private again before the next line, pass or fail (SPEC §12, §17).

/**
 * A local server stands in for POST /visibility and records what it was
 * sent, so a window counts as closed only when the server was told
 * "private". Each answer can be set per document: a status, or "hang" (no
 * answer at all).
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";
import { OUT_DIR } from "../lib/paths.mjs";
import { createHttp } from "../lib/http.mjs";
import { closeWindows, openWindows, setVisibility, withVisibility, withWindowScope } from "../lib/grant.mjs";

const runId = `selftest-winblk-${process.pid}`;

/** What the fake server was sent: {owner, docId, visibility, body}. */
const seen = [];
/** docId → how to answer an open (unlisted/public): a status, or "hang". */
const openAnswer = new Map();
/** docId → how to answer a close (private): a status, or "hang". */
const closeAnswer = new Map();
let failNextClose = 0;
let server;
let target;
let runDir;

before(async () => {
  runDir = join(OUT_DIR, runId);
  mkdirSync(runDir, { recursive: true });
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      seen.push({ owner: req.headers["x-owner"] ?? null, docId: body.docId, visibility: body.visibility, body });
      const answer = (status, json) => {
        res.statusCode = status;
        if (json) res.setHeader("content-type", "application/json");
        res.end(json ? JSON.stringify(json) : undefined);
      };
      const rule = (body.visibility === "private" ? closeAnswer : openAnswer).get(body.docId);
      if (rule === "hang") return; // never answers
      if (typeof rule === "number" && rule !== 200) return answer(rule, rule >= 500 ? { error: "unavailable" } : null);
      if (body.visibility === "private" && failNextClose > 0) {
        failNextClose -= 1;
        return answer(503, { error: "unavailable" });
      }
      return answer(200, { visibility: body.visibility, publicEdit: body.publicEdit === true && body.visibility !== "private", linkToken: body.visibility === "unlisted" ? "k".repeat(22) : null, expiresAt: body.expiresAt ?? null });
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  target = Object.freeze({ kind: "local", runId, runDir, origin: `http://127.0.0.1:${port}`, projectId: "demo-bikeshed", capabilities: new Set(["local"]), stack: { ports: { hosting: port } } });
});

after(async () => {
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
  rmSync(runDir, { recursive: true, force: true });
});

const ownerSession = (name) => ({ account: { email: `${name}@example.com` }, http: createHttp(target, { actor: name, evidence: false, headers: { "x-owner": name } }) });
const sentFor = (docId) => seen.filter((s) => s.docId === docId).map((s) => s.visibility);
const docs = (scope) => openWindows({ scope }).map((w) => [w.docId, w.visibility]);

test("withVisibility: opens, hands fn the answer, returns fn's value, and the document is private before the next line", async () => {
  const scope = new Map();
  await withWindowScope(scope, async () => {
    const o = ownerSession("o1");
    const got = await withVisibility(target, { owner: o, doc: "blk-a", visibility: "unlisted" }, async (answer) => {
      assert.deepEqual([answer.status, answer.visibility, answer.linkToken], [200, "unlisted", "k".repeat(22)], "fn gets setVisibility's answer");
      assert.deepEqual(docs(scope), [["blk-a", "unlisted"]], "open while fn runs, in the running case's registry");
      assert.deepEqual(sentFor("blk-a"), ["unlisted"], "not closed while fn runs");
      return 42;
    });
    assert.equal(got, 42, "the block's value is fn's");
    assert.deepEqual(sentFor("blk-a"), ["unlisted", "private"], "made private as soon as fn returned");
    assert.ok(seen.filter((s) => s.docId === "blk-a").every((s) => s.owner === "o1"), "both as the owner");
    assert.deepEqual(docs(scope), [], "no window is left for the case's end");

    await withVisibility(target, { owner: o, doc: { docId: "blk-b" }, visibility: "public", publicEdit: true, expiresAt: null }, async () => {});
    assert.deepEqual(seen.find((s) => s.docId === "blk-b").body, { docId: "blk-b", visibility: "public", publicEdit: true, expiresAt: null }, "expiresAt and publicEdit reach the open");
    assert.deepEqual(sentFor("blk-b"), ["public", "private"]);
    await withVisibility(target, { owner: o, doc: "blk-b2", visibility: "public" }, async () => {});
    assert.deepEqual(seen.find((s) => s.docId === "blk-b2").body, { docId: "blk-b2", visibility: "public" }, "and only when given (S25)");
  });
});

test("withVisibility: when fn throws, the block throws fn's own error, and the document is private anyway", async () => {
  const scope = new Map();
  await withWindowScope(scope, async () => {
    const boom = new Error("boom");
    await assert.rejects(withVisibility(target, { owner: ownerSession("o1"), doc: "blk-c", visibility: "public" }, async () => {
      throw boom;
    }), (e) => e === boom);
    assert.deepEqual(sentFor("blk-c"), ["public", "private"]);
    assert.deepEqual(docs(scope), []);
  });
});

test("withVisibility: fn that makes the document private itself gets no second close", async () => {
  const scope = new Map();
  await withWindowScope(scope, async () => {
    const o = ownerSession("o1");
    await withVisibility(target, { owner: o, doc: "blk-d", visibility: "public" }, async () => {
      await setVisibility(target, { owner: o, doc: "blk-d", visibility: "private" });
    });
    assert.deepEqual(sentFor("blk-d"), ["public", "private"], "one private, fn's");
    assert.deepEqual(docs(scope), []);
  });
});

test("withVisibility: a close answered 404 counts as closed (the document is gone); a 503 is tried again", async () => {
  const scope = new Map();
  await withWindowScope(scope, async () => {
    const o = ownerSession("o1");
    closeAnswer.set("blk-gone", 404);
    await withVisibility(target, { owner: o, doc: "blk-gone", visibility: "public" }, async () => {});
    assert.deepEqual(sentFor("blk-gone"), ["public", "private"]);
    failNextClose = 1;
    await withVisibility(target, { owner: o, doc: "blk-flaky", visibility: "public" }, async () => {});
    assert.deepEqual(sentFor("blk-flaky"), ["public", "private", "private"], "a 503, then a 200");
    assert.deepEqual(docs(scope), []);
  });
  closeAnswer.delete("blk-gone");
});

test("NEGATIVE: a refused close throws E2E_WINDOW_OPEN after fn returned, gives way to fn's own error, and leaves the window for the case's end", async () => {
  const scope = new Map();
  const o = ownerSession("o1");
  closeAnswer.set("blk-locked", 401);
  closeAnswer.set("blk-locked2", 401);
  await withWindowScope(scope, async () => {
    await assert.rejects(withVisibility(target, { owner: o, doc: "blk-locked", visibility: "public" }, async () => "value"), (e) => {
      assert.equal(e.code, "E2E_WINDOW_OPEN");
      assert.match(e.message, /blk-locked \(public\) is not private again: POST \/visibility private answered 401/);
      assert.deepEqual(e.failed.map((f) => [f.docId, f.visibility, f.status]), [["blk-locked", "public", 401]]);
      return true;
    });
    assert.deepEqual(sentFor("blk-locked"), ["public", "private"], "a 401 is not tried again");
    const boom = new Error("boom");
    await assert.rejects(withVisibility(target, { owner: o, doc: "blk-locked2", visibility: "unlisted" }, async () => {
      throw boom;
    }), (e) => e === boom, "fn's error, not the close's");
    assert.deepEqual(docs(scope).sort(), [["blk-locked", "public"], ["blk-locked2", "unlisted"]], "both stay registered: the case's end tries again, and fails the case if it cannot");
  });
  closeAnswer.delete("blk-locked");
  closeAnswer.delete("blk-locked2");
  const out = await closeWindows({ scope });
  assert.deepEqual(out.closed.map((c) => c.docId).sort(), ["blk-locked", "blk-locked2"], "the case's end closes what the block could not");
});

test("NEGATIVE: a refused open runs no fn and sends no close; an open with no answer runs no fn and is closed", async () => {
  const scope = new Map();
  await withWindowScope(scope, async () => {
    const o = ownerSession("o1");
    let ran = 0;
    openAnswer.set("blk-refused", 403);
    await assert.rejects(withVisibility(target, { owner: o, doc: "blk-refused", visibility: "public" }, async () => (ran += 1)), (e) => e.code === "E2E_STATUS");
    assert.deepEqual(sentFor("blk-refused"), ["public"], "nothing opened, so nothing to close");
    openAnswer.set("blk-hang", "hang");
    await assert.rejects(withVisibility(target, { owner: o, doc: "blk-hang", visibility: "public", timeoutMs: 300 }, async () => (ran += 1)));
    assert.deepEqual(sentFor("blk-hang"), ["public", "private"], "no answer: it may be open, so it is made private");
    assert.equal(ran, 0, "fn never ran");
    assert.deepEqual(docs(scope), []);
  });
  openAnswer.delete("blk-refused");
  openAnswer.delete("blk-hang");
});

test("NEGATIVE: refused before anything is sent: private, an unknown level, no fn, no owner", async () => {
  const before = seen.length;
  const o = ownerSession("o1");
  await assert.rejects(withVisibility(target, { owner: o, doc: "blk-x", visibility: "private" }, async () => {}), /visibility is "unlisted" or "public"/);
  await assert.rejects(withVisibility(target, { owner: o, doc: "blk-x", visibility: "hidden" }, async () => {}), /visibility is "unlisted" or "public"/);
  await assert.rejects(withVisibility(target, { owner: o, doc: "blk-x", visibility: "public" }), /fn is the block/);
  await assert.rejects(withVisibility(target, { doc: "blk-x", visibility: "public" }, async () => {}), /owner's session/);
  await assert.rejects(withVisibility(target, { owner: o, visibility: "public" }, async () => {}), /document id is required/);
  assert.equal(seen.length, before, "no request");
});
