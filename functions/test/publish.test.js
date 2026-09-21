// SPDX-License-Identifier: Apache-2.0
// compileBundle's title default: HTML's own <title>, else the caller's fallback; Markdown's H1 rule is unchanged (SPEC §11, §17).

const test = require("node:test");
const assert = require("node:assert/strict");

const { compileBundle } = require("../lib/lib/publish.js");
const { HEAD_SCAN_BYTES } = require("../lib/lib/head.js");

/** An extracted HTML bundle whose single file is the entry. */
function htmlBundle(entryHtml, entryRel = "index.html") {
  return {
    files: [{ rel: entryRel, data: Buffer.from(entryHtml, "utf8") }],
    entry: entryRel,
    format: "html",
  };
}

/** An extracted Markdown bundle whose single file is the entry. */
function markdownBundle(source, entryRel = "index.md") {
  return {
    files: [{ rel: entryRel, data: Buffer.from(source, "utf8") }],
    entry: entryRel,
    format: "markdown",
  };
}

test("an HTML upload's own <title> becomes the document title", () => {
  const html =
    "<!DOCTYPE html><html><head><title>From The File</title></head><body><p>hi</p></body></html>";
  const compiled = compileBundle(htmlBundle(html), "from-filename");
  assert.equal(compiled.title, "From The File");
});

test("an HTML upload with no <title> falls back to the caller's title", () => {
  const html = "<!DOCTYPE html><html><head></head><body><p>hi</p></body></html>";
  const compiled = compileBundle(htmlBundle(html), "from-filename");
  assert.equal(compiled.title, "from-filename");
});

test("a Markdown upload's H1 still wins over the fallback", () => {
  const compiled = compileBundle(markdownBundle("# Heading\n\nBody."), "from-filename");
  assert.equal(compiled.title, "Heading");
});

test("a Markdown upload with no H1 still falls back", () => {
  const compiled = compileBundle(markdownBundle("just body text, no heading"), "from-filename");
  assert.equal(compiled.title, "from-filename");
});

test("compileBundle reads the same first 256 KiB of the entry that the document page does", () => {
  // The handler streams HEAD_SCAN_BYTES bytes; here the whole entry is in
  // memory, and only that prefix is decoded. The distinction shows in
  // multi-byte text: 140,000 two-byte characters are under the scanner's
  // character cap but over its byte cap, so a <title> after them is the
  // page's title only if bytes past the cap were decoded.
  const padding = `<!-- ${"é".repeat(140_000)} -->`;
  assert.ok(Buffer.byteLength(padding, "utf8") > HEAD_SCAN_BYTES, "padding must exceed the byte cap");
  assert.ok(padding.length < HEAD_SCAN_BYTES, "padding must stay under the character cap");
  const html = `<!DOCTYPE html><html><head>${padding}<title>Too Late</title></head><body></body></html>`;
  const compiled = compileBundle(htmlBundle(html), "from-filename");
  assert.equal(compiled.title, "from-filename");
});
