// SPDX-License-Identifier: Apache-2.0
// A folder or several files as one stored zip, made in the browser (SPEC §2).

/**
 * The browser's port of `cli/src/zip.mjs`, for the one endpoint that takes a
 * page with its files: a folder, or files dropped together, go up as a single
 * `.zip` exactly as the CLI sends them. Stored, never deflated, because
 * pictures, video and fonts are compressed already and the server reads a
 * stored archive for free. Deterministic: a fixed 1980-01-01 timestamp and
 * fixed attributes. `tools/fixtures/zip-vectors.json` pins both writers to the
 * same bytes, so neither can drift (`zip.test.ts`). The app's dependency
 * budget is spent, and this is 90 lines.
 */

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const END = 0x06054b50;
const VERSION_NEEDED = 10;
const MADE_BY = (3 << 8) | 20;
const UTF8 = 0x0800;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;
const FILE_MODE = 0o100644;

let TABLE: Uint32Array | null = null;

/** CRC-32 (IEEE 802.3, reflected), the checksum every zip entry carries. */
export function crc32(bytes: Uint8Array): number {
  if (!TABLE) {
    TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      TABLE[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) c = TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A stored zip of `entries`, files only, in the order given. */
export function storedZip(entries: readonly ZipEntry[]): Uint8Array {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBytes = encoder.encode(name);
    if (data.length >= 0xffffffff || nameBytes.length > 0xffff) throw new Error(`zip: ${name} is too large for a zip without ZIP64`);
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, LOCAL, true);
    local.setUint16(4, VERSION_NEEDED, true);
    local.setUint16(6, UTF8, true);
    local.setUint16(12, DOS_DATE, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, nameBytes.length, true);
    parts.push(new Uint8Array(local.buffer), nameBytes, data);

    const central = new DataView(new ArrayBuffer(46));
    central.setUint32(0, CENTRAL, true);
    central.setUint16(4, MADE_BY, true);
    central.setUint16(6, VERSION_NEEDED, true);
    central.setUint16(8, UTF8, true);
    central.setUint16(14, DOS_DATE, true);
    central.setUint32(16, crc, true);
    central.setUint32(20, data.length, true);
    central.setUint32(24, data.length, true);
    central.setUint16(28, nameBytes.length, true);
    central.setUint32(38, (FILE_MODE << 16) >>> 0, true);
    central.setUint32(42, offset, true);
    centrals.push(new Uint8Array(central.buffer), nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const directoryLength = centrals.reduce((n, p) => n + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, END, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, directoryLength, true);
  end.setUint32(16, offset, true);
  const all = [...parts, ...centrals, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of all) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
