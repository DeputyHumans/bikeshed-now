// SPDX-License-Identifier: Apache-2.0
// Self-test: lib/png.mjs decodes every colour type, bit depth and row filter, refuses what it cannot read, and counts a colour's pixels in a region, against a baseline or not (SPEC §12, §20).

/**
 * Hermetic and without Chrome: the PNGs come from selftest/helpers/png-encode.mjs,
 * which applies each row filter on purpose. browser-print.test.mjs has Chrome
 * decode the same files, so the encoder and the decoder cannot be wrong
 * together unnoticed.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { colourPixels, pixelAt, pngPixels, pngSize } from "../lib/png.mjs";
import { tinyPng } from "../lib/thumbs.mjs";
import { chunk, encodePng, expectedRgba, randomPng, sameBytes } from "./helpers/png-encode.mjs";

const PALETTE = Array.from({ length: 16 }, (_, i) => [i * 16, 255 - i * 15, (i * 37) % 256]);

/** Every colour type and bit depth the format allows, each through all five filters. */
const CASES = [
  { colorType: 0, bitDepth: 1 }, { colorType: 0, bitDepth: 2 }, { colorType: 0, bitDepth: 4 }, { colorType: 0, bitDepth: 8 }, { colorType: 0, bitDepth: 16 },
  { colorType: 2, bitDepth: 8 }, { colorType: 2, bitDepth: 16 },
  { colorType: 3, bitDepth: 1, palette: PALETTE.slice(0, 2) }, { colorType: 3, bitDepth: 2, palette: PALETTE.slice(0, 4) },
  { colorType: 3, bitDepth: 4, palette: PALETTE }, { colorType: 3, bitDepth: 8, palette: PALETTE },
  { colorType: 4, bitDepth: 8 }, { colorType: 4, bitDepth: 16 },
  { colorType: 6, bitDepth: 8 }, { colorType: 6, bitDepth: 16 },
];

test("pngPixels decodes every colour type and bit depth, with each of the five row filters", () => {
  for (const [i, c] of CASES.entries()) {
    // 13 wide: a sub-byte row ends mid-byte; 10 rows: each filter twice, after every other.
    const o = { width: 13, height: 10, ...c, seed: 100 + i };
    const { samples, png } = randomPng(o);
    const img = pngPixels(png);
    const what = `colour type ${c.colorType} at ${c.bitDepth} bits`;
    assert.deepEqual([img.width, img.height, img.colorType, img.bitDepth], [13, 10, c.colorType, c.bitDepth], what);
    assert.equal(img.data.length, 13 * 10 * 4, what);
    sameBytes(img.data, expectedRgba({ ...o, samples }), `${what}: every pixel`);
  }
});

test("each filter alone, on a gradient where every predictor differs (Paeth's ties included)", () => {
  const width = 9;
  const height = 6;
  const samples = Array.from({ length: height }, (_, y) => Array.from({ length: width * 4 }, (_, s) => (y * 41 + s * 23 + ((s * y) % 7) * 11) % 256));
  for (const f of [0, 1, 2, 3, 4]) {
    const img = pngPixels(encodePng({ width, height, colorType: 6, bitDepth: 8, samples, filters: [f] }));
    sameBytes(img.data, expectedRgba({ width, height, colorType: 6, bitDepth: 8, samples }), `filter ${f}`);
  }
});

test("tRNS: a palette's alpha per entry, a grey or RGB key colour", () => {
  const pal = { width: 4, height: 2, colorType: 3, bitDepth: 2, palette: PALETTE.slice(0, 4), trns: Buffer.from([0, 128]), samples: [[0, 1, 2, 3], [3, 2, 1, 0]] };
  sameBytes(pngPixels(encodePng(pal)).data, expectedRgba(pal), "the palette image");
  assert.deepEqual(pixelAt(pngPixels(encodePng(pal)), 0, 0)[3], 0, "entry 0 is transparent");
  assert.deepEqual(pixelAt(pngPixels(encodePng(pal)), 1, 0)[3], 128, "entry 1 is half");
  assert.deepEqual(pixelAt(pngPixels(encodePng(pal)), 2, 0)[3], 255, "entries past tRNS are opaque");
  const key = Buffer.alloc(6);
  key.writeUInt16BE(10, 0);
  key.writeUInt16BE(20, 2);
  key.writeUInt16BE(30, 4);
  const rgb = { width: 2, height: 1, colorType: 2, bitDepth: 8, trns: key, samples: [[10, 20, 30, 10, 20, 31]] };
  assert.deepEqual([...pngPixels(encodePng(rgb)).data], [10, 20, 30, 0, 10, 20, 31, 255]);
  const g = { width: 2, height: 1, colorType: 0, bitDepth: 4, trns: Buffer.from([0, 5]), samples: [[5, 6]] };
  assert.deepEqual([...pngPixels(encodePng(g)).data], [85, 85, 85, 0, 102, 102, 102, 255]);
});

test("pngSize reads the IHDR; tinyPng (lib/thumbs.mjs) decodes to its one colour", () => {
  const png = tinyPng({ width: 5, height: 3, rgb: [12, 34, 56] });
  assert.deepEqual(pngSize(png), { width: 5, height: 3 });
  const img = pngPixels(png);
  for (let y = 0; y < 3; y += 1) for (let x = 0; x < 5; x += 1) assert.deepEqual(pixelAt(img, x, y), [12, 34, 56, 255]);
  assert.throws(() => pixelAt(img, 5, 0), /outside the 5×3 image/);
  sameBytes(pngPixels(new Uint8Array(png)).data, img.data, "a Uint8Array is read as a Buffer");
});

test("what it cannot read is refused with E2E_PNG, never misread", () => {
  const good = randomPng({ width: 4, height: 4, colorType: 2, bitDepth: 8 }).png;
  const refused = (bytes, re) => assert.throws(() => pngPixels(bytes), (e) => e.code === "E2E_PNG" && re.test(e.message));
  refused(Buffer.from("GIF89a not a png at all"), /no PNG signature/);
  const flipped = Buffer.from(good);
  flipped[45] ^= 0x01; // inside the first IDAT's data (signature 8, IHDR 25, IDAT length and type 8)
  refused(flipped, /fails its CRC/);
  refused(good.subarray(0, good.length - 20), /truncated|runs past the end/);
  refused(encodePng({ width: 2, height: 2, colorType: 2, bitDepth: 8, samples: [[1, 2, 3, 4, 5, 6], [1, 2, 3, 4, 5, 6]], interlace: 1 }), /Adam7/);
  refused(encodePng({ width: 2, height: 1, colorType: 2, bitDepth: 4, samples: [[1, 2, 3, 4, 5, 6]] }), /bit depth 4 with colour type 2/);
  refused(encodePng({ width: 2, height: 1, colorType: 3, bitDepth: 8, palette: PALETTE.slice(0, 2), samples: [[0, 2]] }), /palette index 2/);
  refused(encodePng({ width: 2, height: 2, colorType: 0, bitDepth: 8, samples: [[1, 2], [3, 4]], filters: [5] }), /filter type 5/);
  refused(encodePng({ width: 1, height: 1, colorType: 0, bitDepth: 8, samples: [[1]], extra: [["ABCD", Buffer.alloc(1)]] }), /unknown critical chunk ABCD/);
  // An ancillary chunk it does not know is skipped, as the format says.
  assert.equal(pngPixels(encodePng({ width: 1, height: 1, colorType: 0, bitDepth: 8, samples: [[9]], extra: [["teXt", Buffer.from("k\0v")]] })).data[0], 9);
  // Image data for the wrong size: an IHDR saying 3 wide over rows of 2.
  const lie = Buffer.from(encodePng({ width: 2, height: 2, colorType: 0, bitDepth: 8, samples: [[1, 2], [3, 4]] }));
  lie.writeUInt32BE(3, 16);
  const ihdrBody = lie.subarray(12, 29);
  const fixed = Buffer.concat([lie.subarray(0, 8), chunk("IHDR", ihdrBody.subarray(4)), lie.subarray(33)]);
  refused(fixed, /bytes of image data where a 3×2 grey image at 8 bits has 8/);
  assert.throws(() => pngPixels(null), /want a Buffer/);
});

/** A 40×20 white RGB image with `draw` = [[x, y, [r,g,b]]…]. */
function canvas(draw, { width = 40, height = 20, bg = [255, 255, 255] } = {}) {
  const samples = Array.from({ length: height }, () => Array.from({ length: width }, () => bg).flat());
  for (const [x, y, c] of draw) samples[y].splice(x * 3, 3, ...c);
  return pngPixels(encodePng({ width, height, colorType: 2, bitDepth: 8, samples, filters: [4, 1, 2] }));
}

test("colourPixels counts a colour in a region, with its box and how much of the box it fills", () => {
  const RED = [176, 35, 24];
  // A 'glyph': a hollow 6×5 rectangle of red at (30, 2), and one stray red pixel at (2, 15).
  const draw = [];
  for (let x = 30; x < 36; x += 1) draw.push([x, 2, RED], [x, 6, RED]);
  for (let y = 3; y < 6; y += 1) draw.push([30, y, RED], [35, y, RED]);
  draw.push([2, 15, [190, 40, 30]]);
  const img = canvas(draw);
  const top = colourPixels(img, { color: RED, region: { x: 20, y: 0, w: 20, h: 10 } });
  assert.deepEqual({ ...top, fill: Math.round(top.fill * 1000) / 1000 }, { count: 18, box: [30, 2, 6, 5], fill: 0.6, area: 200 });
  assert.equal(colourPixels(img, { color: RED }).count, 19, "the whole image, the near-red stray within tol 70");
  assert.equal(colourPixels(img, { color: RED, tol: 5 }).count, 18, "a tight tolerance leaves the stray out");
  assert.deepEqual(colourPixels(img, { color: [0, 0, 255] }), { count: 0, box: null, fill: 0, area: 800 });
  assert.equal(colourPixels(img, { color: RED, region: { x: -10, y: -10, w: 45, h: 15 } }).area, 35 * 5, "a region past the edges is clipped");
  assert.equal(colourPixels(img, { color: RED, region: { x: 50, y: 0, w: 5, h: 5 } }).area, 0, "a region outside is empty");
  assert.equal(colourPixels(img, { color: null }).count, 800, "any colour: every opaque pixel");
  const solid = canvas(Array.from({ length: 20 }, (_, i) => [10 + (i % 5), 10 + Math.floor(i / 5), RED]));
  assert.equal(colourPixels(solid, { color: RED }).fill, 1, "a solid block fills its box");
});

test("colourPixels with a baseline counts only what differs from it; transparent pixels never count", () => {
  const RED = [176, 35, 24];
  const base = canvas([[1, 1, RED], [2, 1, RED]]);
  const img = canvas([[1, 1, RED], [2, 1, RED], [10, 10, RED], [11, 10, [250, 250, 250]]]);
  assert.equal(colourPixels(img, { color: RED }).count, 3, "without the baseline: every red pixel");
  assert.deepEqual(colourPixels(img, { color: RED, baseline: base }), { count: 1, box: [10, 10, 1, 1], fill: 1, area: 800 }, "with it: only the red that was added");
  assert.equal(colourPixels(img, { color: null, baseline: base }).count, 1, "white against white differs by 15, under minDiff 30");
  assert.equal(colourPixels(img, { color: null, baseline: base, minDiff: 10 }).count, 2, "a smaller minDiff counts it");
  assert.throws(() => colourPixels(img, { color: RED, baseline: canvas([], { width: 41 }) }), /baseline is 41×20, the image 40×20/);
  const clear = pngPixels(encodePng({ width: 2, height: 1, colorType: 6, bitDepth: 8, samples: [[176, 35, 24, 0, 176, 35, 24, 1]] }));
  assert.equal(colourPixels(clear, { color: RED }).count, 1, "alpha 0 never counts; alpha 1 does");
  for (const bad of [{ color: [1, 2] }, { color: RED, tol: -1 }, { color: RED, region: { x: 0, y: 0, w: 1.5, h: 1 } }, { color: RED, minDiff: "x" }]) {
    assert.throws(() => colourPixels(img, bad), /colourPixels:/, JSON.stringify(bad));
  }
});
