// SPDX-License-Identifier: Apache-2.0
// compileBundle's title default, and where a new document's bytes are placed (SPEC §4, §11, §17).

const test = require("node:test");
const assert = require("node:assert/strict");

const { compileBundle, placeNewDocument } = require("../lib/lib/publish.js");
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

// --- Placing a new document's bytes -----------------------------------------

/** Firestore reduced to "does docs/{id} exist". Nothing here holds a record. */
const noRecords = {
  collection: () => ({ doc: () => ({ get: async () => ({ exists: false }) }) }),
};

/** What Storage throws when a CREATE_ONLY write finds the object already there. */
const preconditionFailed = () => Object.assign(new Error("412 Precondition Failed"), { code: 412 });

test("a new document's bytes go under the wanted id's v1", async () => {
  const puts = [];
  const placed = await placeNewDocument(noRecords, "01-platform", async (prefix) => {
    puts.push(prefix);
  });
  assert.deepEqual(puts, ["docs/01-platform/v1"]);
  assert.deepEqual(placed, { docId: "01-platform", storagePrefix: "docs/01-platform/v1" });
});

test("a refused write moves the document to a suffixed id instead of failing", async () => {
  /**
   * Storage refuses when bytes already sit at the id although no record holds
   * it: a create racing this one, or what a failed create left. Either way the
   * id is taken, and the publisher still gets a document.
   */
  const puts = [];
  const placed = await placeNewDocument(noRecords, "01-platform", async (prefix) => {
    puts.push(prefix);
    if (puts.length === 1) throw preconditionFailed();
  });
  assert.equal(puts.length, 2);
  assert.equal(puts[0], "docs/01-platform/v1");
  assert.match(placed.docId, /^01-platform-[a-z0-9]{6}$/);
  assert.equal(placed.storagePrefix, `docs/${placed.docId}/v1`);
  assert.equal(puts[1], placed.storagePrefix);
});

test("any other storage failure is not mistaken for a taken id", async () => {
  let calls = 0;
  await assert.rejects(
    placeNewDocument(noRecords, "01-platform", async () => {
      calls++;
      throw Object.assign(new Error("quota"), { code: 429 });
    }),
    /quota/,
  );
  assert.equal(calls, 1);
});

test("a second refusal fails the publish rather than retrying forever", async () => {
  let calls = 0;
  await assert.rejects(
    placeNewDocument(noRecords, "01-platform", async () => {
      calls++;
      throw preconditionFailed();
    }),
    /412/,
  );
  assert.equal(calls, 2);
});
