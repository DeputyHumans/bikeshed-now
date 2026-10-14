// SPDX-License-Identifier: Apache-2.0
// Self-test: updateUpload sends a new version as POST /publish?update=, takes a request timeout as publish() does, and keeps the client's otherwise (SPEC §4, §12).

/**
 * Through http.mjs with a fake fetch standing in for the server, as
 * folder-grants.test.mjs does: one that answers, and one that never does
 * and waits for the request's own abort.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHttp } from "../lib/http.mjs";
import { readLedger } from "../lib/ledger.mjs";
import { publish, readFixture, updateUpload } from "../lib/seed.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const DOC = "e2e-0upd-doc-abcd";
const local = () => Object.freeze({ kind: "local", runId: "2610121300-upd", runDir: tempDir("e2e-upd-"), origin: "http://127.0.0.1:39323", stack: { ports: { hosting: 39323 } } });

function answering() {
  const sent = [];
  const fetch = async (url, init) => {
    const u = new URL(url);
    sent.push({ path: u.pathname, query: Object.fromEntries(u.searchParams), type: init.headers["content-type"], bytes: Buffer.from(init.body) });
    return new Response(JSON.stringify({ docId: DOC, versionId: "v2" }), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { sent, fetch };
}

function silent() {
  const sent = [];
  const fetch = (url, init) =>
    new Promise((_, reject) => {
      sent.push(new URL(url).pathname);
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    });
  return { sent, fetch };
}

/** What `p` rejects with, within `ms` (it must reject in time). */
async function rejection(p, ms = 5_000) {
  let timer;
  const late = new Promise((resolve) => (timer = setTimeout(() => resolve(new Error(`no rejection within ${ms} ms`)), ms)));
  try {
    const out = await Promise.race([p.then(() => new Error("resolved"), (err) => err), late]);
    return out;
  } finally {
    clearTimeout(timer);
  }
}

test("updateUpload: POST /publish?filename&update&baseVersion with the bytes; nothing is ledgered", async () => {
  const t = local();
  const s = answering();
  const http = createHttp(t, { actor: "owner", evidence: false, fetch: s.fetch });
  const r = await updateUpload(http, DOC, { fixture: "crdt-paragraphs.html", baseVersion: "v1", timeoutMs: 120_000 });
  assert.deepEqual([r.status, r.json], [200, { docId: DOC, versionId: "v2" }]);
  assert.equal(s.sent.length, 1);
  assert.equal(s.sent[0].path, "/publish");
  assert.deepEqual(s.sent[0].query, { filename: "index.html", update: DOC, baseVersion: "v1" }, "timeoutMs is the request's, never a query parameter");
  assert.equal(s.sent[0].type, "application/octet-stream");
  assert.ok(s.sent[0].bytes.equals(Buffer.from(readFixture("crdt-paragraphs.html", { raw: true }))), "the fixture's bytes, as they are");
  assert.deepEqual(readLedger(t), [], "a new version is not a creation");
});

test("NEGATIVE: updateUpload's timeoutMs bounds the request, as publish()'s does; without one the client's applies", async () => {
  const t = local();
  const s = silent();
  const http = createHttp(t, { actor: "owner", evidence: false, fetch: s.fetch, timeoutMs: 2_000 });
  const t0 = Date.now();
  const own = await rejection(updateUpload(http, DOC, { body: "<p>v2</p>", baseVersion: "v1", timeoutMs: 150 }));
  assert.equal(own.message, "timeout after 150 ms", "the request's own timeout, not the client's 2 s");
  assert.ok(Date.now() - t0 < 1_500, `it gave up at the request's timeout (${Date.now() - t0} ms)`);
  const pub = await rejection(publish(http, { body: "<p>v1</p>", name: "upd", timeoutMs: 150 }));
  assert.equal(pub.message, own.message, "the same as publish() with the same option");
  const quick = createHttp(t, { actor: "owner", evidence: false, fetch: s.fetch, timeoutMs: 200 });
  assert.equal((await rejection(updateUpload(quick, DOC, { body: "<p>v2</p>", baseVersion: "v1" }))).message, "timeout after 200 ms", "no timeoutMs: the client's, as before");
  assert.deepEqual(s.sent, ["/publish", "/publish", "/publish"]);
});
