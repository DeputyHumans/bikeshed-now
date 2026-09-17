// SPDX-License-Identifier: Apache-2.0
// Upload bundles are the one place attacker-controlled paths enter Storage (SPEC §2, §11).

const test = require("node:test");
const assert = require("node:assert/strict");
const AdmZip = require("adm-zip");
const { crc32 } = require("node:zlib");

const {
  extractBundle,
  isUploadableName,
  safeBundleRelPath,
  zipBundle,
} = require("../lib/lib/bundle.js");

const MAX = 25 * 1024 * 1024;
const NUL = String.fromCharCode(0);


/**
 * Build a ZIP byte-for-byte, with no library in the way.
 *
 * adm-zip NORMALIZES an entry name as it writes, so `zip.addFile("../evil")`
 * silently becomes `evil` and a test built that way asserts nothing. A real
 * attacker writes the bytes; so does this.
 */
function rawZip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = Buffer.from(entry.data ?? "");
    const crc = crc32(data);
    // `declaredSize` lets a test lie about the uncompressed size, which is the
    // exact shape the zip-bomb guard exists to catch.
    const declared = entry.declaredSize ?? data.length;

    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(declared, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    locals.push(local, data);

    const cd = Buffer.alloc(46 + name.length);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(declared, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(offset, 42);
    name.copy(cd, 46);
    central.push(cd);

    offset += local.length + data.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, end]);
}

function zipOf(entries) {
  const zip = new AdmZip();
  for (const [name, content] of entries) zip.addFile(name, Buffer.from(content));
  return zip.toBuffer();
}

test("rejects every traversal shape", () => {
  for (const bad of [
    "../escape.html",
    "a/../../escape.html",
    "/absolute.html",
    "a\\b.html",
    "a//b.html",
    "a/./b.html",
    "trailing/",
    "",
  ]) {
    assert.equal(safeBundleRelPath(bad), null, `should reject ${JSON.stringify(bad)}`);
  }
  assert.equal(safeBundleRelPath("a/b/c.html"), "a/b/c.html");
});

test("rejects a NUL byte in a path", () => {
  assert.equal(safeBundleRelPath(`a${NUL}b.html`), null);
});

test("a zip carrying a traversal entry is refused before any write", () => {
  for (const name of ["../evil.html", "a/../../evil.html", "/etc/passwd"]) {
    const result = extractBundle(rawZip([{ name, data: "x" }]), "b.zip", MAX);
    assert.ok("error" in result, `${name} should be refused`);
    assert.match(result.error, /unsafe path/);
  }
});

test("a backslash entry name cannot smuggle a second segment", () => {
  const result = extractBundle(
    rawZip([{ name: "a\\..\\..\\evil.html", data: "x" }]),
    "b.zip",
    MAX,
  );
  assert.ok("error" in result);
});

test("an entry declaring size 0 while carrying real bytes is refused", () => {
  // adm-zip allocates a Buffer of the DECLARED size and its inflater only bounds
  // output when that size is greater than zero, so a spoofed zero would
  // decompress unbounded. A genuinely empty file compresses to a handful of
  // bytes, which is why the guard triggers above 64.
  const result = extractBundle(
    rawZip([{ name: "index.html", data: "x".repeat(4096), declaredSize: 0 }]),
    "b.zip",
    MAX,
  );
  assert.ok("error" in result);
  assert.match(result.error, /suspicious entry size/);
});

test("an entry declaring more than the cap is refused before decompressing", () => {
  const result = extractBundle(
    rawZip([{ name: "index.html", data: "x", declaredSize: 50_000_000 }]),
    "b.zip",
    MAX,
  );
  assert.ok("error" in result);
  assert.match(result.error, /too large/);
});

test("a genuinely empty entry is accepted", () => {
  const result = extractBundle(
    rawZip([
      { name: "index.html", data: "<p>x</p>" },
      { name: "empty.css", data: "" },
    ]),
    "b.zip",
    MAX,
  );
  assert.ok(!("error" in result));
  assert.equal(result.files.length, 2);
});

test("a single HTML upload is normalized to index.html", () => {
  const result = extractBundle(Buffer.from("<p>hi</p>"), "My Deck.html", MAX);
  assert.deepEqual(
    result.files.map((f) => f.rel),
    ["index.html"],
  );
  assert.equal(result.entry, "index.html");
  assert.equal(result.format, "html");
});

test("a Markdown upload is recognized as Markdown", () => {
  const result = extractBundle(Buffer.from("# Title\n"), "notes.md", MAX);
  assert.equal(result.entry, "index.md");
  assert.equal(result.format, "markdown");
});

test("an unknown extension is refused with actionable wording", () => {
  const result = extractBundle(Buffer.from("x"), "report.docx", MAX);
  assert.ok("error" in result);
  assert.match(result.error, /\.html.*\.md.*\.zip/s);
});

test("a mislabelled zip is sniffed by magic bytes", () => {
  const result = extractBundle(zipOf([["index.html", "<p>x</p>"]]), "bundle.html", MAX);
  assert.equal(result.entry, "index.html");
  assert.equal(result.files.length, 1);
});

test("a shared top-level directory is stripped", () => {
  const result = extractBundle(
    zipOf([
      ["deck/index.html", "<p>x</p>"],
      ["deck/assets/style.css", "body{}"],
    ]),
    "b.zip",
    MAX,
  );
  assert.deepEqual(result.files.map((f) => f.rel).sort(), [
    "assets/style.css",
    "index.html",
  ]);
});

test("a shared directory is NOT stripped when a root entry already exists", () => {
  const result = extractBundle(
    zipOf([
      ["index.html", "<p>root</p>"],
      ["deck/index.html", "<p>nested</p>"],
    ]),
    "b.zip",
    MAX,
  );
  assert.ok(result.files.some((f) => f.rel === "deck/index.html"));
  assert.equal(result.entry, "index.html");
});

test("macOS and Windows junk is dropped", () => {
  const result = extractBundle(
    zipOf([
      ["index.html", "<p>x</p>"],
      ["__MACOSX/._index.html", "junk"],
      [".DS_Store", "junk"],
      ["Thumbs.db", "junk"],
    ]),
    "b.zip",
    MAX,
  );
  assert.deepEqual(
    result.files.map((f) => f.rel),
    ["index.html"],
  );
});

test("HTML wins over Markdown when a bundle ships both", () => {
  // A bundle carrying both has already been compiled; re-rendering the source
  // would discard whatever the author did to the HTML.
  const result = extractBundle(
    zipOf([
      ["index.md", "# x"],
      ["index.html", "<h1>x</h1>"],
    ]),
    "b.zip",
    MAX,
  );
  assert.equal(result.entry, "index.html");
  assert.equal(result.format, "html");
});

test("a zip with no usable entry is refused", () => {
  const result = extractBundle(zipOf([["notes.txt", "hello"]]), "b.zip", MAX);
  assert.ok("error" in result);
  assert.match(result.error, /no index\.html/);
});

test("an empty upload is refused", () => {
  assert.ok("error" in extractBundle(Buffer.alloc(0), "x.html", MAX));
});

test("an oversized upload is refused before extraction", () => {
  const result = extractBundle(Buffer.from("x".repeat(100)), "x.html", 10);
  assert.ok("error" in result);
  assert.match(result.error, /too large/);
});

test("the byte cap is enforced across entries, not per entry", () => {
  const result = extractBundle(
    zipOf([
      ["index.html", "x".repeat(600)],
      ["a.css", "y".repeat(600)],
    ]),
    "b.zip",
    1000,
  );
  assert.ok("error" in result);
  assert.match(result.error, /too large/);
});

test("round-trips through zipBundle", () => {
  const buffer = zipBundle([
    { rel: "index.html", data: Buffer.from("<p>x</p>") },
    { rel: "assets/a.css", data: Buffer.from("body{}") },
  ]);
  const back = extractBundle(buffer, "b.zip", MAX);
  assert.deepEqual(back.files.map((f) => f.rel).sort(), ["assets/a.css", "index.html"]);
});

test("the uploadable-name predicate matches the server's accepted set", () => {
  for (const ok of ["a.html", "a.htm", "a.md", "a.markdown", "a.zip", "A.HTML"]) {
    assert.ok(isUploadableName(ok), ok);
  }
  for (const no of ["a.txt", "a.pdf", "a"]) {
    assert.ok(!isUploadableName(no), no);
  }
});
