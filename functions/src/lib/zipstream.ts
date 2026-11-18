// SPDX-License-Identifier: Apache-2.0
// A large version's download: one stored zip, built once into Storage, streamed through and never held whole (SPEC §2, §24).

/**
 * Why it is built into Storage rather than streamed to the reader
 * ---------------------------------------------------------------
 * A version can be 500 MB, and Hosting cuts a function's response at 60 s.
 * So a download over 25 MB is written once, for those bytes, to
 * `downloads/{docId}/{contentHash}.zip`, and the reader is sent there by a
 * short-lived signed link, as a video is (`lib/medialink.ts`). The name is
 * the content hash, not the version, because a withdrawn version's name is
 * minted again for different bytes. The bucket's lifecycle rule removes built
 * zips after a day; the next download builds one again.
 *
 * The zip is stored, never deflated: pictures, video and fonts gain nothing,
 * and a stored zip is a header, the bytes and a directory. Each entry's CRC
 * and sizes go in its local header, which every reader accepts, so each file
 * is read twice: once for its CRC, once to copy it. Nothing is held in memory
 * but one chunk. 500 MB and 2,000 entries are far inside a zip without ZIP64,
 * and a field that would overflow throws rather than lie.
 */

import { crc32 } from "node:zlib";
import { once } from "node:events";
import type { Writable } from "node:stream";

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const END = 0x06054b50;
const VERSION_NEEDED = 10;
const MADE_BY = (3 << 8) | 20;
const UTF8 = 0x0800;
const FILE_MODE = 0o100644;
const MAX32 = 0xffffffff;

export interface ZipSource {
  rel: string;
  size: number;
  /** Each call streams the file's bytes from the start. */
  open(): NodeJS.ReadableStream;
}

/** MS-DOS date and time for a moment, as zip entries carry them. */
export function dosTime(at: Date): { date: number; time: number } {
  const year = Math.max(1980, at.getUTCFullYear());
  return {
    date: ((year - 1980) << 9) | ((at.getUTCMonth() + 1) << 5) | at.getUTCDate(),
    time: (at.getUTCHours() << 11) | (at.getUTCMinutes() << 5) | Math.floor(at.getUTCSeconds() / 2),
  };
}

async function crcOf(source: ZipSource): Promise<number> {
  let crc = 0;
  let seen = 0;
  for await (const chunk of source.open() as AsyncIterable<Buffer>) {
    crc = crc32(chunk, crc);
    seen += chunk.length;
  }
  if (seen !== source.size) throw new Error(`zip: ${source.rel} is ${seen} bytes, not ${source.size}`);
  return crc >>> 0;
}

async function write(out: Writable, bytes: Buffer): Promise<void> {
  if (!out.write(bytes)) await once(out, "drain");
}

/**
 * Write a stored zip of `sources` to `out`, in order, and end it. Returns the
 * zip's length. `at` dates every entry: the version's publication.
 */
export async function writeStoredZip(out: Writable, sources: readonly ZipSource[], at: Date): Promise<number> {
  if (sources.length >= 0xffff) throw new Error("zip: too many entries for a zip without ZIP64");
  const { date, time } = dosTime(at);
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const source of sources) {
    const name = Buffer.from(source.rel, "utf8");
    if (source.size >= MAX32 || name.length > 0xffff) throw new Error(`zip: ${source.rel} is too large for a zip without ZIP64`);
    const crc = await crcOf(source);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL, 0);
    local.writeUInt16LE(VERSION_NEEDED, 4);
    local.writeUInt16LE(UTF8, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(source.size, 18);
    local.writeUInt32LE(source.size, 22);
    local.writeUInt16LE(name.length, 26);
    await write(out, Buffer.concat([local, name]));
    let copied = 0;
    for await (const chunk of source.open() as AsyncIterable<Buffer>) {
      copied += chunk.length;
      await write(out, chunk);
    }
    if (copied !== source.size) throw new Error(`zip: ${source.rel} changed while it was copied`);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL, 0);
    central.writeUInt16LE(MADE_BY, 4);
    central.writeUInt16LE(VERSION_NEEDED, 6);
    central.writeUInt16LE(UTF8, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(source.size, 20);
    central.writeUInt32LE(source.size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((FILE_MODE << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + source.size;
    if (offset >= MAX32) throw new Error("zip: too large for a zip without ZIP64");
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END, 0);
  end.writeUInt16LE(sources.length, 8);
  end.writeUInt16LE(sources.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  await write(out, Buffer.concat([directory, end]));
  out.end();
  await once(out, "finish");
  return offset + directory.length + end.length;
}

/** Where a version's large download is kept, by its bytes. */
export function downloadKey(docId: string, contentHash: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(docId) || !/^[0-9a-f]{64}$/.test(contentHash)) throw new Error("invalid download");
  return `downloads/${docId}/${contentHash}.zip`;
}
