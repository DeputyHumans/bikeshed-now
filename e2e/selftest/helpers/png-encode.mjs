// SPDX-License-Identifier: Apache-2.0
// Self-test helper: a PNG encoder with every colour type, bit depth and row filter, so the decoder in lib/png.mjs is read against files it did not write (SPEC §12).

/**
 * Written from the PNG specification, independently of lib/png.mjs: the
 * filters are applied here (the decoder undoes them), and each row's filter
 * type is the caller's choice, so every filter is exercised on purpose rather
 * than on whatever an encoder's heuristic picks. browser-print.test.mjs has
 * Chrome decode the same files, which is the check that this encoder and the
 * decoder are not wrong together.
 */

import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";

/**
 * Byte equality that fails at once with the first difference: a failing
 * deepEqual over thousands of bytes spends minutes building its diff.
 */
export function sameBytes(actual, expected, what) {
  const a = Uint8Array.from(actual);
  const e = Uint8Array.from(expected);
  assert.equal(a.length, e.length, `${what}: ${a.length} bytes, want ${e.length}`);
  const i = a.findIndex((v, k) => v !== e[k]);
  assert.equal(i, -1, `${what}: byte ${i} (pixel ${i >> 2}, channel ${i & 3}) is ${a[i]}, want ${e[i]}`);
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc(body));
  return Buffer.concat([len, body, c]);
}

const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/** The Paeth predictor, as PNG §9.4 states it. */
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * samples: an array of rows, each an array of sample values at the native
 * depth (width × channels of them). filters: one filter type per row (cycled).
 * Returns the PNG's bytes. `palette` ([[r,g,b]…]) and `trns` (Buffer) as the
 * colour type needs; `interlace` writes the flag only (to test the refusal).
 */
export function encodePng({ width, height, colorType, bitDepth, samples, filters = [0], palette = null, trns = null, interlace = 0, extra = [] }) {
  const ch = CHANNELS[colorType];
  const bits = ch * bitDepth;
  const stride = Math.ceil((width * bits) / 8);
  const bpp = Math.max(1, bits >> 3);
  const rows = samples.map((row) => {
    const out = Buffer.alloc(stride);
    row.forEach((v, s) => {
      if (bitDepth === 16) out.writeUInt16BE(v, s * 2);
      else if (bitDepth === 8) out[s] = v;
      else {
        const bit = s * bitDepth;
        out[bit >> 3] |= v << (8 - bitDepth - (bit & 7));
      }
    });
    return out;
  });
  const raw = [];
  rows.forEach((row, y) => {
    const type = filters[y % filters.length];
    const prev = y > 0 ? rows[y - 1] : Buffer.alloc(stride);
    const f = Buffer.alloc(stride + 1);
    f[0] = type;
    for (let i = 0; i < stride; i += 1) {
      const a = i >= bpp ? row[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      const pred = [0, a, b, Math.floor((a + b) / 2), paeth(a, b, c)][type];
      f[i + 1] = (row[i] - pred) & 0xff;
    }
    raw.push(f);
  });
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = bitDepth;
  ihdr[9] = colorType;
  ihdr[12] = interlace;
  const parts = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr)];
  if (palette) parts.push(chunk("PLTE", Buffer.from(palette.flat())));
  if (trns) parts.push(chunk("tRNS", trns));
  for (const [type, data] of extra) parts.push(chunk(type, data));
  const z = deflateSync(Buffer.concat(raw));
  // Two IDAT chunks, so the decoder must join them.
  const cut = Math.max(1, z.length >> 1);
  parts.push(chunk("IDAT", z.subarray(0, cut)), chunk("IDAT", z.subarray(cut)), chunk("IEND", Buffer.alloc(0)));
  return Buffer.concat(parts);
}

/** A deterministic pseudo-random integer source (mulberry32). */
export function prng(seed) {
  let s = seed >>> 0;
  return (n) => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) % n);
  };
}

/** A width × height image of random samples for a colour type and depth, every filter type in turn. */
export function randomPng({ width, height, colorType, bitDepth, seed = 1, filters = [0, 1, 2, 3, 4], palette = null, trns = null }) {
  const rnd = prng(seed);
  const max = colorType === 3 ? palette.length : 2 ** bitDepth;
  const samples = Array.from({ length: height }, () => Array.from({ length: width * CHANNELS[colorType] }, () => rnd(max)));
  return { samples, png: encodePng({ width, height, colorType, bitDepth, samples, filters, palette, trns }) };
}

/** What a decoder must produce for `samples`: RGBA bytes (16-bit → high byte; sub-byte grey scaled; tRNS applied). */
export function expectedRgba({ width, height, colorType, bitDepth, samples, palette = null, trns = null }) {
  const out = new Uint8Array(width * height * 4);
  const ch = CHANNELS[colorType];
  const to8 = (v) => (bitDepth === 16 ? Math.floor(v / 256) : bitDepth === 8 ? v : Math.round((v * 255) / (2 ** bitDepth - 1)));
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const s = samples[y].slice(x * ch, x * ch + ch);
      const o = (y * width + x) * 4;
      let px;
      if (colorType === 0) px = [to8(s[0]), to8(s[0]), to8(s[0]), trns && s[0] === trns.readUInt16BE(0) ? 0 : 255];
      else if (colorType === 2) px = [to8(s[0]), to8(s[1]), to8(s[2]), trns && s[0] === trns.readUInt16BE(0) && s[1] === trns.readUInt16BE(2) && s[2] === trns.readUInt16BE(4) ? 0 : 255];
      else if (colorType === 3) px = [...palette[s[0]], trns && s[0] < trns.length ? trns[s[0]] : 255];
      else if (colorType === 4) px = [to8(s[0]), to8(s[0]), to8(s[0]), to8(s[1])];
      else px = s.map(to8);
      out.set(px, o);
    }
  }
  return out;
}
