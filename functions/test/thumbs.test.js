// SPDX-License-Identifier: Apache-2.0
// What a thumbnail upload may contain, and which stored images may be served (SPEC §2, §4).

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  THUMB_MAX_IMAGE_BYTES,
  THUMB_MAX_SIDE,
  THUMB_MAX_SLIDES,
  THUMB_REL,
  THUMB_REVISION,
  jpegSize,
  nextThumb,
  parseThumbUpload,
  readThumb,
  servableThumb,
  thumbObjectKey,
  thumbSlots,
} = require("../lib/lib/thumbs.js");

/**
 * A real 5x3 JPEG, encoded by macOS `sips` from the repository's own
 * og-default.png. Real rather than hand-assembled because an encoder puts
 * JFIF and Exif segments before the frame header, and walking past those is
 * exactly what a size reader gets wrong.
 */
const REAL = Buffer.from(
  "/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAA" +
  "A6ABAAMAAAABAAEAAKACAAQAAAABAAAABaADAAQAAAABAAAAAwAAAAD/7QA4UGhvdG9zaG9wIDMu" +
  "MAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZjwCyBOmACZjs+EJ+/8AAEQgAAwAFAwEiAAIR" +
  "AQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAAB" +
  "fQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5" +
  "OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeo" +
  "qaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMB" +
  "AQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYS" +
  "QVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNU" +
  "VVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5" +
  "usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/bAEMACQkJCQkJEAkJEBYQEBAW" +
  "HhYWFhYeJh4eHh4eJi4mJiYmJiYuLi4uLi4uLjc3Nzc3N0BAQEBASEhISEhISEhISP/bAEMBCwwM" +
  "EhESHxERH0szKjNLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tL" +
  "S0tLS//dAAQAAf/aAAwDAQACEQMRAD8A9vChc47+9OoooA//2Q==",
  "base64",
);

/** The smallest byte sequence the checks accept: SOI, a baseline frame header, EOI. */
function jpeg(width, height, pad = 0) {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08]),
    Buffer.from([height >> 8, height & 255, width >> 8, width & 255]),
    Buffer.from([0x01, 0x01, 0x11, 0x00]),
    Buffer.alloc(pad),
    Buffer.from([0xff, 0xd9]),
  ]);
}

const SELF = Symbol("the body's own length");

const upload = (kind, images) =>
  parseThumbUpload(Buffer.concat(images), kind, images.map((i) => i.length).join(","));

// --- Reading a JPEG's size --------------------------------------------------

test("reads a real encoder's JPEG past its JFIF and Exif segments", () => {
  assert.deepEqual(jpegSize(REAL), { width: 5, height: 3 });
});

test("reads the frame header of a progressive JPEG too", () => {
  const progressive = jpeg(640, 360);
  progressive[3] = 0xc2;
  assert.deepEqual(jpegSize(progressive), { width: 640, height: 360 });
});

test("finds no size in what is not a JPEG, or ends before its frame", () => {
  assert.equal(jpegSize(Buffer.from("<svg onload=alert(1)>")), null);
  assert.equal(jpegSize(Buffer.from([0xff, 0xd8, 0xff, 0xd9])), null);
  // Scan data before any frame header: nothing to measure.
  assert.equal(jpegSize(Buffer.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02, 0xff, 0xd9])), null);
});

test("a segment length cannot send the walk backwards or around in a loop", () => {
  // A zero length would leave the walk where it is, forever.
  assert.equal(jpegSize(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00, 0xff, 0xd9])), null);
  // A huge one walks off the end.
  assert.equal(jpegSize(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xff, 0xff, 0xd9])), null);
});

// --- What an upload may contain -----------------------------------------------

test("accepts a cover and a deck's slides", () => {
  assert.deepEqual(upload("cover", [REAL]), { images: [REAL] });
  const slides = upload("slides", [jpeg(640, 360), REAL, jpeg(640, 360)]);
  assert.equal(slides.images.length, 3);
  assert.deepEqual(slides.images[1], REAL);
});

for (const [name, kind, body, sizes, error] of [
  ["an unknown kind", "poster", jpeg(10, 10), SELF, "kind must be cover or slides"],
  ["sizes that are not a list of numbers", "cover", jpeg(10, 10), "17;0", "invalid sizes"],
  ["no sizes at all", "cover", jpeg(10, 10), "", "invalid sizes"],
  ["two images called a cover", "cover", Buffer.concat([jpeg(1, 1), jpeg(1, 1)]), "17,17", "a cover is one image"],
  ["sizes that claim less than the body", "cover", Buffer.concat([jpeg(1, 1), Buffer.from("x")]), "17", "sizes do not match the body"],
  ["sizes that claim more than the body", "cover", jpeg(1, 1), "18", "sizes do not match the body"],
  ["no body", "cover", null, "17", "no body"],
  ["an SVG", "cover", Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"), SELF, "not a JPEG"],
  ["a JPEG cut short", "cover", jpeg(10, 10).subarray(0, 15), SELF, "truncated JPEG"],
  ["a JPEG with no frame header", "cover", Buffer.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02, 0xff, 0xd9]), SELF, "unreadable JPEG"],
  ["an image wider than the cap", "cover", jpeg(THUMB_MAX_SIDE + 1, 10), SELF, "image too large"],
  ["an image taller than the cap", "cover", jpeg(10, THUMB_MAX_SIDE + 1), SELF, "image too large"],
  ["an image of more bytes than the cap", "cover", jpeg(10, 10, THUMB_MAX_IMAGE_BYTES), SELF, "image too large"],
]) {
  test(`refuses ${name}`, () => {
    // SELF: the body's own length, so the case reaches the check it is named for.
    const claimed = sizes === SELF ? String(body.length) : sizes;
    // The error alone: diffing an accepted 160 KiB image against `{ error }`
    // takes minutes, which turns a failure into a hang.
    assert.equal(parseThumbUpload(body, kind, claimed).error, error);
  });
}

test("refuses more slides than a stored rail is kept for", () => {
  const one = jpeg(4, 4);
  const many = Array.from({ length: THUMB_MAX_SLIDES + 1 }, () => one);
  assert.deepEqual(upload("slides", many), { error: "invalid sizes" });
  assert.equal(upload("slides", many.slice(1)).images.length, THUMB_MAX_SLIDES);
});

// --- Where they live, and what may be served ---------------------------------

test("stores a version's thumbnails beside its bytes, never among them", () => {
  // Everything that reads a version takes every object under
  // docs/{id}/{version}/ — the next commit's hash, a fork, the download zip.
  const key = thumbObjectKey("q3-plan", "v2", "0123456789abcdef/cover.jpg");
  assert.equal(key, "docs/q3-plan/thumbs/v2/0123456789abcdef/cover.jpg");
  assert.ok(!key.startsWith("docs/q3-plan/v2/"));
  assert.deepEqual(thumbSlots("slides", 3), ["s0", "s1", "s2"]);
  assert.deepEqual(thumbSlots("cover", 1), ["cover"]);
});

test("names only a key and a slot, and nothing that could become a path", () => {
  for (const ok of ["0123456789abcdef/cover.jpg", "0123456789abcdef/s0.jpg", "0123456789abcdef/s99.jpg"]) {
    assert.match(ok, THUMB_REL, ok);
  }
  for (const bad of [
    "../0123456789abcdef/cover.jpg",
    "0123456789abcdef/../cover.jpg",
    "0123456789abcdef/cover.jpg.html",
    "0123456789abcdef/cover.jpeg",
    "0123456789ABCDEF/cover.jpg",
    "0123456789abcde/cover.jpg",
    "0123456789abcdef/s01.jpg",
    "0123456789abcdef/s1000.jpg",
    "0123456789abcdef/index.html",
  ]) {
    assert.doesNotMatch(bad, THUMB_REL, bad);
  }
});

const KEY = "0123456789abcdef";
const OTHER = "fedcba9876543210";

test("serves only the images the record names", () => {
  const thumb = { versionId: "v2", cover: KEY, slides: { key: OTHER, count: 3 } };
  assert.equal(servableThumb(thumb, "v2", `${KEY}/cover.jpg`), true);
  assert.equal(servableThumb(thumb, "v2", `${OTHER}/s2.jpg`), true);
  // A slide past the count, a key the record does not hold, another version.
  assert.equal(servableThumb(thumb, "v2", `${OTHER}/s3.jpg`), false);
  assert.equal(servableThumb(thumb, "v2", `${OTHER}/cover.jpg`), false);
  assert.equal(servableThumb(thumb, "v1", `${KEY}/cover.jpg`), false);
  assert.equal(servableThumb(null, "v2", `${KEY}/cover.jpg`), false);
});

test("reads a stored record defensively", () => {
  assert.equal(readThumb(undefined), null);
  assert.equal(readThumb({ cover: KEY }), null);
  assert.deepEqual(readThumb({ versionId: "v1", cover: 7, slides: { key: KEY } }), { versionId: "v1", rev: 1 });
});

// --- What the record becomes --------------------------------------------------

const REV = THUMB_REVISION;

test("the first upload of each kind for a version wins", () => {
  const cover = { versionId: "v2", rev: REV, cover: KEY };
  assert.deepEqual(nextThumb(cover, "v2", "cover", OTHER, 1, REV), { write: false });
  const both = { ...cover, slides: { key: OTHER, count: 4 } };
  assert.deepEqual(nextThumb(both, "v2", "slides", KEY, 4, REV), { write: false });
});

test("adds the other kind for the same version without disturbing the first", () => {
  assert.deepEqual(nextThumb({ versionId: "v2", rev: REV, cover: KEY }, "v2", "slides", OTHER, 5, REV), {
    write: true,
    thumb: { versionId: "v2", rev: REV, cover: KEY, slides: { key: OTHER, count: 5 } },
    stale: [],
  });
});

test("a new version replaces the record and names the old one for deletion", () => {
  const old = { versionId: "v1", rev: REV, cover: KEY, slides: { key: OTHER, count: 2 } };
  assert.deepEqual(nextThumb(old, "v2", "cover", OTHER, 1, REV), {
    write: true,
    thumb: { versionId: "v2", rev: REV, cover: OTHER },
    stale: [{ versionId: "v1" }],
  });
  assert.deepEqual(nextThumb(null, "v1", "cover", KEY, 1, REV), {
    write: true,
    thumb: { versionId: "v1", rev: REV, cover: KEY },
    stale: [],
  });
});

test("a capture by a newer revision replaces an older one of the same version", () => {
  // Write-once per version would otherwise keep a bad image until the next
  // version: a logo sheet captured as black squares stayed that way.
  const before = { versionId: "v4", cover: KEY, slides: { key: OTHER, count: 7 } };
  assert.deepEqual(nextThumb(before, "v4", "cover", "aaaaaaaaaaaaaaaa", 1, 2), {
    write: true,
    thumb: { versionId: "v4", rev: 2, cover: "aaaaaaaaaaaaaaaa" },
    // Its own key's objects only: the new cover is already under this version.
    stale: [
      { versionId: "v4", key: KEY },
      { versionId: "v4", key: OTHER },
    ],
  });
});

test("an older revision never replaces a newer one", () => {
  const current = { versionId: "v4", rev: 3, cover: KEY };
  assert.deepEqual(nextThumb(current, "v4", "slides", OTHER, 2, 2), { write: false });
  assert.deepEqual(nextThumb(current, "v4", "cover", OTHER, 1, 2), { write: false });
});

test("reads a record's revision, and calls a record without one the first", () => {
  assert.deepEqual(readThumb({ versionId: "v1", cover: KEY }), { versionId: "v1", rev: 1, cover: KEY });
  assert.deepEqual(readThumb({ versionId: "v1", rev: 2 }), { versionId: "v1", rev: 2 });
});
