// SPDX-License-Identifier: Apache-2.0
// A small ZIP reader (stored and deflate) for downloaded bundles, so REHASH needs no dependency (SPEC §9.1).

/**
 * `GET /download/<doc>/<v>` answers with an archive made by adm-zip, which
 * DEFLATES; `tools/zip.mjs` only reads stored archives, on purpose, because it
 * guards a deploy. This one reads both, through `zlib.inflateRawSync`, and is
 * strict where leniency would let a wrong hash pass:
 *
 *   - sizes and offsets come from the CENTRAL directory, never the local header
 *     (a local header may defer them to a data descriptor, bit 3);
 *   - every entry's CRC-32 and uncompressed size are checked;
 *   - ZIP64, encryption, split archives and any method but 0 and 8 are refused;
 *   - a name that would escape the archive (`..`, absolute) is refused.
 *
 * Directory entries (a name ending in `/`) are returned with `dir: true` and
 * empty data; `files()` leaves them out, which is what the content hash wants.
 */

import { crc32, inflateRawSync } from "node:zlib";

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const END = 0x06054b50;
const LOCAL_SIZE = 30;
const CENTRAL_SIZE = 46;
const END_SIZE = 22;
const STORED = 0;
const DEFLATE = 8;

function fail(message) {
  const err = new Error(`zipread: ${message}`);
  err.code = "E2E_ZIP";
  return err;
}

function need(buf, at, size, what) {
  if (at < 0 || at + size > buf.length) throw fail(`${what} runs past the end`);
}

function findEnd(buf) {
  if (buf.length < END_SIZE) throw fail("too short to be a zip");
  const floor = Math.max(0, buf.length - END_SIZE - 0xffff);
  for (let at = buf.length - END_SIZE; at >= floor; at -= 1) {
    if (buf.readUInt32LE(at) === END && at + END_SIZE + buf.readUInt16LE(at + 20) === buf.length) return at;
  }
  throw fail("no end-of-central-directory record");
}

function safeName(name) {
  if (name.length === 0) throw fail("an entry has an empty name");
  if (name.startsWith("/") || /^[A-Za-z]:/.test(name) || name.includes("\\")) throw fail(`absolute or backslashed name refused: ${name}`);
  if (name.split("/").some((seg) => seg === "..")) throw fail(`a name escaping the archive is refused: ${name}`);
  return name;
}

/**
 * Every entry of a zip, in central-directory order:
 * `{ name, data, dir, method, crc, compressedSize, size }`.
 */
export function readZip(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const end = findEnd(buf);
  const disk = buf.readUInt16LE(end + 4);
  const startDisk = buf.readUInt16LE(end + 6);
  const onDisk = buf.readUInt16LE(end + 8);
  const count = buf.readUInt16LE(end + 10);
  const size = buf.readUInt32LE(end + 12);
  const start = buf.readUInt32LE(end + 16);
  if (disk !== 0 || startDisk !== 0 || onDisk !== count) throw fail("split archives are refused");
  if (count === 0xffff || size === 0xffffffff || start === 0xffffffff) throw fail("ZIP64 is refused");
  if (start + size > end) throw fail("the central directory overlaps the end record");

  const entries = [];
  let at = start;
  for (let i = 0; i < count; i += 1) {
    need(buf, at, CENTRAL_SIZE, "a central directory entry");
    if (buf.readUInt32LE(at) !== CENTRAL) throw fail("bad central directory signature");
    const flags = buf.readUInt16LE(at + 8);
    const method = buf.readUInt16LE(at + 10);
    const crc = buf.readUInt32LE(at + 16);
    const compressedSize = buf.readUInt32LE(at + 20);
    const uncompressed = buf.readUInt32LE(at + 24);
    const nameLength = buf.readUInt16LE(at + 28);
    const extraLength = buf.readUInt16LE(at + 30);
    const commentLength = buf.readUInt16LE(at + 32);
    const localAt = buf.readUInt32LE(at + 42);
    need(buf, at + CENTRAL_SIZE, nameLength, "an entry name");
    const name = safeName(buf.subarray(at + CENTRAL_SIZE, at + CENTRAL_SIZE + nameLength).toString("utf8"));
    if (flags & 0x0001) throw fail(`encrypted entry refused: ${name}`);
    if (compressedSize === 0xffffffff || uncompressed === 0xffffffff || localAt === 0xffffffff) throw fail("ZIP64 is refused");
    if (method !== STORED && method !== DEFLATE) throw fail(`compression method ${method} refused in ${name}`);

    need(buf, localAt, LOCAL_SIZE, "a local header");
    if (buf.readUInt32LE(localAt) !== LOCAL) throw fail(`bad local header signature for ${name}`);
    if (buf.readUInt16LE(localAt + 8) !== method) throw fail(`local and central methods differ for ${name}`);
    const localNameLength = buf.readUInt16LE(localAt + 26);
    const localExtraLength = buf.readUInt16LE(localAt + 28);
    const dataAt = localAt + LOCAL_SIZE + localNameLength + localExtraLength;
    need(buf, dataAt, compressedSize, `data of ${name}`);
    const raw = buf.subarray(dataAt, dataAt + compressedSize);

    const dir = name.endsWith("/");
    let data;
    if (method === STORED) {
      if (compressedSize !== uncompressed) throw fail(`stored entry ${name} has two different sizes`);
      data = Buffer.from(raw);
    } else {
      data = inflateRawSync(raw);
    }
    if (data.length !== uncompressed) throw fail(`${name}: inflated to ${data.length} bytes, directory says ${uncompressed}`);
    if ((crc32(data) >>> 0) !== crc) throw fail(`checksum mismatch in ${name}`);
    if (dir && data.length > 0) throw fail(`directory entry ${name} carries data`);

    entries.push({ name, data, dir, method, crc, compressedSize, size: uncompressed });
    at += CENTRAL_SIZE + nameLength + extraLength + commentLength;
  }
  if (at !== start + size) throw fail("the central directory has bytes no entry accounts for");
  return entries;
}

/** The files of a zip (no directory entries) as `{ rel, data }`, the shape hashBundleFiles takes. */
export function zipFiles(input) {
  return readZip(input)
    .filter((e) => !e.dir)
    .map((e) => ({ rel: e.name, data: e.data }));
}
