// SPDX-License-Identifier: Apache-2.0
// Self-test: the e2e ZIP reader round-trips the repo's stored writer and the product's deflating one, and refuses damage (SPEC §9.1).

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";
import { REPO_ROOT } from "../lib/paths.mjs";
import { readZip, zipFiles } from "../lib/zipread.mjs";
import { storedZip } from "../../tools/zip.mjs";

const HTML = Buffer.from("<!DOCTYPE html>\n<html><body><p id=\"1\">Grüße — ünïcode</p></body></html>\n");
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3, 255, 254]);

/** A minimal deflate zip writer, test-only, with an optional data descriptor (bit 3). */
function deflateZip(entries, { descriptor = false } = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const body = deflateRawSync(data);
    const crc = crc32(data) >>> 0;
    const flags = 0x0800 | (descriptor ? 0x0008 : 0);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(descriptor ? 0 : crc, 14);
    local.writeUInt32LE(descriptor ? 0 : body.length, 18);
    local.writeUInt32LE(descriptor ? 0 : data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const parts = [local, nameBuf, body];
    if (descriptor) {
      const dd = Buffer.alloc(16);
      dd.writeUInt32LE(0x08074b50, 0);
      dd.writeUInt32LE(crc, 4);
      dd.writeUInt32LE(body.length, 8);
      dd.writeUInt32LE(data.length, 12);
      parts.push(dd);
    }
    locals.push(...parts);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += parts.reduce((n, p) => n + p.length, 0);
  }
  const dir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

test("reads a stored zip made by the repo's tools/zip.mjs, directories included", () => {
  const zip = storedZip([{ name: "assets/" }, { name: "index.html", data: HTML }, { name: "assets/x.png", data: PNG }]);
  const entries = readZip(zip);
  assert.deepEqual(entries.map((e) => [e.name, e.dir, e.method]), [["assets/", true, 0], ["index.html", false, 0], ["assets/x.png", false, 0]]);
  assert.ok(entries[1].data.equals(HTML));
  assert.ok(entries[2].data.equals(PNG));
  assert.deepEqual(zipFiles(zip).map((f) => f.rel), ["index.html", "assets/x.png"], "zipFiles drops directory entries");
});

test("reads deflate entries, with and without a data descriptor", () => {
  for (const descriptor of [false, true]) {
    const files = zipFiles(deflateZip([{ name: "index.html", data: HTML }, { name: "a/b.bin", data: PNG }], { descriptor }));
    assert.ok(files[0].data.equals(HTML), `html (descriptor=${descriptor})`);
    assert.ok(files[1].data.equals(PNG), `png (descriptor=${descriptor})`);
  }
});

test("reads what the product's own writer (adm-zip in functions/) produces", (t) => {
  const pkg = join(REPO_ROOT, "functions", "package.json");
  if (!existsSync(join(REPO_ROOT, "functions", "node_modules", "adm-zip"))) return t.skip("functions/node_modules/adm-zip not installed");
  const AdmZip = createRequire(pkg)("adm-zip");
  const z = new AdmZip();
  const big = Buffer.from("<p>repeat</p>".repeat(5000));
  z.addFile("index.html", HTML);
  z.addFile("big.html", big);
  z.addFile("img/x.png", PNG);
  const entries = readZip(z.toBuffer());
  assert.ok(entries.some((e) => e.method === 8), "adm-zip deflated at least one entry, so the inflate path ran");
  const byName = Object.fromEntries(entries.map((e) => [e.name, e.data]));
  assert.ok(byName["index.html"].equals(HTML));
  assert.ok(byName["big.html"].equals(big));
  assert.ok(byName["img/x.png"].equals(PNG));
});

test("NEGATIVE: a flipped data byte fails the checksum; a cut archive and an escaping name are refused", () => {
  const zip = storedZip([{ name: "index.html", data: HTML }]);
  const bad = Buffer.from(zip);
  bad[30 + "index.html".length + 3] ^= 0xff;
  assert.throws(() => readZip(bad), /checksum mismatch/);
  assert.throws(() => readZip(zip.subarray(0, zip.length - 5)), /end-of-central-directory/);
  const evil = deflateZip([{ name: "../etc/passwd", data: HTML }]);
  assert.throws(() => readZip(evil), /escaping the archive/);
  const deflated = deflateZip([{ name: "index.html", data: HTML }]);
  const lie = Buffer.from(deflated);
  const central = lie.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  lie.writeUInt32LE(HTML.length + 1, central + 24); // directory claims one byte more
  assert.throws(() => readZip(lie), /inflated to/);
});
