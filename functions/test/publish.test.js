// SPDX-License-Identifier: Apache-2.0
// compileBundle's title default: HTML's own <title>, else the caller's fallback; Markdown's H1 rule is unchanged (SPEC §11, §17).

const test = require("node:test");
const assert = require("node:assert/strict");

const { compileBundle } = require("../lib/lib/publish.js");

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
