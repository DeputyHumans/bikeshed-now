// SPDX-License-Identifier: Apache-2.0
// The stored zip writer: its checksum, its bytes, and what its reader refuses (SPEC §19).

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import zlib from "node:zlib";

import { crc32, readStoredZip, storedZip } from "./zip.mjs";

const SKILL = Buffer.from("---\nname: demo\ndescription: Use when testing — with UTF-8.\n---\n\nBody\n");

function demo() {
  return storedZip([{ name: "demo/" }, { name: "demo/SKILL.md", data: SKILL }]);
}

test("crc32 is the IEEE checksum, by its check value and by zlib's", () => {
  // 0xCBF43926 is the published check value for "123456789". zlib's is a
  // second implementation, so the two cannot drift together.
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
  assert.equal(typeof zlib.crc32, "function", "this Node has no zlib.crc32 to compare against");
  for (const sample of [Buffer.alloc(0), Buffer.from([0xff]), SKILL, Buffer.alloc(70000, 0xa5)]) {
    assert.equal(crc32(sample), zlib.crc32(sample));
  }
});

test("the same entries always pack to the same bytes", () => {
  const a = demo();
  const b = demo();
  assert.equal(a.equals(b), true);
  // Pinned because the clock is the likeliest thing to leak in: 00:00 on
  // 1980-01-01 in both the local header (offset 10) and the central one.
  assert.equal(a.readUInt16LE(10), 0);
  assert.equal(a.readUInt16LE(12), 0x0021);
  const central = a.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  assert.equal(a.readUInt16LE(central + 12), 0);
  assert.equal(a.readUInt16LE(central + 14), 0x0021);
  // The whole archive, pinned after `unzip -t` and `zipinfo` read these exact
  // bytes as two stored Unix entries dated 1980-01-01 00:00. A change to any
  // header field fails here before it reaches a deployment's downloads.
  assert.equal(
    createHash("sha256").update(a).digest("hex"),
    "a7837792baeb334395be99bac9210904a2793af24968975501fe0f1638b5a4f2",
  );
});

test("entries are stored, UTF-8 named and Unix-moded", () => {
  const zip = demo();
  const central = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  assert.equal(zip.readUInt16LE(central + 4) >> 8, 3, "made by Unix");
  assert.equal(zip.readUInt16LE(central + 8) & 0x0800, 0x0800, "UTF-8 flag");
  assert.equal(zip.readUInt16LE(central + 10), 0, "stored");
  assert.equal(zip.readUInt32LE(central + 38) >>> 16, 0o040755, "the folder is drwxr-xr-x");
  const second = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), central + 4);
  assert.equal(zip.readUInt32LE(second + 38) >>> 16, 0o100644, "the file is -rw-r--r--");
  // Stored, so the text is in the archive as-is: CI greps app/dist for an
  // unstamped placeholder, and a deflated archive would hide one from it.
  assert.notEqual(zip.indexOf(SKILL), -1);
});

test("what is written reads back", () => {
  const entries = readStoredZip(demo());
  assert.deepEqual(
    entries.map((e) => e.name),
    ["demo/", "demo/SKILL.md"],
  );
  assert.equal(entries[0].data.length, 0);
  assert.equal(entries[1].data.equals(SKILL), true);
});

test("a flipped byte is refused, not read", () => {
  const zip = demo();
  const at = zip.indexOf(SKILL) + 5;
  zip[at] ^= 0x01;
  assert.throws(() => readStoredZip(zip), /checksum mismatch/);
});

test("anything but a stored entry is refused", () => {
  const zip = demo();
  // Method 8 (deflate) in both headers of the first entry, CRC left intact.
  zip.writeUInt16LE(8, 8);
  const central = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  zip.writeUInt16LE(8, central + 10);
  assert.throws(() => readStoredZip(zip), /method 8 is refused/);
});

test("a truncated archive is refused", () => {
  assert.throws(() => readStoredZip(demo().subarray(0, 40)), /end-of-central-directory/);
  assert.throws(() => readStoredZip(Buffer.from("not a zip")), /too short|end-of-central/);
});
