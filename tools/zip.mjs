// SPDX-License-Identifier: Apache-2.0
// A stored (uncompressed) zip writer and reader for the skill downloads (SPEC §19)

/**
 * Why a zip writer of our own, and why it never compresses.
 *
 * Claude's skill upload takes a `.zip` holding one folder with a `SKILL.md`
 * in it. The served copy of each skill is stamped with the deployment's origin
 * at build time, so its zip has to be built at build time too, from the stamped
 * bytes. The tools have no runtime dependencies, and two entries in an archive
 * nobody extracts more than once are not worth one.
 *
 * Stored, never deflated, for one reason: CI runs `grep -rqF '<deployment>'`
 * over `app/dist`, and that only sees inside an archive whose entries are the
 * plain bytes. A deflated zip would hide an unstamped placeholder from it.
 *
 * Deterministic on purpose: a fixed 1980-01-01 00:00 timestamp, fixed
 * attributes, no extra fields and no comment, so the same skill always packs to
 * the same bytes and a rebuild never looks like a change.
 *
 * No shebang. Vite bundles `app/vite.config.ts` and everything it imports,
 * which puts a preamble ahead of line 1 (see `tools/stamp-deployment.mjs`).
 */

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const END = 0x06054b50;

const VERSION_NEEDED = 10; // 1.0: stored entries and directories
const MADE_BY = (3 << 8) | 20; // high byte 3 = Unix, so the attributes below are read as a mode
const UTF8 = 0x0800; // general-purpose bit 11: names are UTF-8
const STORED = 0;

// MS-DOS date for 1980-01-01, the earliest a zip can say: year 0, month 1, day 1.
const DOS_DATE = (0 << 9) | (1 << 5) | 1;
const DOS_TIME = 0;

const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const DOS_DIRECTORY = 0x10;

const LOCAL_SIZE = 30;
const CENTRAL_SIZE = 46;
const END_SIZE = 22;

let TABLE = null;

function table() {
  if (TABLE) return TABLE;
  TABLE = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    TABLE[n] = c >>> 0;
  }
  return TABLE;
}

/** CRC-32 (IEEE 802.3, reflected), the checksum every zip entry carries. */
export function crc32(bytes) {
  const t = table();
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) c = t[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * A zip of `entries`, in the order given. A name ending in `/` is a directory
 * and carries no data; anything else is a file whose `data` is a Buffer.
 */
export function storedZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const { name, data } of entries) {
    const isDir = name.endsWith("/");
    const body = isDir ? Buffer.alloc(0) : Buffer.from(data ?? Buffer.alloc(0));
    if (isDir && data && data.length > 0) {
      throw new Error(`zip: a directory carries no data: ${name}`);
    }
    const nameBytes = Buffer.from(name, "utf8");
    const crc = crc32(body);
    // ZIP64 is deliberately absent: nothing here comes near 4 GiB or 65,535
    // entries, and refusing is better than writing a header that lies.
    if (body.length >= 0xffffffff || nameBytes.length > 0xffff) {
      throw new Error(`zip: ${name} is too large for a zip without ZIP64`);
    }

    const local = Buffer.alloc(LOCAL_SIZE);
    local.writeUInt32LE(LOCAL, 0);
    local.writeUInt16LE(VERSION_NEEDED, 4);
    local.writeUInt16LE(UTF8, 6);
    local.writeUInt16LE(STORED, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBytes, body);

    const mode = isDir ? S_IFDIR | 0o755 : S_IFREG | 0o644;
    const central = Buffer.alloc(CENTRAL_SIZE);
    central.writeUInt32LE(CENTRAL, 0);
    central.writeUInt16LE(MADE_BY, 4);
    central.writeUInt16LE(VERSION_NEEDED, 6);
    central.writeUInt16LE(UTF8, 8);
    central.writeUInt16LE(STORED, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(body.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attributes
    // The mode in the high half for Unix extractors; the MS-DOS directory bit
    // in the low half for the ones that read only that.
    central.writeUInt32LE(((mode << 16) | (isDir ? DOS_DIRECTORY : 0)) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);

    offset += LOCAL_SIZE + nameBytes.length + body.length;
  }

  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(END_SIZE);
  end.writeUInt32LE(END, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, directory, end]);
}

function need(buf, at, size, what) {
  if (at < 0 || at + size > buf.length) throw new Error(`zip: ${what} runs past the end`);
}

/**
 * The entries of a stored zip, as `{ name, data }`, in central-directory order.
 *
 * Strict where a general reader is lenient, because its job is the deploy gate:
 * anything compressed, encrypted, split, ZIP64 or with a checksum that does not
 * match is refused rather than read around.
 */
export function readStoredZip(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (buf.length < END_SIZE) throw new Error("zip: too short to be a zip");

  // The end record sits after a comment of up to 65,535 bytes; find it from the
  // back, and accept it only where its comment length lands exactly on the end.
  let end = -1;
  for (let at = buf.length - END_SIZE; at >= Math.max(0, buf.length - END_SIZE - 0xffff); at -= 1) {
    if (buf.readUInt32LE(at) === END && at + END_SIZE + buf.readUInt16LE(at + 20) === buf.length) {
      end = at;
      break;
    }
  }
  if (end < 0) throw new Error("zip: no end-of-central-directory record");

  const disk = buf.readUInt16LE(end + 4);
  const startDisk = buf.readUInt16LE(end + 6);
  const onDisk = buf.readUInt16LE(end + 8);
  const count = buf.readUInt16LE(end + 10);
  const size = buf.readUInt32LE(end + 12);
  const start = buf.readUInt32LE(end + 16);
  if (disk !== 0 || startDisk !== 0 || onDisk !== count) throw new Error("zip: split archives are refused");
  if (count === 0xffff || size === 0xffffffff || start === 0xffffffff) {
    throw new Error("zip: ZIP64 is refused");
  }
  if (start + size !== end) throw new Error("zip: the central directory is not where the end record says");

  const entries = [];
  let at = start;
  for (let i = 0; i < count; i += 1) {
    need(buf, at, CENTRAL_SIZE, "a central directory entry");
    if (buf.readUInt32LE(at) !== CENTRAL) throw new Error("zip: bad central directory signature");
    const flags = buf.readUInt16LE(at + 8);
    const method = buf.readUInt16LE(at + 10);
    const crc = buf.readUInt32LE(at + 16);
    const compressed = buf.readUInt32LE(at + 20);
    const uncompressed = buf.readUInt32LE(at + 24);
    const nameLength = buf.readUInt16LE(at + 28);
    const extraLength = buf.readUInt16LE(at + 30);
    const commentLength = buf.readUInt16LE(at + 32);
    const localAt = buf.readUInt32LE(at + 42);
    need(buf, at + CENTRAL_SIZE, nameLength, "an entry name");
    const nameBytes = buf.subarray(at + CENTRAL_SIZE, at + CENTRAL_SIZE + nameLength);

    if (method !== STORED) throw new Error(`zip: compression method ${method} is refused; only stored (0) is read`);
    if (flags & 0x0001) throw new Error("zip: encrypted entries are refused");
    if (compressed !== uncompressed) throw new Error("zip: a stored entry's two sizes differ");
    if (!(flags & UTF8) && nameBytes.some((b) => b > 0x7f)) {
      throw new Error("zip: a non-ASCII name without the UTF-8 flag is refused");
    }

    need(buf, localAt, LOCAL_SIZE, "a local header");
    if (buf.readUInt32LE(localAt) !== LOCAL) throw new Error("zip: bad local header signature");
    if (buf.readUInt16LE(localAt + 8) !== method) throw new Error("zip: local and central methods differ");
    const localNameLength = buf.readUInt16LE(localAt + 26);
    const localExtraLength = buf.readUInt16LE(localAt + 28);
    need(buf, localAt + LOCAL_SIZE, localNameLength, "a local name");
    const localName = buf.subarray(localAt + LOCAL_SIZE, localAt + LOCAL_SIZE + localNameLength);
    if (!localName.equals(nameBytes)) throw new Error("zip: local and central names differ");

    const dataAt = localAt + LOCAL_SIZE + localNameLength + localExtraLength;
    need(buf, dataAt, compressed, "entry data");
    const data = Buffer.from(buf.subarray(dataAt, dataAt + compressed));
    if (crc32(data) !== crc) throw new Error(`zip: checksum mismatch in ${nameBytes.toString("utf8")}`);

    entries.push({ name: nameBytes.toString("utf8"), data });
    at += CENTRAL_SIZE + nameLength + extraLength + commentLength;
  }
  if (at !== end) throw new Error("zip: the central directory has bytes no entry accounts for");
  return entries;
}
