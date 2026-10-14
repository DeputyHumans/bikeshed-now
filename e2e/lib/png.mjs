// SPDX-License-Identifier: Apache-2.0
// Decoding a PNG to RGBA pixels and counting the pixels of a colour in a region, for oracles judged by what was painted (SPEC §12, §20).

/**
 * An oracle such as "hostile CSS cannot hide the stamp" (SPEC §20) is about
 * what was PAINTED, so it needs pixels: a screenshot from printRenderer
 * (lib/browser.mjs), a PNG the app exported, an image a page drew. Node has
 * zlib but no PNG decoder, and the suite takes no image dependency, so this
 * is one, written to the PNG specification (ISO/IEC 15948): every colour type
 * and bit depth the format allows, the five row filters, PLTE and tRNS
 * transparency, every chunk's CRC checked. Not supported, and refused with
 * `E2E_PNG` rather than misread: Adam7 interlacing (Chrome's screenshots and
 * canvas exports are never interlaced), and anything malformed.
 *
 * Colour is taken as the file's numbers: gAMA, cHRM, sRGB and iCCP are
 * ignored, as a browser does for a PNG without them. A 16-bit sample becomes
 * its high byte; a 1, 2 or 4-bit grey is scaled to 0–255 exactly.
 *
 * `colourPixels` is the measurement: how many pixels in a region are within
 * `tol` of a colour (Euclidean distance in RGB), optionally only those that
 * DIFFER from a baseline image of the same size (the same render with the
 * thing under test removed), with the bounding box of what was counted and
 * how much of that box it fills. Glyphs fill a small part of their box; a
 * solid block of the colour fills all of it.
 */

import { inflateSync } from "node:zlib";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Bit depths each colour type allows, and how many samples a pixel has. */
const COLOUR_TYPES = Object.freeze({
  0: { name: "grey", channels: 1, depths: [1, 2, 4, 8, 16] },
  2: { name: "RGB", channels: 3, depths: [8, 16] },
  3: { name: "palette", channels: 1, depths: [1, 2, 4, 8] },
  4: { name: "grey and alpha", channels: 2, depths: [8, 16] },
  6: { name: "RGBA", channels: 4, depths: [8, 16] },
});

/** The largest image decoded: 64 megapixels (a 16384² page is 268 M; nothing here comes close). */
export const PNG_MAX_PIXELS = 64 * 1024 * 1024;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf, start, end) {
  let c = 0xffffffff;
  for (let i = start; i < end; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngError(why) {
  const err = new Error(`not a PNG this decoder reads: ${why}`);
  err.code = "E2E_PNG";
  return err;
}

function asBuffer(bytes, what) {
  if (Buffer.isBuffer(bytes)) return bytes;
  if (bytes instanceof Uint8Array) return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes instanceof ArrayBuffer) return Buffer.from(bytes);
  throw new Error(`${what}: want a Buffer, a Uint8Array or an ArrayBuffer, got ${bytes === null ? "null" : typeof bytes}`);
}

/** Every chunk, in order, each CRC checked: [{type, data}]. Stops at IEND; anything after it is ignored. */
function chunks(buf) {
  if (buf.length < SIGNATURE.length || !buf.subarray(0, SIGNATURE.length).equals(SIGNATURE)) throw pngError("no PNG signature");
  const out = [];
  let at = SIGNATURE.length;
  for (;;) {
    if (at + 12 > buf.length) throw pngError(`truncated at byte ${at}, before IEND`);
    const len = buf.readUInt32BE(at);
    if (len > 0x7fffffff || at + 12 + len > buf.length) throw pngError(`chunk at byte ${at} runs past the end (${len} bytes)`);
    const type = buf.toString("latin1", at + 4, at + 8);
    if (!/^[A-Za-z]{4}$/.test(type)) throw pngError(`chunk at byte ${at} has no valid type`);
    const crc = buf.readUInt32BE(at + 8 + len);
    if (crc32(buf, at + 4, at + 8 + len) !== crc) throw pngError(`${type} chunk at byte ${at} fails its CRC`);
    out.push({ type, data: buf.subarray(at + 8, at + 8 + len) });
    at += 12 + len;
    if (type === "IEND") return out;
  }
}

function readHeader(ihdr) {
  if (!ihdr || ihdr.data.length !== 13) throw pngError("the first chunk is not a 13-byte IHDR");
  const d = ihdr.data;
  const h = { width: d.readUInt32BE(0), height: d.readUInt32BE(4), bitDepth: d[8], colorType: d[9], compression: d[10], filter: d[11], interlace: d[12] };
  if (h.width < 1 || h.height < 1 || h.width > 0x7fffffff || h.height > 0x7fffffff) throw pngError(`a ${h.width}×${h.height} image`);
  const ct = COLOUR_TYPES[h.colorType];
  if (!ct) throw pngError(`colour type ${h.colorType}`);
  if (!ct.depths.includes(h.bitDepth)) throw pngError(`bit depth ${h.bitDepth} with colour type ${h.colorType} (${ct.name})`);
  if (h.compression !== 0 || h.filter !== 0) throw pngError(`compression method ${h.compression}, filter method ${h.filter}`);
  if (h.interlace === 1) throw pngError("Adam7 interlacing is not supported");
  if (h.interlace !== 0) throw pngError(`interlace method ${h.interlace}`);
  return { ...h, channels: ct.channels };
}

/** {width, height} from the IHDR alone, without decoding. Throws E2E_PNG when it is not a PNG. */
export function pngSize(bytes) {
  const buf = asBuffer(bytes, "pngSize");
  if (buf.length < 33 || !buf.subarray(0, 8).equals(SIGNATURE) || buf.toString("latin1", 12, 16) !== "IHDR") throw pngError("no PNG signature and IHDR");
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** Undo the five row filters in place (PNG §9): `raw` is height × (1 + stride) bytes. */
function unfilter(raw, height, stride, bpp) {
  const out = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y += 1) {
    const type = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    const up = dst - stride; // the previous row, already unfiltered (none for the first row)
    for (let i = 0; i < stride; i += 1) {
      const x = raw[src + i];
      const a = i >= bpp ? out[dst + i - bpp] : 0;
      const b = y > 0 ? out[up + i] : 0;
      const c = y > 0 && i >= bpp ? out[up + i - bpp] : 0;
      let v;
      switch (type) {
        case 0:
          v = x;
          break;
        case 1:
          v = x + a;
          break;
        case 2:
          v = x + b;
          break;
        case 3:
          v = x + ((a + b) >>> 1);
          break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default:
          throw pngError(`row ${y} has filter type ${type}`);
      }
      out[dst + i] = v & 0xff;
    }
  }
  return out;
}

/**
 * Decode a PNG: {width, height, bitDepth, colorType, data} where `data` is a
 * Uint8Array of width × height × 4 bytes, RGBA, row by row from the top left,
 * not premultiplied. Throws E2E_PNG on anything malformed or unsupported
 * (see the header).
 */
export function pngPixels(bytes) {
  const buf = asBuffer(bytes, "pngPixels");
  const list = chunks(buf);
  const h = readHeader(list[0]?.type === "IHDR" ? list[0] : null);
  if (h.width * h.height > PNG_MAX_PIXELS) throw pngError(`${h.width}×${h.height} is more than ${PNG_MAX_PIXELS} pixels`);
  let palette = null;
  let trns = null;
  const idat = [];
  let sawIdat = false;
  let idatDone = false;
  for (const ch of list.slice(1)) {
    if (ch.type === "IHDR") throw pngError("a second IHDR");
    if (ch.type === "IDAT") {
      if (idatDone) throw pngError("IDAT chunks are not consecutive");
      idat.push(ch.data);
      sawIdat = true;
      continue;
    }
    if (sawIdat) idatDone = true;
    if (ch.type === "PLTE") {
      if (sawIdat) throw pngError("PLTE after IDAT");
      if (ch.data.length === 0 || ch.data.length % 3 !== 0 || ch.data.length > 768) throw pngError(`a PLTE of ${ch.data.length} bytes`);
      palette = ch.data;
    } else if (ch.type === "tRNS") {
      if (sawIdat) throw pngError("tRNS after IDAT");
      trns = ch.data;
    } else if (ch.type !== "IEND" && !(ch.type.charCodeAt(0) & 0x20)) {
      throw pngError(`an unknown critical chunk ${ch.type}`);
    }
  }
  if (idat.length === 0) throw pngError("no IDAT");
  if (h.colorType === 3 && !palette) throw pngError("a palette image with no PLTE");
  let raw;
  try {
    raw = inflateSync(Buffer.concat(idat));
  } catch (e) {
    throw pngError(`its image data does not inflate (${e.code ?? e.message})`);
  }
  const bitsPerPixel = h.channels * h.bitDepth;
  const stride = Math.ceil((h.width * bitsPerPixel) / 8);
  const bpp = Math.max(1, bitsPerPixel >> 3);
  const want = h.height * (stride + 1);
  if (raw.length !== want) throw pngError(`${raw.length} bytes of image data where a ${h.width}×${h.height} ${COLOUR_TYPES[h.colorType].name} image at ${h.bitDepth} bits has ${want}`);
  const px = unfilter(raw, h.height, stride, bpp);

  const out = new Uint8Array(h.width * h.height * 4);
  const d = h.bitDepth;
  const maxSample = (1 << d) - 1; // for d ≤ 8
  /** Sample `s` (0-based, in channel order) of row `y` at native depth. */
  const sample = (y, s) => {
    const row = y * stride;
    if (d === 16) return px.readUInt16BE(row + s * 2);
    if (d === 8) return px[row + s];
    const bit = s * d;
    return (px[row + (bit >> 3)] >> (8 - d - (bit & 7))) & maxSample;
  };
  const to8 = (v) => (d === 16 ? v >> 8 : d === 8 ? v : Math.round((v * 255) / maxSample));
  const key = trns && (h.colorType === 0 || h.colorType === 2) ? trns : null;
  if (key && key.length !== (h.colorType === 0 ? 2 : 6)) throw pngError(`a tRNS of ${key.length} bytes for colour type ${h.colorType}`);
  if (trns && h.colorType === 3 && trns.length > palette.length / 3) throw pngError("a tRNS longer than the palette");
  if (trns && (h.colorType === 4 || h.colorType === 6)) throw pngError(`a tRNS with colour type ${h.colorType}, which has alpha`);
  for (let y = 0; y < h.height; y += 1) {
    for (let x = 0; x < h.width; x += 1) {
      const o = (y * h.width + x) * 4;
      const s = x * h.channels;
      switch (h.colorType) {
        case 0: {
          const g = sample(y, s);
          out[o] = out[o + 1] = out[o + 2] = to8(g);
          out[o + 3] = key && g === key.readUInt16BE(0) ? 0 : 255;
          break;
        }
        case 2: {
          const r = sample(y, s);
          const g = sample(y, s + 1);
          const b = sample(y, s + 2);
          out[o] = to8(r);
          out[o + 1] = to8(g);
          out[o + 2] = to8(b);
          out[o + 3] = key && r === key.readUInt16BE(0) && g === key.readUInt16BE(2) && b === key.readUInt16BE(4) ? 0 : 255;
          break;
        }
        case 3: {
          const i = sample(y, s);
          if (i * 3 + 2 >= palette.length) throw pngError(`palette index ${i} at (${x}, ${y}) is past the ${palette.length / 3}-entry PLTE`);
          out[o] = palette[i * 3];
          out[o + 1] = palette[i * 3 + 1];
          out[o + 2] = palette[i * 3 + 2];
          out[o + 3] = trns && i < trns.length ? trns[i] : 255;
          break;
        }
        case 4: {
          out[o] = out[o + 1] = out[o + 2] = to8(sample(y, s));
          out[o + 3] = to8(sample(y, s + 1));
          break;
        }
        default: {
          out[o] = to8(sample(y, s));
          out[o + 1] = to8(sample(y, s + 1));
          out[o + 2] = to8(sample(y, s + 2));
          out[o + 3] = to8(sample(y, s + 3));
        }
      }
    }
  }
  return { width: h.width, height: h.height, bitDepth: h.bitDepth, colorType: h.colorType, data: out };
}

/** A decoded image as given, or the bytes of a PNG decoded. */
function asImage(img, what) {
  if (img && typeof img === "object" && Number.isInteger(img.width) && Number.isInteger(img.height) && img.data instanceof Uint8Array && !Buffer.isBuffer(img)) {
    if (img.data.length !== img.width * img.height * 4) throw new Error(`${what}: an image's data is width × height × 4 bytes (RGBA)`);
    return img;
  }
  return pngPixels(img);
}

/** [r, g, b, a] at (x, y) of a decoded image (or a PNG's bytes); throws outside it. */
export function pixelAt(img, x, y) {
  const im = asImage(img, "pixelAt");
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= im.width || y >= im.height) {
    throw new Error(`pixelAt: (${x}, ${y}) is outside the ${im.width}×${im.height} image`);
  }
  const o = (y * im.width + x) * 4;
  return [im.data[o], im.data[o + 1], im.data[o + 2], im.data[o + 3]];
}

const isRgb = (c) => Array.isArray(c) && c.length === 3 && c.every((v) => Number.isInteger(v) && v >= 0 && v <= 255);

/**
 * Count the pixels of `img` (a decoded image or a PNG's bytes) inside `region`
 * ({x, y, w, h} in pixels, clipped to the image; null for all of it) that are
 * not fully transparent and within `tol` of `color` ([r, g, b], Euclidean
 * distance in RGB; null for any colour). With `baseline` (an image of the
 * same size), only pixels whose RGB differs from the baseline's by more than
 * `minDiff` (the sum of the three absolute differences) count: what the
 * thing removed from the baseline painted.
 *
 * Returns {count, box, fill, area}: `box` is [x, y, w, h] around the counted
 * pixels (null when none), `fill` count / the box's area (0 when none), and
 * `area` the number of pixels the clipped region holds.
 */
export function colourPixels(img, { color = null, tol = 70, region = null, baseline = null, minDiff = 30 } = {}) {
  const im = asImage(img, "colourPixels");
  if (color !== null && !isRgb(color)) throw new Error(`colourPixels: color is [r, g, b] with integers 0–255, or null, got ${JSON.stringify(color)}`);
  if (!(typeof tol === "number" && tol >= 0)) throw new Error(`colourPixels: tol is a non-negative number, got ${JSON.stringify(tol)}`);
  if (!(typeof minDiff === "number" && minDiff >= 0)) throw new Error(`colourPixels: minDiff is a non-negative number, got ${JSON.stringify(minDiff)}`);
  if (region !== null && !(region && ["x", "y", "w", "h"].every((k) => Number.isInteger(region[k])))) {
    throw new Error(`colourPixels: region is {x, y, w, h} in whole pixels, or null, got ${JSON.stringify(region)}`);
  }
  const base = baseline === null ? null : asImage(baseline, "colourPixels baseline");
  if (base && (base.width !== im.width || base.height !== im.height)) {
    throw new Error(`colourPixels: the baseline is ${base.width}×${base.height}, the image ${im.width}×${im.height}`);
  }
  const r = region ?? { x: 0, y: 0, w: im.width, h: im.height };
  const x0 = Math.max(0, r.x);
  const y0 = Math.max(0, r.y);
  const x1 = Math.min(im.width, r.x + r.w);
  const y1 = Math.min(im.height, r.y + r.h);
  const tol2 = tol * tol;
  const a = im.data;
  const b = base?.data;
  let count = 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -1;
  let maxY = -1;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const i = (y * im.width + x) * 4;
      if (a[i + 3] === 0) continue;
      if (b && Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) <= minDiff) continue;
      if (color) {
        const dr = a[i] - color[0];
        const dg = a[i + 1] - color[1];
        const db = a[i + 2] - color[2];
        if (dr * dr + dg * dg + db * db > tol2) continue;
      }
      count += 1;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  const area = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  if (count === 0) return { count, box: null, fill: 0, area };
  const box = [minX, minY, maxX - minX + 1, maxY - minY + 1];
  return { count, box, fill: count / (box[2] * box[3]), area };
}
