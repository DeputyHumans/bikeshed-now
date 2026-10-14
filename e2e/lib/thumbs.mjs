// SPDX-License-Identifier: Apache-2.0
// Storing a version's thumbnails through POST /thumb without a browser, and the small images a spec sends: a JPEG the server accepts, a real PNG, the tree's capture revision (SPEC §2).

/**
 * POST /thumb?doc=&v=&kind=cover|slides&sizes=<n>,…&r=<revision> takes the
 * JPEGs back to back, in slot order. The server checks each one only by its
 * own markers (functions/src/lib/thumbs.ts, parseThumbUpload): a start of
 * image, a frame header it can walk to whose size is 1 to 1280 pixels a side,
 * an end of image, at most 160 KiB. Nothing in a spec decodes what it stores,
 * so the smallest bytes that pass are enough:
 *
 *   jpegSkeleton({width = 16, height = 16, pad = 0})
 *       SOI, `pad` bytes of comment segments (to make an image of a chosen
 *       length, e.g. one over the byte limit), a baseline SOF0 frame header of
 *       width×height with one component, EOI. 17 bytes with no pad.
 *   THUMB_JPEG
 *       jpegSkeleton() — 16×16, 17 bytes. Shared by every caller in the
 *       process: never write into it; take jpegSkeleton() for a copy.
 *
 * `r` must be the capture revision of the tree the stack runs, or every call
 * is a 409 "captured by an older version of the app". thumbRevision(target)
 * reads THUMB_REVISION from that tree with treeConstant (this checkout only
 * for a target with no tree).
 *
 *   postThumb(http, {docId, versionId, kind = "cover", images, sizes, r, query, expect, timeoutMs})
 *       → the http.mjs response ({status, json, headers, …}); json is
 *       {stored: true} when this upload became the record, {stored: false}
 *       when the kind was already stored for that version and revision.
 *       `images` defaults to one fresh jpegSkeleton(); `sizes` to their byte
 *       lengths; `r` to thumbRevision(http.target), and `r: null` sends none.
 *
 *   storeThumb(http, {docId, versionId, kind = "cover", images, sizes, r, query, timeoutMs, readDoc})
 *       → {stored, key, path, paths, record, response}: postThumb, which
 *       must answer 200, then the record the upload left in
 *       docs/<docId>.thumb (read through lib/admin.mjs; `readDoc` is a test
 *       stand-in) and the GET /thumb path of every image it names. `stored`
 *       is the answer's: false when the kind was already stored for that
 *       version, and then the paths are those of the images already there.
 *   thumbPath(docId, versionId, key, slot = "cover", {k})
 *       /thumb/[~<k>/]<docId>/<versionId>/<key>/<cover|s<n>>.jpg, the one
 *       path a thumbnail is served at; `slot` may be a number n for s<n>.
 *
 * Editors only, and on an expired document its owner only; `versionId` must be
 * the document's current version (SPEC §2). On production the guard lets it
 * name only a document the run created, like any other write.
 *
 * A REAL PNG, for a bundle's image or an og:image: nothing on the server
 * decodes one, but a browser does, and a link asset that does not decode is
 * a broken image whatever its status said.
 *
 *   tinyPng({width = 2, height = 2, rgb = [200, 30, 30]})
 *       → Buffer: signature, IHDR (8-bit RGB), one zlib IDAT of unfiltered
 *       rows in one colour, IEND, every chunk with its CRC. Built at run
 *       time, so no binary is committed.
 */

import { deflateSync } from "node:zlib";
import { treeConstant } from "./target.mjs";

/** The product source that owns the upload's rules and THUMB_REVISION, relative to the tree. */
export const THUMB_SOURCE = "functions/src/lib/thumbs.ts";

const COM_MAX = 0xffff - 2;

function u16(n, what) {
  if (!Number.isInteger(n) || n < 0 || n > 0xffff) throw new Error(`jpegSkeleton: ${what} must be an integer from 0 to 65535, got ${JSON.stringify(n)}`);
  return [n >> 8, n & 0xff];
}

/**
 * The smallest JPEG POST /thumb accepts as width×height: SOI, optional
 * comment segments carrying `pad` zero bytes, SOF0 (8-bit, one component),
 * EOI. A width or height of 0 is allowed, so a spec can send one the server
 * must refuse ("unreadable JPEG"), as is a side over 1280 ("image too large").
 */
export function jpegSkeleton({ width = 16, height = 16, pad = 0 } = {}) {
  const [h1, h0] = u16(height, "height");
  const [w1, w0] = u16(width, "width");
  if (!Number.isInteger(pad) || pad < 0 || pad > 16 * 1024 * 1024) throw new Error(`jpegSkeleton: pad must be an integer from 0 to 16 MiB, got ${JSON.stringify(pad)}`);
  const parts = [Buffer.from([0xff, 0xd8])];
  for (let left = pad; left > 0; ) {
    // A segment's length field counts its own two bytes, so a COM segment
    // carries at most 65533 bytes; a larger pad takes several.
    const n = Math.min(left, COM_MAX);
    parts.push(Buffer.from([0xff, 0xfe, (n + 2) >> 8, (n + 2) & 0xff]), Buffer.alloc(n));
    left -= n;
  }
  parts.push(Buffer.from([0xff, 0xc0, 0x00, 0x0b, 0x08, h1, h0, w1, w0, 0x01, 0x01, 0x11, 0x00, 0xff, 0xd9]));
  return Buffer.concat(parts);
}

/** jpegSkeleton(): a 16×16 JPEG of 17 bytes. Do not write into it. */
export const THUMB_JPEG = jpegSkeleton();

/** The capture revision POST /thumb accepts: THUMB_REVISION from the tree the target runs, as a number. */
export function thumbRevision(target) {
  const raw = treeConstant(target, THUMB_SOURCE, "THUMB_REVISION");
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error(`thumbRevision: THUMB_REVISION in ${THUMB_SOURCE} is not a positive integer: ${raw}`);
  return n;
}

/**
 * POST /thumb as the client's actor (a session or a token client).
 *
 * @param {object} http              from session.http or bearerHttp()
 * @param {object} o
 * @param {string} o.docId
 * @param {string} o.versionId       the document's current version, e.g. "v1"
 * @param {"cover"|"slides"|string} [o.kind]  default "cover"
 * @param {Buffer[]} [o.images]      default [jpegSkeleton()]; sent back to back
 * @param {string} [o.sizes]         default the images' byte lengths, comma-joined
 * @param {number|string|null} [o.r] default thumbRevision(http.target); null sends no r
 * @param {object} [o.query]         extra or overriding query parameters
 * @param {number|number[]} [o.expect]
 * @param {number} [o.timeoutMs]
 * @returns {Promise<object>} the http.mjs response
 */
export async function postThumb(http, o = {}) {
  if (typeof o.docId !== "string" || !o.docId) throw new Error("postThumb: give docId");
  if (typeof o.versionId !== "string" || !o.versionId) throw new Error("postThumb: give versionId, the document's current version (e.g. v1)");
  const images = (o.images ?? [jpegSkeleton()]).map((b, i) => {
    if (!(b instanceof Uint8Array)) throw new Error(`postThumb: images[${i}] is not a Buffer`);
    return Buffer.from(b);
  });
  const sizes = o.sizes ?? images.map((b) => b.length).join(",");
  const r = o.r === undefined ? thumbRevision(http.target) : o.r;
  return http.request("POST", "/thumb", {
    query: { doc: o.docId, v: o.versionId, kind: o.kind ?? "cover", sizes, r, ...(o.query ?? {}) },
    headers: { "content-type": "application/octet-stream" },
    body: Buffer.concat(images),
    expect: o.expect,
    timeoutMs: o.timeoutMs,
  });
}

/** The served thumbnail names (functions/src/lib/thumbs.ts THUMB_REL): a 16-hex key, then cover or s<n>. */
const THUMB_KEY_RE = /^[0-9a-f]{16}$/;
const THUMB_SLOT_RE = /^(cover|s(0|[1-9]\d{0,2}))$/;

/** The GET path of one stored thumbnail: /thumb/[~<k>/]<docId>/<versionId>/<key>/<slot>.jpg. */
export function thumbPath(docId, versionId, key, slot = "cover", { k = null } = {}) {
  if (typeof docId !== "string" || !docId) throw new Error("thumbPath: give docId");
  if (typeof versionId !== "string" || !versionId) throw new Error("thumbPath: give versionId");
  if (typeof key !== "string" || !THUMB_KEY_RE.test(key)) throw new Error(`thumbPath: a key is 16 hex characters, got ${JSON.stringify(key)}`);
  const name = typeof slot === "number" ? `s${slot}` : String(slot);
  if (!THUMB_SLOT_RE.test(name)) throw new Error(`thumbPath: a slot is "cover", "s<n>" or a number n, got ${JSON.stringify(slot)}`);
  return `/thumb/${k ? `~${encodeURIComponent(k)}/` : ""}${encodeURIComponent(docId)}/${encodeURIComponent(versionId)}/${key}/${name}.jpg`;
}

/**
 * POST /thumb (which must answer 200), then the stored record and the path of
 * every image it names. See the header.
 *
 * @returns {Promise<{stored: boolean, key: string, path: string, paths: string[], record: object, response: object}>}
 */
export async function storeThumb(http, o = {}) {
  const kind = o.kind ?? "cover";
  if (kind !== "cover" && kind !== "slides") throw new Error(`storeThumb: kind is "cover" or "slides", not ${JSON.stringify(kind)} (postThumb sends any kind)`);
  const response = await postThumb(http, { ...o, kind, expect: 200 });
  const stored = response.json?.stored;
  if (typeof stored !== "boolean") throw new Error(`storeThumb: POST /thumb answered 200 without {stored}: ${String(response.text ?? "").slice(0, 200)}`);
  const read = o.readDoc ?? (async (path) => (await import("./admin.mjs")).readDoc(http.target, path));
  const record = (await read(`docs/${o.docId}`))?.thumb ?? null;
  if (!record || record.versionId !== o.versionId) {
    throw new Error(`storeThumb: docs/${o.docId}.thumb names ${record ? `version ${record.versionId}` : "nothing"}, not ${o.versionId}`);
  }
  const key = kind === "cover" ? record.cover : record.slides?.key;
  if (typeof key !== "string") throw new Error(`storeThumb: docs/${o.docId}.thumb has no ${kind} key: ${JSON.stringify(record)}`);
  const slots = kind === "cover" ? ["cover"] : Array.from({ length: Number(record.slides?.count) || 0 }, (_, i) => `s${i}`);
  const paths = slots.map((slot) => thumbPath(o.docId, o.versionId, key, slot));
  return { stored, key, path: paths[0] ?? null, paths, record, response };
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** A real width×height RGB PNG in one colour (see the header). */
export function tinyPng({ width = 2, height = 2, rgb = [200, 30, 30] } = {}) {
  for (const [n, what] of [[width, "width"], [height, "height"]]) {
    if (!Number.isInteger(n) || n < 1 || n > 4096) throw new Error(`tinyPng: ${what} must be an integer from 1 to 4096, got ${JSON.stringify(n)}`);
  }
  if (!Array.isArray(rgb) || rgb.length !== 3 || !rgb.every((x) => Number.isInteger(x) && x >= 0 && x <= 255)) {
    throw new Error(`tinyPng: rgb is three integers from 0 to 255, got ${JSON.stringify(rgb)}`);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB; compression, filter and interlace methods stay 0
  const row = Buffer.alloc(1 + width * 3); // filter byte 0 (None), then the pixels
  for (let x = 0; x < width; x += 1) row.set(rgb, 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk("IHDR", ihdr), pngChunk("IDAT", deflateSync(raw)), pngChunk("IEND", Buffer.alloc(0))]);
}
