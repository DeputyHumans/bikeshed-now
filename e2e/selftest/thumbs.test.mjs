// SPDX-License-Identifier: Apache-2.0
// Self-test: thumbs.mjs sends what the product's own POST /thumb parser accepts, with the revision of the tree the target runs (SPEC §2, §12).

/**
 * The oracle is the product, not this module: functions/src/lib/thumbs.ts is
 * loaded from this checkout with its types stripped, and its parseThumbUpload,
 * jpegSize and THUMB_REVISION judge what thumbs.mjs makes and sends. Each
 * acceptance is paired with a refusal from the same parser, so it is not a
 * parser that accepts everything.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as nodeModule from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { REPO_ROOT } from "../lib/paths.mjs";
import { createHttp } from "../lib/http.mjs";
import { appendLedger } from "../lib/ledger.mjs";
import { docIdFor } from "../lib/seed.mjs";
import { THUMB_JPEG, THUMB_SOURCE, jpegSkeleton, postThumb, thumbRevision } from "../lib/thumbs.mjs";
import { tempDir } from "./helpers/tmp.mjs";

/** The product's thumbs.ts from this checkout, types stripped, as a module. */
async function productThumbs() {
  const strip = nodeModule.stripTypeScriptTypes;
  if (typeof strip !== "function") throw new Error(`node ${process.version} has no module.stripTypeScriptTypes (22.13 or later), so the product's parser cannot be loaded`);
  const js = strip(readFileSync(join(REPO_ROOT, THUMB_SOURCE), "utf8"));
  return import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);
}

const product = await productThumbs();

/** A target whose stack tree holds exactly `files` ({rel: text}). */
function treeTarget(files, extra = {}) {
  const treeDir = tempDir("e2e-thumbs-tree-");
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(treeDir, rel)), { recursive: true });
    writeFileSync(join(treeDir, rel), text);
  }
  return { kind: "local", runId: "2610101200-thumb", stack: { treeDir }, ...extra };
}

/** A production-shaped target with a tree whose THUMB_REVISION is `rev`, and a ledger of its own. */
function prodTree(rev) {
  const t = treeTarget({ [THUMB_SOURCE]: `// planted\nexport const THUMB_REVISION = ${rev};\n` });
  return Object.freeze({ ...t, kind: "prod", origin: "https://thumbs-selftest.invalid", runDir: tempDir("e2e-thumbs-run-") });
}

/** A fake fetch that records each request and answers `status` with `json`. */
function recorder(status = 200, json = { stored: true }) {
  const sent = [];
  const fetch = async (url, init) => {
    sent.push({ url: new URL(url), method: init.method, headers: init.headers, body: Buffer.from(init.body ?? []) });
    return new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } });
  };
  return { sent, fetch };
}

test("THUMB_JPEG and jpegSkeleton: accepted by the product's parseThumbUpload, at the size their frame header says", () => {
  assert.equal(THUMB_JPEG.length, 17);
  assert.deepEqual(product.jpegSize(THUMB_JPEG), { width: 16, height: 16 });
  assert.deepEqual(product.parseThumbUpload(THUMB_JPEG, "cover", "17"), { images: [THUMB_JPEG] });
  assert.ok(jpegSkeleton().equals(THUMB_JPEG) && jpegSkeleton() !== THUMB_JPEG, "a fresh copy of the same bytes");
  for (const [width, height] of [[1, 1], [640, 360], [1280, 1280], [3, 1280]]) {
    const img = jpegSkeleton({ width, height });
    assert.deepEqual(product.jpegSize(img), { width, height });
    assert.ok("images" in product.parseThumbUpload(img, "cover", String(img.length)), `${width}x${height}`);
  }
  for (const pad of [1, 65533, 65534, 200_000]) {
    const img = jpegSkeleton({ pad });
    assert.equal(img.length, 17 + pad + 4 * Math.ceil(pad / 65533), `pad ${pad}: one 4-byte header per comment segment`);
    assert.deepEqual(product.jpegSize(img), { width: 16, height: 16 }, `pad ${pad}: the parser walks past every comment segment`);
  }
  // 160 KiB: 17 bytes of image, three comment-segment headers of 4, and the pad.
  const padded = jpegSkeleton({ pad: product.THUMB_MAX_IMAGE_BYTES - 29 });
  assert.equal(padded.length, product.THUMB_MAX_IMAGE_BYTES);
  assert.ok("images" in product.parseThumbUpload(padded, "cover", String(padded.length)), "exactly the byte limit is accepted");
  const three = [THUMB_JPEG, jpegSkeleton({ width: 2, height: 2, pad: 5 }), jpegSkeleton({ width: 1280, height: 720 })];
  const body = Buffer.concat(three);
  assert.deepEqual(product.parseThumbUpload(body, "slides", three.map((b) => b.length).join(",")), { images: three });
});

test("NEGATIVE: the same parser refuses what it should, so the acceptances above are real", () => {
  const refuse = (img, kind = "cover", sizes = String(img.length)) => product.parseThumbUpload(img, kind, sizes).error;
  assert.equal(refuse(jpegSkeleton({ width: 1281 })), "image too large");
  assert.equal(refuse(jpegSkeleton({ height: 1281 })), "image too large");
  const over = jpegSkeleton({ pad: product.THUMB_MAX_IMAGE_BYTES - 28 });
  assert.equal(over.length, product.THUMB_MAX_IMAGE_BYTES + 1);
  assert.equal(refuse(over), "image too large", "one byte over the limit");
  assert.equal(refuse(jpegSkeleton({ width: 0 })), "unreadable JPEG");
  assert.equal(refuse(THUMB_JPEG.subarray(0, 15)), "truncated JPEG");
  assert.equal(refuse(Buffer.concat([Buffer.from([0x00]), THUMB_JPEG.subarray(1)])), "not a JPEG");
  assert.equal(refuse(Buffer.concat([THUMB_JPEG, THUMB_JPEG]), "cover", "17,17"), "a cover is one image");
  assert.equal(refuse(THUMB_JPEG, "cover", "16"), "sizes do not match the body");
  assert.throws(() => jpegSkeleton({ width: 70000 }), /width must be an integer from 0 to 65535/);
  assert.throws(() => jpegSkeleton({ pad: -1 }), /pad must be an integer/);
});

test("thumbRevision: the stack tree's THUMB_REVISION as a number; this checkout's only for a target with no tree", () => {
  assert.equal(thumbRevision(treeTarget({ [THUMB_SOURCE]: "export const THUMB_REVISION = 41;\n" })), 41);
  assert.equal(thumbRevision({ kind: "prod", runId: "x" }), product.THUMB_REVISION, "no tree: the product source in this checkout");
  assert.equal(typeof thumbRevision({}), "number");
});

test("NEGATIVE: thumbRevision never falls back from a tree that lacks the source, and refuses a value that is not a revision", () => {
  assert.throws(() => thumbRevision(treeTarget({ "functions/src/lib/other.ts": "export const THUMB_REVISION = 3;\n" })), /is not in the stack's tree/);
  assert.throws(() => thumbRevision(treeTarget({ [THUMB_SOURCE]: 'export const THUMB_REVISION = "three";\n' })), /not a positive integer/);
  assert.throws(() => thumbRevision(treeTarget({ [THUMB_SOURCE]: "export const THUMB_REVISION = 0;\n" })), /not a positive integer/);
});

test("postThumb: POST /thumb with the tree's revision, a body the product's parser accepts, and the sizes it was framed by", async () => {
  const t = prodTree(41);
  const docId = docIdFor(t, "thumb");
  appendLedger(t, { kind: "doc", docId, via: "upload" });
  const rec = recorder();
  const http = createHttp(t, { actor: "owner", evidence: false, fetch: rec.fetch });

  const r = await postThumb(http, { docId, versionId: "v1" });
  assert.deepEqual([r.status, r.json], [200, { stored: true }], "the http.mjs response, as it came");
  const [cover] = rec.sent;
  assert.equal(cover.method, "POST");
  assert.equal(cover.url.pathname, "/thumb");
  assert.deepEqual(Object.fromEntries(cover.url.searchParams), { doc: docId, v: "v1", kind: "cover", sizes: "17", r: "41" });
  assert.equal(cover.headers["content-type"], "application/octet-stream");
  assert.ok(cover.body.equals(THUMB_JPEG));
  const q = cover.url.searchParams;
  assert.ok("images" in product.parseThumbUpload(cover.body, q.get("kind"), q.get("sizes")), "the product's parser accepts what was sent");

  const slides = [THUMB_JPEG, jpegSkeleton({ width: 4, height: 3, pad: 9 }), jpegSkeleton({ pad: 70_000 })];
  await postThumb(http, { docId, versionId: "v2", kind: "slides", images: slides });
  const sl = rec.sent[1];
  assert.equal(sl.url.searchParams.get("sizes"), slides.map((b) => b.length).join(","));
  assert.equal(sl.url.searchParams.get("v"), "v2");
  assert.deepEqual(product.parseThumbUpload(sl.body, "slides", sl.url.searchParams.get("sizes")), { images: slides }, "split back into the same images, in order");

  await postThumb(http, { docId, versionId: "v1", r: 2 });
  assert.equal(rec.sent[2].url.searchParams.get("r"), "2", "an explicit (older) revision");
  await postThumb(http, { docId, versionId: "v1", r: null });
  assert.equal(rec.sent[3].url.searchParams.has("r"), false, "r: null sends none");
  await postThumb(http, { docId, versionId: "v1", sizes: "16" });
  assert.equal(rec.sent[4].url.searchParams.get("sizes"), "16", "a framing the server must refuse, sent as given");
});

test("NEGATIVE: postThumb's expect throws on another status, it needs a doc and a version, and on production it names only the run's documents", async () => {
  const t = prodTree(41);
  const docId = docIdFor(t, "thumb");
  appendLedger(t, { kind: "doc", docId, via: "upload" });
  const rec = recorder(409, { error: "captured by an older version of the app" });
  const http = createHttp(t, { evidence: false, fetch: rec.fetch });
  await assert.rejects(postThumb(http, { docId, versionId: "v1", expect: 200 }), (e) => e.code === "E2E_STATUS" && e.response.status === 409);
  await assert.rejects(postThumb(http, { versionId: "v1" }), /give docId/);
  await assert.rejects(postThumb(http, { docId }), /give versionId/);
  await assert.rejects(postThumb(http, { docId, versionId: "v1", images: ["x"] }), /images\[0\] is not a Buffer/);
  const sent = rec.sent.length;
  await assert.rejects(postThumb(http, { docId: docIdFor(t, "not-mine"), versionId: "v1" }), (e) => e.code === "E2E_GUARD" && e.rule === "ledger");
  assert.equal(rec.sent.length, sent, "a refused upload never reaches fetch");
});
