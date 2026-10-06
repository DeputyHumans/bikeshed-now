// SPDX-License-Identifier: Apache-2.0
// A version's stored thumbnails: what an upload may contain, and what may be served (SPEC §2, §4).

/**
 * A thumbnail is captured in an editor's browser, because nothing here renders
 * a document server-side, and stored so every member sees it without anybody
 * rendering it again. That makes the upload the one place a client hands this
 * system an IMAGE, and the image is later decoded by the workspace page itself,
 * outside any sandbox — so what is accepted is narrow on purpose: baseline
 * JPEG only, checked by its own markers, of bounded bytes and bounded pixels.
 *
 * Everything in this module is pure. The endpoint owns Storage and Firestore;
 * this owns the decisions, so each one can be tested without either.
 */

/** A deck larger than this keeps live previews; its rail is not stored. */
export const THUMB_MAX_SLIDES = 100;

/** Per image. A 640×360 JPEG at the capture quality is a fraction of this. */
export const THUMB_MAX_IMAGE_BYTES = 160 * 1024;

/** Per side, in pixels. Twice the capture size, so a larger stage still fits. */
export const THUMB_MAX_SIDE = 1280;

/**
 * How long a member's browser may keep a thumbnail without asking again.
 *
 * Its URL names a server-minted key, so the bytes at a URL never change and
 * `immutable` is honest. What this bounds is revocation: someone removed from a
 * document keeps, for at most this long, the images their browser already
 * held. It is capped at the time left before expiry like every other window.
 */
export const THUMB_CACHE_SECONDS = 86_400;

/**
 * Which capture made a stored image. Raised whenever capture changes what an
 * image of the same bytes looks like, so an image the old capture got wrong is
 * replaced the next time an editor opens its document — each kind is
 * otherwise written once per version, and a bad one would last until the next.
 *
 *   1  the first capture (a record with no `rev`)
 *   2  shapes inside an svg keep the paint their stylesheet gives them
 *
 * The app holds the same number (`app/src/thumbs.ts`), pinned by a test.
 */
export const THUMB_REVISION = 2;

export type ThumbKind = "cover" | "slides";

/** `docs/{docId}.thumb`: which version's images exist, and under which keys. */
export interface DocThumb {
  versionId: string;
  /** The capture revision that made these images; absent on the first. */
  rev?: number;
  /** Key of the grid's cover image, `cover.jpg`. */
  cover?: string;
  /** Key and count of the rail's images, `s0.jpg` … `s{count-1}.jpg`. */
  slides?: { key: string; count: number };
}

/**
 * A served thumbnail's path below `/thumb/{docId}/{versionId}/`: the 16-hex
 * key, then `cover.jpg` or `s{n}.jpg` with no leading zero. Anchored, so
 * nothing but these names can ever be turned into an object key.
 */
export const THUMB_REL = /^([0-9a-f]{16})\/(cover|s(0|[1-9]\d{0,2}))\.jpg$/;

/** The Storage key for one thumbnail. Outside `docs/{docId}/{versionId}/` on purpose. */
export function thumbObjectKey(docId: string, versionId: string, rel: string): string {
  return `${thumbPrefix(docId, versionId)}${rel}`;
}

/**
 * Everything stored for one version's thumbnails.
 *
 * Not under the version's own prefix: everything that reads a version reads
 * every object beneath it — the next commit's content hash, a fork's copy, the
 * download zip — and a thumbnail is none of those things.
 */
export function thumbPrefix(docId: string, versionId: string): string {
  return `docs/${docId}/thumbs/${versionId}/`;
}

/** The slot names an upload of this kind writes, in body order. */
export function thumbSlots(kind: ThumbKind, count: number): string[] {
  return kind === "cover" ? ["cover"] : Array.from({ length: count }, (_, i) => `s${i}`);
}

/** Read a stored `thumb` field defensively; anything malformed is no thumb at all. */
export function readThumb(value: unknown): DocThumb | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.versionId !== "string") return null;
  const thumb: DocThumb = { versionId: v.versionId, rev: typeof v.rev === "number" ? v.rev : 1 };
  if (typeof v.cover === "string") thumb.cover = v.cover;
  const s = v.slides as Record<string, unknown> | undefined;
  if (s && typeof s.key === "string" && typeof s.count === "number") {
    thumb.slides = { key: s.key, count: s.count };
  }
  return thumb;
}

/**
 * May this path be served, given the document's record? Only what the record
 * names: an object left behind by a lost race, or by a version the record has
 * moved past, has no URL that reaches it.
 */
export function servableThumb(thumb: DocThumb | null, versionId: string, rel: string): boolean {
  const m = THUMB_REL.exec(rel);
  if (!m || !thumb || thumb.versionId !== versionId) return false;
  const [, key, slot, index] = m;
  if (slot === "cover") return thumb.cover === key;
  return thumb.slides?.key === key && Number(index) < thumb.slides.count;
}

const SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

/**
 * A JPEG's pixel size, read from its frame header, or null if the bytes are
 * not a JPEG this can walk to one.
 *
 * Walks segment by segment from the start marker. Every segment before the
 * frame header carries its own length, which counts its own two bytes, so
 * stepping by it always lands at or past where the walk stood — and a length
 * too small to be real lands on a byte that is not a marker, which ends it.
 */
export function jpegSize(buf: Uint8Array): { width: number; height: number } | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 1 < buf.length) {
    if (buf[i] !== 0xff) return null;
    let marker = buf[i + 1];
    // Fill bytes: any number of 0xFF may precede a marker.
    while (marker === 0xff && i + 2 < buf.length) {
      i += 1;
      marker = buf[i + 1];
    }
    i += 2;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    // Image data or the end before any frame header: nothing to measure.
    if (marker === 0xd9 || marker === 0xda) return null;
    if (i + 1 >= buf.length) return null;
    const length = (buf[i] << 8) | buf[i + 1];
    if (SOF_MARKERS.has(marker)) {
      if (i + 6 >= buf.length) return null;
      return {
        height: (buf[i + 3] << 8) | buf[i + 4],
        width: (buf[i + 5] << 8) | buf[i + 6],
      };
    }
    i += length;
  }
  return null;
}

export type ParsedUpload = { images: Buffer[] } | { error: string };

/**
 * Split and check an upload: `sizes` lists each image's byte length, in slot
 * order, and the body is those images back to back. A query string rather
 * than a multipart body, because a multipart parser would be a dependency and
 * this is all the framing the upload needs.
 */
export function parseThumbUpload(body: Buffer | null, kind: string, sizes: string): ParsedUpload {
  if (kind !== "cover" && kind !== "slides") return { error: "kind must be cover or slides" };
  if (!/^\d{1,7}(,\d{1,7}){0,99}$/.test(sizes)) return { error: "invalid sizes" };
  const lengths = sizes.split(",").map(Number);
  if (kind === "cover" && lengths.length !== 1) return { error: "a cover is one image" };
  if (lengths.length > THUMB_MAX_SLIDES) return { error: "too many slides" };
  if (!body) return { error: "no body" };
  const total = lengths.reduce((a, b) => a + b, 0);
  if (total !== body.length) return { error: "sizes do not match the body" };

  const images: Buffer[] = [];
  let at = 0;
  for (const length of lengths) {
    if (length > THUMB_MAX_IMAGE_BYTES) return { error: "image too large" };
    const image = body.subarray(at, at + length);
    at += length;
    const n = image.length;
    if (n < 6 || image[0] !== 0xff || image[1] !== 0xd8 || image[2] !== 0xff) {
      return { error: "not a JPEG" };
    }
    if (image[n - 2] !== 0xff || image[n - 1] !== 0xd9) return { error: "truncated JPEG" };
    const size = jpegSize(image);
    if (!size || size.width < 1 || size.height < 1) return { error: "unreadable JPEG" };
    if (size.width > THUMB_MAX_SIDE || size.height > THUMB_MAX_SIDE) {
      return { error: "image too large" };
    }
    images.push(image);
  }
  return { images };
}

/**
 * Stored images nothing can name any more: a whole version's, or one key's
 * under a version whose newer capture replaced it.
 */
export interface StaleThumbs {
  versionId: string;
  key?: string;
}

export type ThumbDecision =
  | { write: false }
  | { write: true; thumb: DocThumb; stale: StaleThumbs[] };

/**
 * What `thumb` becomes when an upload of `kind` for `versionId`, made by
 * capture revision `rev`, lands.
 *
 * Each kind is written once per version and revision: the first upload wins,
 * and a second — another editor's tab, a retry — is told it is already there.
 * A newer revision replaces an older one's record for the same version, and
 * the keys it replaces are returned for deletion; an older revision never
 * replaces a newer one. An upload for a version the record has not reached yet
 * replaces the record, and the version it replaces is returned whole.
 */
export function nextThumb(
  current: DocThumb | null,
  versionId: string,
  kind: ThumbKind,
  key: string,
  count: number,
  rev: number,
): ThumbDecision {
  const value = kind === "cover" ? { cover: key } : { slides: { key, count } };
  if (current && current.versionId === versionId) {
    const held = current.rev ?? 1;
    if (held > rev) return { write: false };
    if (held === rev) {
      if (kind === "cover" ? current.cover : current.slides) return { write: false };
      return { write: true, thumb: { ...current, ...value }, stale: [] };
    }
    const keys = [current.cover, current.slides?.key].filter((k): k is string => Boolean(k));
    return {
      write: true,
      thumb: { versionId, rev, ...value },
      stale: keys.map((k) => ({ versionId, key: k })),
    };
  }
  return {
    write: true,
    thumb: { versionId, rev, ...value },
    stale: current ? [{ versionId: current.versionId }] : [],
  };
}
