// SPDX-License-Identifier: Apache-2.0
// Self-test: syncHttp sends a binary body (POST /thumb's JPEGs, octet-stream) as its exact bytes from its worker threads, guarded or not, and traces it as a length and hash (SPEC §2, §12).

/**
 * The c17-identity request (c17-sync-http-binary) was filed against the
 * syncHttp that sent a Buffer as `{"0":255,"1":216,…}`: workerData's
 * structured clone delivers a Buffer as a plain Uint8Array, which httpOnce
 * then JSON-encoded. That was fixed on 2026-10-13 (bodyBytes); this pins it on
 * the shape C17c sends: concatenated JPEGs whose bytes are not UTF-8, as
 * application/octet-stream, compared by hash at the server (a UTF-8 decode
 * there would hide a mangled byte), plus a Uint8Array that is a window into a
 * larger buffer (byteOffset ≠ 0, which a clone keeps).
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";
import { syncHttp } from "../lib/sync.mjs";
import { jpegSkeleton } from "../lib/thumbs.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const sha = (b) => createHash("sha256").update(b).digest("hex");
let srv;
before(async () => {
  const arrivals = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const bytes = Buffer.concat(chunks);
      arrivals.push({ url: req.url, length: bytes.length, sha: sha(bytes), declared: Number(req.headers["content-length"]), type: req.headers["content-type"] });
      res.setHeader("content-type", "application/json");
      setTimeout(() => res.end(JSON.stringify({ length: bytes.length })), 100);
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  srv = { port, url: `http://127.0.0.1:${port}`, arrivals, close: () => new Promise((r) => server.close(r)) };
});
after(() => srv?.close());

const bodies = () => [0, 1, 2].map((i) => Buffer.concat([jpegSkeleton({ pad: 400 + 2 * i }), jpegSkeleton({ pad: 401 + 2 * i })]));

test("C17c's bodies (concatenated JPEGs, octet-stream) arrive byte for byte from syncHttp's workers, unguarded", async () => {
  const sent = bodies();
  assert.ok(sent.every((b) => b[0] === 0xff && b[1] === 0xd8), "they start with a JPEG's SOI, which is not UTF-8");
  assert.ok(sent.every((b) => !Buffer.from(b.toString("utf8"), "utf8").equals(b)), "a UTF-8 round trip would change them");
  const base = srv.arrivals.length;
  const run = await syncHttp(sent.map((body, i) => ({ url: `${srv.url}/thumb/${i}`, method: "POST", headers: { "content-type": "application/octet-stream" }, body })));
  assert.deepEqual(run.results.map((r) => r.status), [200, 200, 200]);
  const got = srv.arrivals.slice(base).sort((a, b) => a.url.localeCompare(b.url));
  assert.deepEqual(got.map((a) => [a.length, a.declared, a.sha]), sent.map((b) => [b.length, b.length, sha(b)]));
  assert.deepEqual(run.results.map((r) => JSON.parse(r.body).length), sent.map((b) => b.length));
});

test("guarded: the same bytes go, the guard sees them, and each row records the body as its length and hash, never its bytes", async () => {
  const sent = bodies();
  const asked = [];
  const guard = { check: async (q) => (asked.push(q), { allow: true, rule: "test" }) };
  const lines = [];
  const target = Object.freeze({ kind: "local", runId: "2610131300-bin1", origin: srv.url, runDir: tempDir("e2e-sync-binary-"), stack: { ports: { hosting: srv.port } } });
  const base = srv.arrivals.length;
  const run = await syncHttp(sent.map((body, i) => ({ url: `${srv.url}/thumb/g${i}`, method: "POST", headers: { "content-type": "application/octet-stream" }, body })), { target, guard, evidence: (l) => lines.push(l) });
  assert.equal(run.guarded, true);
  const got = srv.arrivals.slice(base).sort((a, b) => a.url.localeCompare(b.url));
  assert.deepEqual(got.map((a) => a.sha), sent.map(sha), "the server got the exact bytes");
  assert.deepEqual(asked.map((q) => sha(Buffer.from(q.body))), sent.map(sha), "the guard saw those bytes");
  const rows = lines.map((l) => JSON.parse(l)).sort((a, b) => a.url.localeCompare(b.url));
  assert.deepEqual(rows.map((r) => r.reqBody), sent.map((b) => `<${b.length} bytes sha256:${sha(b).slice(0, 16)}>`));
});

test("a Uint8Array window into a larger buffer (byteOffset ≠ 0) sends exactly its window", async () => {
  const whole = Buffer.concat([Buffer.from("HEAD-"), jpegSkeleton({ pad: 64 }), Buffer.from("-TAIL")]);
  const window = new Uint8Array(whole.buffer, whole.byteOffset + 5, whole.length - 10);
  assert.notEqual(window.byteOffset, 0);
  const want = Buffer.from(window);
  const base = srv.arrivals.length;
  await syncHttp([{ url: `${srv.url}/thumb/w`, method: "POST", headers: { "content-type": "application/octet-stream" }, body: window }]);
  const [a] = srv.arrivals.slice(base);
  assert.deepEqual([a.length, a.sha], [want.length, sha(want)]);
});
