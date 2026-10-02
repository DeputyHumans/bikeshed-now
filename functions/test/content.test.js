// SPDX-License-Identifier: Apache-2.0
// How a /content/ request names its document, version, file and link key (SPEC §2, §17).

const test = require("node:test");
const assert = require("node:assert/strict");

const { contentPath } = require("../lib/lib/http.js");

test("a plain request names the document, the version and the file", () => {
  assert.deepEqual(contentPath(["d1", "v2", "img", "a.png"]), {
    k: null,
    docId: "d1",
    versionId: "v2",
    relPath: "img/a.png",
  });
});

test("a request naming no file reads the entry's default", () => {
  assert.equal(contentPath(["d1", "v2"]).relPath, "index.html");
});

test("an unlisted document's key may ride in the path, ahead of the document", () => {
  // A key in the query string stops at the entry: the page's relative images
  // and stylesheets are requested without it, so a signed-out reader of an
  // unlisted link got the text and nothing else. In the path, every relative
  // reference inherits it.
  assert.deepEqual(contentPath(["~tok_123", "d1", "v2", "img", "a.png"]), {
    k: "tok_123",
    docId: "d1",
    versionId: "v2",
    relPath: "img/a.png",
  });
});

test("a key with nothing after it, or an empty key, names nothing", () => {
  assert.equal(contentPath(["~tok_123", "d1"]), null);
  assert.equal(contentPath(["~", "d1", "v2"]), null);
  assert.equal(contentPath(["d1"]), null);
});

test("a file whose name starts with a tilde is still a file", () => {
  // Only the FIRST segment can be a key: a document id never starts with one.
  const parts = contentPath(["d1", "v2", "~notes.png"]);
  assert.equal(parts.k, null);
  assert.equal(parts.relPath, "~notes.png");
});
