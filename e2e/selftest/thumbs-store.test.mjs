// SPDX-License-Identifier: Apache-2.0
// Self-test: storeThumb returns the paths the product serves for the record an upload left, thumbPath builds them, and tinyPng is a PNG a decoder accepts (SPEC §2, §12).

/**
 * The oracle for a path is the product: functions/src/lib/thumbs.ts from this
 * checkout, types stripped, whose THUMB_REL and servableThumb decide what GET
 * /thumb serves. The oracle for a PNG is node:zlib's own crc32 and inflate,
 * not the CRC table thumbs.mjs carries.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as nodeModule from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { crc32, inflateSync } from "node:zlib";
import { REPO_ROOT } from "../lib/paths.mjs";
import { createHttp } from "../lib/http.mjs";
import { THUMB_SOURCE, storeThumb, thumbPath, tinyPng } from "../lib/thumbs.mjs";
import { tempDir } from "./helpers/tmp.mjs";

async function productThumbs() {
  const strip = nodeModule.stripTypeScriptTypes;
  if (typeof strip !== "function") throw new Error(`node ${process.version} has no module.stripTypeScriptTypes (22.13 or later)`);
  const js = strip(readFileSync(join(REPO_ROOT, THUMB_SOURCE), "utf8"));
  return import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);
}
const product = await productThumbs();

const LOCAL = Object.freeze({ kind: "local", runId: "2610102300-thst", runDir: tempDir("e2e-thst-"), origin: "http://127.0.0.1:39021", stack: { ports: { hosting: 39021 } } });
const KEY = "0123456789abcdef";
const KEY2 = "fedcba9876543210";

function recorder(status = 200, json = { stored: true }) {
  const sent = [];
  const fetch = async (url, init) => {
    sent.push({ url: new URL(url), method: init.method });
    return new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } });
  };
  return { sent, fetch };
}

/** What GET /thumb would serve for `path` under `record`, by the product's own rule. */
function serves(record, docId, versionId, path) {
  const prefix = `/thumb/${encodeURIComponent(docId)}/${encodeURIComponent(versionId)}/`;
  assert.ok(path.startsWith(prefix), `${path} starts with ${prefix}`);
  const rel = path.slice(prefix.length);
  return product.THUMB_REL.test(rel) && product.servableThumb(product.readThumb(record), versionId, rel);
}

test("thumbPath: the one path a thumbnail is served at, by the product's THUMB_REL; ~k for a link holder", () => {
  const p = thumbPath("d 1", "v2", KEY);
  assert.equal(p, `/thumb/d%201/v2/${KEY}/cover.jpg`);
  assert.equal(serves({ versionId: "v2", cover: KEY }, "d 1", "v2", p), true);
  assert.equal(serves({ versionId: "v2", cover: KEY2 }, "d 1", "v2", p), false, "NEGATIVE: another key is not served");
  assert.equal(thumbPath("d1", "v1", KEY, 3), `/thumb/d1/v1/${KEY}/s3.jpg`);
  assert.equal(thumbPath("d1", "v1", KEY, "s0", { k: "a/b" }), `/thumb/~a%2Fb/d1/v1/${KEY}/s0.jpg`);
  assert.throws(() => thumbPath("d1", "v1", "nothex"), /16 hex/);
  assert.throws(() => thumbPath("d1", "v1", KEY, "s01"), /slot/, "no leading zero, as the product's names have none");
  assert.throws(() => thumbPath("d1", "v1", KEY, "s1000"), /slot/);
  assert.throws(() => thumbPath("d1", "v1", { cover: KEY }), /16 hex/);
});

test("storeThumb: POST /thumb, then the record's key and the path of every image it names, each one the product serves", async () => {
  const rec = recorder(200, { stored: true });
  const http = createHttp(LOCAL, { evidence: false, fetch: rec.fetch });
  const reads = [];
  const cover = await storeThumb(http, { docId: "d1", versionId: "v1", r: 3, readDoc: async (path) => (reads.push(path), { thumb: { versionId: "v1", rev: 3, cover: KEY } }) });
  assert.deepEqual(reads, ["docs/d1"]);
  assert.deepEqual([cover.stored, cover.key, cover.path, cover.paths], [true, KEY, `/thumb/d1/v1/${KEY}/cover.jpg`, [`/thumb/d1/v1/${KEY}/cover.jpg`]]);
  assert.equal(serves(cover.record, "d1", "v1", cover.path), true);
  assert.deepEqual([rec.sent[0].method, rec.sent[0].url.pathname, rec.sent[0].url.searchParams.get("kind"), rec.sent[0].url.searchParams.get("r")], ["POST", "/thumb", "cover", "3"]);

  const slidesRecord = { versionId: "v4", rev: 3, cover: KEY, slides: { key: KEY2, count: 3 } };
  const slides = await storeThumb(http, { docId: "deck", versionId: "v4", kind: "slides", r: 3, readDoc: async () => ({ thumb: slidesRecord }) });
  assert.deepEqual(slides.paths, [0, 1, 2].map((i) => `/thumb/deck/v4/${KEY2}/s${i}.jpg`));
  assert.ok(slides.paths.every((p) => serves(slidesRecord, "deck", "v4", p)), "every slide path is served");
  assert.equal(serves(slidesRecord, "deck", "v4", `/thumb/deck/v4/${KEY2}/s3.jpg`), false, "NEGATIVE: one past the count is not");
  assert.equal(rec.sent[1].url.searchParams.get("kind"), "slides");

  const again = await storeThumb(createHttp(LOCAL, { evidence: false, fetch: recorder(200, { stored: false }).fetch }), { docId: "d1", versionId: "v1", r: 3, readDoc: async () => ({ thumb: { versionId: "v1", cover: KEY } }) });
  assert.deepEqual([again.stored, again.key], [false, KEY], "already stored: the paths of the images already there");
});

test("NEGATIVE: storeThumb throws on any other status, an answer without {stored}, a record of another version or with no key, and an unknown kind", async () => {
  const thumb = { versionId: "v1", cover: KEY };
  const read = async () => ({ thumb });
  const http = (status, json) => createHttp(LOCAL, { evidence: false, fetch: recorder(status, json).fetch });
  await assert.rejects(storeThumb(http(409, { error: "captured by an older version of the app" }), { docId: "d1", versionId: "v1", r: 2, readDoc: read }), (e) => e.code === "E2E_STATUS");
  await assert.rejects(storeThumb(http(403, {}), { docId: "d1", versionId: "v1", r: 3, readDoc: read, expect: 403 }), (e) => e.code === "E2E_STATUS", "storeThumb always wants 200, whatever expect says");
  await assert.rejects(storeThumb(http(200, {}), { docId: "d1", versionId: "v1", r: 3, readDoc: read }), /without \{stored\}/);
  await assert.rejects(storeThumb(http(200, { stored: true }), { docId: "d1", versionId: "v2", r: 3, readDoc: read }), /names version v1, not v2/);
  await assert.rejects(storeThumb(http(200, { stored: true }), { docId: "d1", versionId: "v1", r: 3, readDoc: async () => ({}) }), /names nothing/);
  await assert.rejects(storeThumb(http(200, { stored: true }), { docId: "d1", versionId: "v1", kind: "slides", r: 3, readDoc: read }), /no slides key/);
  const none = recorder();
  await assert.rejects(storeThumb(createHttp(LOCAL, { evidence: false, fetch: none.fetch }), { docId: "d1", versionId: "v1", kind: "poster", r: 3, readDoc: read }), /kind is "cover" or "slides"/);
  assert.equal(none.sent.length, 0, "an unknown kind is refused before anything is sent");
});

/** The PNG's chunks, checked against node:zlib's crc32: [{type, data}]. */
function chunks(png) {
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "the PNG signature");
  const out = [];
  for (let i = 8; i < png.length; ) {
    const len = png.readUInt32BE(i);
    const type = png.subarray(i + 4, i + 8).toString("ascii");
    const data = png.subarray(i + 8, i + 8 + len);
    assert.equal(png.readUInt32BE(i + 8 + len), crc32(png.subarray(i + 4, i + 8 + len)), `${type}'s CRC`);
    out.push({ type, data });
    i += 12 + len;
  }
  return out;
}

test("tinyPng: signature, IHDR, IDAT and IEND with valid CRCs; the IDAT inflates to width×height pixels of the colour", () => {
  for (const [o, w, h, rgb] of [[{}, 2, 2, [200, 30, 30]], [{ width: 5, height: 3, rgb: [1, 2, 3] }, 5, 3, [1, 2, 3]]]) {
    const png = tinyPng(o);
    const cs = chunks(png);
    assert.deepEqual(cs.map((c) => c.type), ["IHDR", "IDAT", "IEND"]);
    const ihdr = cs[0].data;
    assert.deepEqual([ihdr.readUInt32BE(0), ihdr.readUInt32BE(4), ihdr[8], ihdr[9], ihdr[10], ihdr[11], ihdr[12]], [w, h, 8, 2, 0, 0, 0], "8-bit RGB, no interlace");
    const raw = inflateSync(cs[1].data);
    assert.equal(raw.length, h * (1 + w * 3));
    for (let y = 0; y < h; y += 1) {
      const row = raw.subarray(y * (1 + w * 3), (y + 1) * (1 + w * 3));
      assert.equal(row[0], 0, "filter None");
      for (let x = 0; x < w; x += 1) assert.deepEqual([...row.subarray(1 + x * 3, 4 + x * 3)], rgb);
    }
    assert.equal(cs[2].data.length, 0);
  }
  assert.notDeepEqual(tinyPng(), tinyPng({ rgb: [0, 0, 0] }), "the colour is in the bytes");
  assert.throws(() => tinyPng({ width: 0 }), /width/);
  assert.throws(() => tinyPng({ height: 1.5 }), /height/);
  assert.throws(() => tinyPng({ rgb: [256, 0, 0] }), /rgb/);
});
